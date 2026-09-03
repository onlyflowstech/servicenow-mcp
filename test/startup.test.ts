import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SHUTDOWN_GRACE_PERIOD_MS,
  createReadinessGate,
  installShutdownCoordinator,
  type GracefullyClosableHttpRuntime,
} from "../src/startup.js";

function deferred() {
  let resolve = (): void => {};
  let reject = (_reason?: unknown): void => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("HTTP-only shutdown coordination", () => {
  it("keeps the application readiness gate fail-closed until explicitly opened", () => {
    const gate = createReadinessGate();

    expect(gate.check()).toBe(false);
    gate.markReady();
    expect(gate.check()).toBe(true);
    gate.markNotReady();
    expect(gate.check()).toBe(false);
    expect(Object.isFrozen(gate)).toBe(true);
  });

  it("begins runtime draining synchronously on explicit shutdown", async () => {
    let draining = false;
    const runtime: GracefullyClosableHttpRuntime = {
      close: vi.fn(async () => {
        draining = true;
      }),
    };
    const coordinator = installShutdownCoordinator({
      runtime,
      signalSource: new EventEmitter(),
    });

    const closing = coordinator.requestShutdown("SIGTERM");
    expect(draining).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
    await closing;
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "passes the bounded grace period for %s and removes both handlers",
    async (signal) => {
      const signalSource = new EventEmitter();
      const runtime: GracefullyClosableHttpRuntime = {
        close: vi.fn(async () => {}),
      };
      const onComplete = vi.fn();
      installShutdownCoordinator({ runtime, signalSource, onComplete });

      signalSource.emit(signal);
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith(signal));

      expect(runtime.close).toHaveBeenCalledWith({
        gracePeriodMs: DEFAULT_SHUTDOWN_GRACE_PERIOD_MS,
      });
      expect(signalSource.listenerCount("SIGINT")).toBe(0);
      expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    }
  );

  it("coalesces repeated and mixed signals while a request is draining", async () => {
    const signalSource = new EventEmitter();
    const closeGate = deferred();
    const runtime: GracefullyClosableHttpRuntime = {
      close: vi.fn(() => closeGate.promise),
    };
    const onComplete = vi.fn();
    installShutdownCoordinator({
      runtime,
      signalSource,
      gracePeriodMs: 250,
      onComplete,
    });

    signalSource.emit("SIGTERM");
    signalSource.emit("SIGINT");
    signalSource.emit("SIGTERM");
    await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledOnce());
    expect(onComplete).not.toHaveBeenCalled();

    closeGate.resolve();
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledWith("SIGTERM"));
    expect(runtime.close).toHaveBeenCalledWith({ gracePeriodMs: 250 });
    expect(signalSource.eventNames()).toEqual([]);
  });

  it("reports a sanitized failure and still removes process handlers", async () => {
    const signalSource = new EventEmitter();
    const runtimeFailure = new Error("secret-bearing runtime detail");
    const runtime: GracefullyClosableHttpRuntime = {
      close: vi.fn(async () => {
        throw runtimeFailure;
      }),
    };
    const onError = vi.fn();
    const coordinator = installShutdownCoordinator({
      runtime,
      signalSource,
      onError,
    });

    await expect(coordinator.requestShutdown("SIGINT")).rejects.toThrow(
      "HTTP runtime shutdown failed"
    );
    expect(onError).toHaveBeenCalledWith("SIGINT");
    expect(signalSource.eventNames()).toEqual([]);
  });

  it("supports explicit disposal without closing the runtime", () => {
    const signalSource = new EventEmitter();
    const runtime: GracefullyClosableHttpRuntime = {
      close: vi.fn(async () => {}),
    };
    const coordinator = installShutdownCoordinator({ runtime, signalSource });

    coordinator.dispose();
    coordinator.dispose();
    signalSource.emit("SIGINT");
    signalSource.emit("SIGTERM");

    expect(runtime.close).not.toHaveBeenCalled();
    expect(signalSource.eventNames()).toEqual([]);
  });

  it.each([0, -1, 1.5, 300_001, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid shutdown bound %s without installing listeners",
    (gracePeriodMs) => {
      const signalSource = new EventEmitter();
      const runtime: GracefullyClosableHttpRuntime = {
        close: vi.fn(async () => {}),
      };

      expect(() =>
        installShutdownCoordinator({ runtime, signalSource, gracePeriodMs })
      ).toThrow("shutdown grace period must be an integer from 1 through 300000");
      expect(signalSource.eventNames()).toEqual([]);
    }
  );
});

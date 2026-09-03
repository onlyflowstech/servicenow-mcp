/** HTTP-only executable lifecycle composition. */

export const DEFAULT_SHUTDOWN_GRACE_PERIOD_MS = 10_000;

/** Explicit local dependency gate used by the HTTP readiness probe. */
export interface ReadinessGate {
  readonly check: () => boolean;
  markReady(): void;
  markNotReady(): void;
}

/** Create a fail-closed readiness gate; application startup opens it explicitly. */
export function createReadinessGate(): ReadinessGate {
  let ready = false;
  return Object.freeze({
    check: () => ready,
    markReady: () => {
      ready = true;
    },
    markNotReady: () => {
      ready = false;
    },
  });
}

export type ShutdownSignal = "SIGINT" | "SIGTERM";

/** Structural runtime boundary keeps process ownership out of the HTTP core. */
export interface GracefullyClosableHttpRuntime {
  close(options: { readonly gracePeriodMs: number }): Promise<void>;
}

export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownCoordinatorOptions {
  readonly runtime: GracefullyClosableHttpRuntime;
  readonly signalSource?: SignalSource;
  readonly gracePeriodMs?: number;
  readonly onComplete?: (signal: ShutdownSignal) => void;
  readonly onError?: (signal: ShutdownSignal) => void;
}

export interface ShutdownCoordinator {
  /** Idempotently begin the same bounded shutdown used by OS signals. */
  requestShutdown(signal: ShutdownSignal): Promise<void>;
  /** Remove signal listeners without closing the runtime. */
  dispose(): void;
}

/**
 * Install SIGINT/SIGTERM handlers for one HTTP runtime.
 *
 * The runtime owns the actual drain/force deadline. This coordinator ensures
 * both signals share one close operation and that process listeners never
 * survive completed shutdown or explicit disposal.
 */
export function installShutdownCoordinator(
  options: ShutdownCoordinatorOptions
): ShutdownCoordinator {
  const signalSource = options.signalSource ?? process;
  const gracePeriodMs = options.gracePeriodMs ?? DEFAULT_SHUTDOWN_GRACE_PERIOD_MS;
  if (
    !Number.isSafeInteger(gracePeriodMs) ||
    gracePeriodMs < 1 ||
    gracePeriodMs > 300_000
  ) {
    throw new TypeError(
      "shutdown grace period must be an integer from 1 through 300000"
    );
  }

  let disposed = false;
  let shutdownPromise: Promise<void> | undefined;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    signalSource.off("SIGINT", onSigint);
    signalSource.off("SIGTERM", onSigterm);
  };

  const requestShutdown = (signal: ShutdownSignal): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    let closing: Promise<void>;
    try {
      // Invoke synchronously so the runtime stops admission and readiness in
      // the same turn as the first signal or explicit shutdown request.
      closing = Promise.resolve(options.runtime.close({ gracePeriodMs }));
    } catch {
      closing = Promise.reject(new Error("HTTP runtime shutdown failed"));
    }
    shutdownPromise = closing
      .then(
        () => options.onComplete?.(signal),
        () => {
          options.onError?.(signal);
          throw new Error("HTTP runtime shutdown failed");
        }
      )
      .finally(dispose);
    return shutdownPromise;
  };

  const onSigint = (): void => {
    void requestShutdown("SIGINT").catch(() => {});
  };
  const onSigterm = (): void => {
    void requestShutdown("SIGTERM").catch(() => {});
  };

  signalSource.on("SIGINT", onSigint);
  signalSource.on("SIGTERM", onSigterm);

  return Object.freeze({ requestShutdown, dispose });
}

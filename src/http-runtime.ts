/**
 * Provider-neutral Node.js Streamable HTTP runtime.
 *
 * Statelessness is enforced by constructing a fresh MCP server and official
 * SDK transport for every accepted POST. Authentication happens before the
 * body is parsed or the injected server factory is called.
 *
 * @module http-runtime
 */

import { randomUUID } from "node:crypto";
import { createServer as createNodeHttpServer } from "node:http";
import type {
  IncomingMessage,
  Server as NodeHttpServer,
  ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import {
  MAX_CUMULATIVE_RAW_RESPONSE_BYTES,
  MAX_CUMULATIVE_UPSTREAM_JSON_BYTES,
} from "./client.js";
import {
  authenticateHttpRequest,
  correlationIdFromMcpRequest,
  createAuthenticatedRequestMetadataProvider,
  httpAuthenticationRequestFromRawHeaders,
  safeHttpAuthenticationFailure,
  type AuthenticatedOwnerClientIdentity,
  type HttpAuthenticationProvider,
  type HttpAuthenticationRequest,
} from "./http-auth.js";
import {
  createPreContextAuditRecord,
  type PreContextAuditRecord,
  type RequestMetadataProvider,
} from "./execution-context.js";
import {
  safeHttpRateLimitRejection,
  type HttpObservability,
  type HttpRateLimitDecision,
  type HttpRateLimiter,
  type HttpRequestObservation,
  type HttpRequestReason,
} from "./http-observability.js";
import {
  createHttpRequestPolicy,
  httpRequestPolicyLimits,
  inspectHttpRequest,
  type HttpRequestPolicy,
  type HttpRequestPolicyDecision,
  type HttpRequestPolicyLimits,
  type HttpRequestPolicyRejectionReason,
} from "./http-request-policy.js";
import {
  createHttpRequestSignalController,
  type HttpRequestAbortKind,
} from "./http-request-signal.js";

export const MCP_HTTP_PATH = "/mcp";
export const MCP_LIVENESS_PATH = "/health/live";
export const MCP_READINESS_PATH = "/health/ready";
export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 3000;
export const DEFAULT_HTTP_CLOSE_GRACE_PERIOD_MS = 10_000;
export const DEFAULT_MAX_CONCURRENT_MCP_REQUESTS = 2;
export const DEFAULT_MAX_HTTP_CONNECTIONS = 128;
export const MAX_HTTP_CONNECTIONS = 4_096;
export const MAX_REJECTED_BODY_DRAIN_BYTES = 16 * 1024;
export const REJECTED_BODY_DRAIN_TIMEOUT_MS = 100;
const MCP_SERVER_CLOSE_TIMEOUT_MS = 1_000;
const MAX_CONCURRENT_MCP_REQUESTS = 1_024;
/** Above the observed 22.4× heap / 54× RSS hostile JSON expansion. */
export const BODY_MEMORY_SAFETY_FACTOR = 64;
export const RAW_RESPONSE_MEMORY_SAFETY_FACTOR = 8;
export const MAX_ESTIMATED_CONCURRENT_BODY_MEMORY_BYTES = 512 * 1024 * 1024;
const REQUEST_CORRELATION_HEADER = "x-request-id";

/** Per-request identity bridge supplied to application composition. */
export interface AuthenticatedHttpRequestContext {
  readonly identity: AuthenticatedOwnerClientIdentity;
  readonly requestMetadataProvider: RequestMetadataProvider;
  readonly signal: AbortSignal;
  /** Marks that the registered callback emitted its authoritative audit. */
  readonly markToolAuditObserved: () => void;
}

export interface CreateHttpRuntimeOptions {
  readonly host?: string;
  readonly port?: number;
  readonly authenticationProvider: HttpAuthenticationProvider<HttpAuthenticationRequest>;
  /**
   * Synchronous, local dependency signal. Omission, exceptions, promises, and
   * every value other than literal true fail readiness closed.
   */
  readonly readinessCheck?: () => boolean;
  /** Optional singleton telemetry boundary shared across all HTTP requests. */
  readonly observability?: HttpObservability;
  /** Optional singleton dual-scope limiter shared across all HTTP requests. */
  readonly rateLimiter?: HttpRateLimiter;
  /** Injectable transport-only policy; defaults to strict loopback-safe rules. */
  readonly requestPolicy?: HttpRequestPolicy;
  /** Maximum admitted MCP POST requests; excess work is rejected, never queued. */
  readonly maxConcurrentRequests?: number;
  /** Maximum accepted TCP connections; excess sockets are dropped immediately. */
  readonly maxConnections?: number;
  /** Must construct and register a fresh, unconnected server for each call. */
  readonly createServer: (
    context: AuthenticatedHttpRequestContext
  ) => McpServer | Promise<McpServer>;
}

export interface HttpRuntimeAddress {
  readonly url: URL;
  readonly host: string;
  readonly port: number;
}

export interface HttpRuntimeCloseOptions {
  /** Time allowed for accepted requests to finish before sockets are forced. */
  readonly gracePeriodMs?: number;
}

export interface HttpRuntime {
  start(): Promise<HttpRuntimeAddress>;
  /** Current externally reported readiness, including lifecycle state. */
  isReady(): boolean;
  close(options?: HttpRuntimeCloseOptions): Promise<void>;
}

type RuntimeState = "new" | "starting" | "listening" | "closing" | "closed";

interface ActiveParserRequest {
  readonly correlationId: string;
  finish(statusCode: number, reason: HttpRequestReason): void;
}

const JSON_ERROR_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});
const LIVE_BODY = '{"status":"live"}\n';
const READY_BODY = '{"status":"ready"}\n';
const NOT_READY_BODY = '{"status":"not_ready"}\n';

/** Create an inert runtime. No socket is opened until `start()` resolves. */
export function createHttpRuntime(options: CreateHttpRuntimeOptions): HttpRuntime {
  return new StatelessHttpRuntime(options);
}

class StatelessHttpRuntime implements HttpRuntime {
  readonly #host: string;
  readonly #port: number;
  readonly #authenticationProvider: HttpAuthenticationProvider<HttpAuthenticationRequest>;
  readonly #readinessCheck: (() => boolean) | undefined;
  readonly #observability: HttpObservability | undefined;
  readonly #rateLimiter: HttpRateLimiter | undefined;
  readonly #requestPolicy: HttpRequestPolicy;
  readonly #requestPolicyLimits: HttpRequestPolicyLimits;
  readonly #maxConcurrentRequests: number;
  readonly #maxConnections: number;
  readonly #createMcpServer: CreateHttpRuntimeOptions["createServer"];
  readonly #sockets = new Set<Socket>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #activeMcpServers = new Set<McpServer>();
  readonly #activeRequestDeadlines = new Set<HttpRequestDeadline>();
  readonly #clientErrorSockets = new WeakSet<Duplex>();
  readonly #activeParserRequests = new WeakMap<Duplex, ActiveParserRequest>();
  #admittedRequestCount = 0;
  #state: RuntimeState = "new";
  #httpServer: NodeHttpServer | undefined;
  #startPromise: Promise<HttpRuntimeAddress> | undefined;
  #address: HttpRuntimeAddress | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(options: CreateHttpRuntimeOptions) {
    if (!options || typeof options !== "object") {
      throw new TypeError("HTTP runtime options must be an object");
    }
    if (
      !options.authenticationProvider ||
      typeof options.authenticationProvider.authenticate !== "function"
    ) {
      throw new TypeError("HTTP authentication provider must implement authenticate");
    }
    if (typeof options.createServer !== "function") {
      throw new TypeError("HTTP runtime createServer must be a function");
    }
    if (
      options.readinessCheck !== undefined &&
      typeof options.readinessCheck !== "function"
    ) {
      throw new TypeError("HTTP runtime readinessCheck must be a function");
    }
    if (
      options.observability !== undefined &&
      (typeof options.observability !== "object" ||
        typeof options.observability.beginRequest !== "function" ||
        typeof options.observability.beginTool !== "function")
    ) {
      throw new TypeError("HTTP runtime observability is invalid");
    }
    if (
      options.rateLimiter !== undefined &&
      (typeof options.rateLimiter !== "object" ||
        typeof options.rateLimiter.checkPreAuthentication !== "function" ||
        typeof options.rateLimiter.checkAuthenticated !== "function")
    ) {
      throw new TypeError("HTTP runtime rateLimiter is invalid");
    }

    this.#host = validateHost(options.host ?? DEFAULT_MCP_HTTP_HOST);
    this.#port = validatePort(options.port ?? DEFAULT_MCP_HTTP_PORT);
    this.#authenticationProvider = options.authenticationProvider;
    this.#readinessCheck = options.readinessCheck;
    this.#observability = options.observability;
    this.#rateLimiter = options.rateLimiter;
    this.#requestPolicy = options.requestPolicy ?? createHttpRequestPolicy();
    this.#requestPolicyLimits = httpRequestPolicyLimits(this.#requestPolicy);
    this.#maxConcurrentRequests = validateMaxConcurrentRequests(
      options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_MCP_REQUESTS
    );
    this.#maxConnections = validateMaxConnections(
      options.maxConnections ?? DEFAULT_MAX_HTTP_CONNECTIONS
    );
    if (
      this.#maxConcurrentRequests *
        ((this.#requestPolicyLimits.maxBodyBytes +
          MAX_CUMULATIVE_UPSTREAM_JSON_BYTES) *
          BODY_MEMORY_SAFETY_FACTOR +
          MAX_CUMULATIVE_RAW_RESPONSE_BYTES *
            RAW_RESPONSE_MEMORY_SAFETY_FACTOR) >
      MAX_ESTIMATED_CONCURRENT_BODY_MEMORY_BYTES
    ) {
      throw new TypeError(
        "HTTP maxConcurrentRequests and maxBodyBytes exceed the estimated body-memory ceiling"
      );
    }
    this.#createMcpServer = options.createServer;
  }

  start(): Promise<HttpRuntimeAddress> {
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error("HTTP runtime cannot restart after close"));
    }
    if (this.#address) return Promise.resolve(this.#address);
    if (this.#startPromise) return this.#startPromise;

    this.#state = "starting";
    const httpServer = createNodeHttpServer(
      {
        headersTimeout: this.#requestPolicyLimits.headersTimeoutMs,
        requestTimeout: this.#requestPolicyLimits.requestTimeoutMs,
        keepAliveTimeout: this.#requestPolicyLimits.keepAliveTimeoutMs,
        connectionsCheckingInterval: Math.min(
          1_000,
          this.#requestPolicyLimits.headersTimeoutMs,
          this.#requestPolicyLimits.requestTimeoutMs
        ),
      },
      (request, response) => {
      const operation = this.#handleNodeRequest(request, response);
      this.#inFlight.add(operation);
      void operation.then(
        () => this.#inFlight.delete(operation),
        () => this.#inFlight.delete(operation)
      );
      }
    );
    httpServer.maxHeadersCount = 100;
    httpServer.maxConnections = this.#maxConnections;
    // Node 22+ uses this flag when a server participates in a cluster. Older
    // supported runtimes safely ignore the own property, while the explicit
    // connection listener below preserves the same fail-closed behavior.
    (httpServer as NodeHttpServer & { dropMaxConnection?: boolean }).dropMaxConnection =
      true;
    this.#httpServer = httpServer;
    httpServer.on("clientError", (error, socket) => {
      this.#handleClientError(error, socket);
    });
    httpServer.on("connection", (socket) => {
      if (this.#sockets.size >= this.#maxConnections) {
        socket.destroy();
        return;
      }
      this.#sockets.add(socket);
      socket.once("close", () => {
        this.#sockets.delete(socket);
        this.#activeParserRequests.delete(socket);
      });
    });

    this.#startPromise = new Promise<HttpRuntimeAddress>((resolve, reject) => {
      const onStartupError = (error: Error) => {
        this.#state = "closed";
        reject(error);
      };
      httpServer.once("error", onStartupError);
      httpServer.listen(this.#port, this.#host, () => {
        httpServer.off("error", onStartupError);
        const address = httpServer.address();
        if (!address || typeof address === "string") {
          this.#state = "closed";
          void closeNodeServer(httpServer);
          reject(new Error("HTTP runtime did not receive a TCP listen address"));
          return;
        }

        const host = address.address;
        const port = address.port;
        const urlHost = host.includes(":") ? `[${host}]` : host;
        this.#address = Object.freeze({
          url: new URL(`http://${urlHost}:${port}${MCP_HTTP_PATH}`),
          host,
          port,
        });
        // A concurrent close may already own the state. Resolving start lets
        // that close proceed to stop the newly opened listener, while request
        // admission remains disabled throughout the race.
        if (this.#state === "starting") this.#state = "listening";
        resolve(this.#address);
      });
    });
    return this.#startPromise;
  }

  isReady(): boolean {
    if (this.#state !== "listening" || !this.#readinessCheck) return false;
    try {
      const dependencyReady = this.#readinessCheck() === true;
      return dependencyReady && this.#state === "listening";
    } catch {
      return false;
    }
  }

  close(options: HttpRuntimeCloseOptions = {}): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    const gracePeriodMs = validateGracePeriod(
      options.gracePeriodMs ?? DEFAULT_HTTP_CLOSE_GRACE_PERIOD_MS
    );

    this.#state = "closing";
    this.#closePromise = this.#closeWithin(gracePeriodMs).finally(() => {
      this.#state = "closed";
      this.#address = undefined;
    });
    return this.#closePromise;
  }

  async #closeWithin(gracePeriodMs: number): Promise<void> {
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch {
        return;
      }
    }

    const httpServer = this.#httpServer;
    if (!httpServer) return;

    const listenerClosed = closeNodeServer(httpServer);
    httpServer.closeIdleConnections?.();
    const requestsDrained = this.#drainAcceptedRequests().then(() => {
      // On Node 18, a connection that becomes idle after server.close() may
      // otherwise remain open until its keep-alive timeout.
      httpServer.closeIdleConnections?.();
    });
    const graceful = Promise.all([listenerClosed, requestsDrained]).then(() => undefined);

    if (gracePeriodMs === 0) {
      this.#forceClose(httpServer);
      void listenerClosed.catch(() => {});
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), gracePeriodMs);
      timer.unref?.();
    });
    const outcome = await Promise.race([
      graceful.then(() => "graceful" as const),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "deadline" || this.#activeMcpServers.size > 0) {
      this.#forceClose(httpServer);
    }
  }

  async #drainAcceptedRequests(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  #forceClose(httpServer: NodeHttpServer): void {
    for (const deadline of this.#activeRequestDeadlines) {
      deadline.cancel("shutdown");
    }
    for (const mcpServer of this.#activeMcpServers) {
      try {
        void Promise.resolve(mcpServer.close()).catch(() => {});
      } catch {
        // A hostile or overridden close must not prevent socket destruction.
      }
    }
    httpServer.closeAllConnections?.();
    for (const socket of this.#sockets) socket.destroy();

    // A provider, application factory, tool handler, or SDK cleanup hook may
    // ignore connection closure and never settle. Once the bounded deadline
    // expires the closed runtime must not keep those request graphs alive.
    this.#activeMcpServers.clear();
    this.#inFlight.clear();
    this.#sockets.clear();
  }

  #admitMcpRequest(): (() => void) | undefined {
    if (this.#admittedRequestCount >= this.#maxConcurrentRequests) return undefined;
    this.#admittedRequestCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#admittedRequestCount = Math.max(0, this.#admittedRequestCount - 1);
    };
  }

  #handleClientError(error: Error, socket: Duplex): void {
    if (this.#clientErrorSockets.has(socket)) {
      socket.destroy();
      return;
    }
    this.#clientErrorSockets.add(socket);
    const code = safeClientErrorCode(error);
    const status =
      code === "ERR_HTTP_REQUEST_TIMEOUT"
        ? 408
        : code === "HPE_HEADER_OVERFLOW"
          ? 431
          : 400;
    const reason: HttpRequestReason =
      status === 408
        ? "request_timeout"
        : status === 400
          ? "malformed_request"
          : "invalid_protocol";
    const message = status === 408 ? "Request timeout." : "Invalid request.";
    const body = `${JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32600, message },
      id: null,
    })}\n`;
    const activeRequest = this.#activeParserRequests.get(socket);
    const correlationId = activeRequest?.correlationId ?? randomUUID();
    if (activeRequest) {
      this.#activeParserRequests.delete(socket);
      activeRequest.finish(status, reason);
    } else {
      const observation = beginRequestObservation(this.#observability);
      if (observation) {
        try {
          suppressUnexpectedThenable(
            observation.finish({
              correlationId,
              outcome: "rejected",
              reason,
              statusCode: status,
            })
          );
        } catch {
          // Parser-boundary telemetry is optional and cannot affect the socket.
        }
      }
    }
    if (socket.destroyed || !socket.writable) return;
    const statusText =
      status === 408
        ? "Request Timeout"
        : status === 431
          ? "Request Header Fields Too Large"
          : "Bad Request";
    try {
      socket.end(
        `HTTP/1.1 ${status} ${statusText}\r\n` +
          "Connection: close\r\n" +
          "Cache-Control: no-store\r\n" +
          "Content-Type: application/json; charset=utf-8\r\n" +
          `${REQUEST_CORRELATION_HEADER}: ${correlationId}\r\n` +
          `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n` +
          body
      );
    } catch {
      socket.destroy();
    }
  }

  #closeLateFactoryServer(candidate: unknown): void {
    if (!(candidate instanceof McpServer) || candidate.isConnected()) return;
    this.#activeMcpServers.add(candidate);
    const closing = closeMcpServer(candidate);
    void settleWithin(
      closing,
      Math.min(
        MCP_SERVER_CLOSE_TIMEOUT_MS,
        this.#requestPolicyLimits.requestDeadlineMs
      )
    ).then((closed) => {
      if (closed === true) {
        this.#activeMcpServers.delete(candidate);
      } else if (
        closed === false &&
        (this.#state === "closing" || this.#state === "closed")
      ) {
        // The normal shutdown sweep may already have passed while the factory
        // was resolving. Retry once now that shutdown owns all remaining work.
        void closeMcpServer(candidate).then((retried) => {
          if (retried) this.#activeMcpServers.delete(candidate);
        });
      } else if (closed === "deadline") {
        void closing.then((eventuallyClosed) => {
          if (eventuallyClosed) this.#activeMcpServers.delete(candidate);
        });
      }
    });
  }

  async #handleNodeRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const requestCorrelationId = randomUUID();
    const requestObservation = beginRequestObservation(this.#observability);
    const observationState: {
      identity: AuthenticatedOwnerClientIdentity | undefined;
    } = { identity: undefined };
    let observedReason: HttpRequestReason | null = null;
    let activeRequestDeadline: HttpRequestDeadline | undefined;
    let expectsToolAudit = false;
    let toolAuditObserved = false;
    let observationFinished = false;
    let parserErrorHandled = false;
    const finishObservation = (
      connectionClosedEarly: boolean,
      explicitStatusCode?: number
    ): void => {
      if (observationFinished || !requestObservation) return;
      observationFinished = true;
      const statusCode =
        explicitStatusCode ??
        (connectionClosedEarly
          ? observedReason === "client_disconnected"
            ? 499
            : observedReason === "request_timeout"
              ? 408
              : observedReason === "service_unavailable"
                ? 503
                : 500
          : response.statusCode);
      const completion =
        statusCode < 400 && expectsToolAudit && !toolAuditObserved
          ? {
              outcome: "rejected" as const,
              reason: "tool_input_rejected" as const,
              statusCode,
            }
          : classifyHttpCompletion(statusCode, observedReason);
      try {
        suppressUnexpectedThenable(
          requestObservation.finish({
            correlationId: requestCorrelationId,
            ...(observationState.identity === undefined
              ? {}
              : { identity: observationState.identity }),
            ...completion,
          })
        );
      } catch {
        // Optional telemetry cannot affect HTTP completion or process safety.
      }
    };
    const activeParserRequest: ActiveParserRequest = Object.freeze({
      correlationId: requestCorrelationId,
      finish: (statusCode: number, reason: HttpRequestReason): void => {
        parserErrorHandled = true;
        observedReason = reason;
        finishObservation(true, statusCode);
      },
    });
    this.#activeParserRequests.set(request.socket, activeParserRequest);
    const clearActiveParserRequest = (): void => {
      if (this.#activeParserRequests.get(request.socket) === activeParserRequest) {
        this.#activeParserRequests.delete(request.socket);
      }
    };
    response.setHeader(REQUEST_CORRELATION_HEADER, requestCorrelationId);
    const handleClientDisconnect = (): void => {
      if (response.writableFinished || observationFinished) return;
      const abortError = activeRequestDeadline?.abortError;
      if (abortError instanceof HttpRequestDeadlineError) {
        observedReason = "request_timeout";
      } else if (abortError instanceof HttpRequestCancellationError) {
        observedReason = cancellationObservationReason(abortError);
      } else {
        observedReason = "client_disconnected";
        activeRequestDeadline?.cancel("client_disconnected");
      }
      finishObservation(true);
    };
    response.once("finish", () => {
      clearActiveParserRequest();
      finishObservation(false);
      disposeUnreadRequestBody(request);
    });
    response.once("close", () => {
      handleClientDisconnect();
    });
    request.once("aborted", () => {
      handleClientDisconnect();
    });

    const pathname = requestPath(request.url);
    // Host and Origin are transport authority, so reject them before routing,
    // authentication, body parsing, or any application dependency. Passing an
    // undefined method deliberately defers MCP content checks until after the
    // established authentication/rate-limit boundary.
    const authorityDecision = inspectHttpRequest(this.#requestPolicy, {
      rawHeaders: request.rawHeaders,
      method: undefined,
      pathname,
      configuredHost: this.#host,
      localAddress: request.socket.localAddress,
      localPort: request.socket.localPort,
      remoteAddress: request.socket.remoteAddress,
    });
    applyPolicyResponseHeaders(response, authorityDecision.responseHeaders);
    if (authorityDecision.kind === "reject") {
      observedReason = policyObservationReason(authorityDecision.reason);
      writePolicyRejection(response, authorityDecision);
      return;
    }

    if (pathname === MCP_LIVENESS_PATH) {
      if (!isHealthMethod(request.method)) {
        observedReason = "method_not_allowed";
        writeHealthMethodNotAllowed(response);
        return;
      }
      writeHealthResponse(request, response, 200, LIVE_BODY);
      return;
    }
    if (pathname === MCP_READINESS_PATH) {
      if (!isHealthMethod(request.method)) {
        observedReason = "method_not_allowed";
        writeHealthMethodNotAllowed(response);
        return;
      }
      const ready = this.isReady();
      if (!ready) observedReason = "service_unavailable";
      writeHealthResponse(
        request,
        response,
        ready ? 200 : 503,
        ready ? READY_BODY : NOT_READY_BODY
      );
      return;
    }

    // Health probes describe process/runtime lifecycle and must not be
    // starved by an MCP client's shared source bucket (for example behind a
    // reverse proxy). Every non-health route remains source-limited before
    // authentication or server construction.
    if (this.#rateLimiter) {
      let preAuthentication: HttpRateLimitDecision;
      try {
        preAuthentication = this.#rateLimiter.checkPreAuthentication(
          request.socket.remoteAddress ?? "unknown"
        );
        if (preAuthentication.allowed) {
          // Continue into the cheap route/authentication boundary.
        } else {
          observedReason = "pre_auth_rate_limited";
          writeRateLimitRejection(response, preAuthentication);
          return;
        }
      } catch {
        observedReason = "pre_auth_rate_limited";
        writeRateLimitRejection(response, {} as HttpRateLimitDecision);
        return;
      }
    }

    if (this.#state !== "listening") {
      observedReason = "service_unavailable";
      writeJsonRpcError(response, 503, -32000, "Service unavailable.");
      return;
    }

    if (pathname !== MCP_HTTP_PATH) {
      observedReason = "not_found";
      writeJsonRpcError(response, 404, -32000, "Not found.");
      return;
    }

    if (request.method === "OPTIONS") {
      const preflight = inspectHttpRequest(this.#requestPolicy, {
        rawHeaders: request.rawHeaders,
        method: request.method,
        pathname,
        configuredHost: this.#host,
        localAddress: request.socket.localAddress,
        localPort: request.socket.localPort,
        remoteAddress: request.socket.remoteAddress,
      });
      applyPolicyResponseHeaders(response, preflight.responseHeaders);
      if (preflight.kind === "preflight") {
        writeEmptyResponse(response, preflight.status, preflight.responseHeaders);
      } else if (preflight.kind === "reject") {
        observedReason = policyObservationReason(preflight.reason);
        writePolicyRejection(response, preflight);
      } else {
        observedReason = "method_not_allowed";
        writeJsonRpcError(response, 405, -32000, "Method not allowed.", {
          allow: "POST",
        });
      }
      return;
    }

    if (request.method !== "POST") {
      observedReason = "method_not_allowed";
      writeJsonRpcError(response, 405, -32000, "Method not allowed.", {
        allow: "POST",
      });
      return;
    }

    const releaseAdmission = this.#admitMcpRequest();
    if (!releaseAdmission) {
      observedReason = "concurrency_limited";
      writeConcurrencyRejection(request, response);
      return;
    }
    const requestDeadline = new HttpRequestDeadline(
      this.#requestPolicyLimits.requestDeadlineMs
    );
    activeRequestDeadline = requestDeadline;
    this.#activeRequestDeadlines.add(requestDeadline);

    try {
      let identity: AuthenticatedOwnerClientIdentity;
    try {
      const authenticationRequest = httpAuthenticationRequestFromRawHeaders(
        request.rawHeaders
      );
      identity = await requestDeadline.run(
        authenticateHttpRequest(
          this.#authenticationProvider,
          authenticationRequest,
          requestDeadline.signal
        )
      );
    } catch (error) {
      if (error instanceof HttpRequestDeadlineError) {
        observedReason = "request_timeout";
        writeRequestTimeout(request, response);
        return;
      }
      if (error instanceof HttpRequestCancellationError) return;
      const failure = safeHttpAuthenticationFailure(error);
      observedReason = failure.status === 403 ? "forbidden" : "unauthorized";
      writeResponse(response, failure.status, failure.headers, failure.body);
      return;
    }
    observationState.identity = identity;

    if (this.#rateLimiter) {
      try {
        const authenticated = this.#rateLimiter.checkAuthenticated(identity);
        if (!authenticated.allowed) {
          observedReason = "identity_rate_limited";
          writeRateLimitRejection(response, authenticated);
          return;
        }
      } catch {
        observedReason = "identity_rate_limited";
        writeRateLimitRejection(response, {} as HttpRateLimitDecision);
        return;
      }
    }

    const contentDecision = inspectHttpRequest(this.#requestPolicy, {
      rawHeaders: request.rawHeaders,
      method: request.method,
      pathname,
      configuredHost: this.#host,
      localAddress: request.socket.localAddress,
      localPort: request.socket.localPort,
      remoteAddress: request.socket.remoteAddress,
    });
    applyPolicyResponseHeaders(response, contentDecision.responseHeaders);
    if (contentDecision.kind === "reject") {
      observedReason = policyObservationReason(contentDecision.reason);
      writePolicyRejection(response, contentDecision);
      return;
    }
    if (contentDecision.kind !== "allow") {
      observedReason = "invalid_protocol";
      writeJsonRpcError(response, 400, -32600, "Invalid request.");
      return;
    }

    if (this.#state !== "listening" || request.aborted || response.destroyed) {
      observedReason = "service_unavailable";
      writeJsonRpcError(response, 503, -32000, "Service unavailable.");
      return;
    }

    if (!hasSupportedProtocolHeader(request)) {
      observedReason = "invalid_protocol";
      writeJsonRpcError(response, 400, -32600, "Unsupported MCP protocol version.");
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await requestDeadline.run(
        readBoundedJsonBody(
          request,
          this.#requestPolicyLimits.maxBodyBytes,
          this.#requestPolicyLimits.bodyReadTimeoutMs
        )
      );
    } catch (error) {
      if (parserErrorHandled) return;
      if (error instanceof HttpBodyReadError && error.kind === "too_large") {
        observedReason = "request_too_large";
        writeJsonRpcError(response, 413, -32600, "Request body is too large.");
      } else if (
        error instanceof HttpRequestDeadlineError ||
        (error instanceof HttpBodyReadError && error.kind === "timeout")
      ) {
        observedReason = "request_timeout";
        writeRequestTimeout(request, response);
      } else if (error instanceof HttpRequestCancellationError) {
        observedReason = cancellationObservationReason(error);
      } else if (
        error instanceof HttpBodyReadError &&
        error.kind === "aborted"
      ) {
        observedReason = request.aborted
          ? "client_disconnected"
          : "malformed_request";
        if (!response.destroyed) {
          writeJsonRpcError(response, 400, -32700, "Malformed JSON request.");
        }
      } else {
        observedReason = "malformed_request";
        writeJsonRpcError(response, 400, -32700, "Malformed JSON request.");
      }
      return;
    }
    if (Array.isArray(parsedBody)) {
      observedReason = "invalid_protocol";
      writeJsonRpcError(response, 400, -32600, "JSON-RPC batches are not supported.");
      return;
    }

    const fallbackTool = createFallbackToolObservation(
      this.#observability,
      parsedBody,
      identity,
      requestCorrelationId
    );
    expectsToolAudit = fallbackTool !== undefined;
    const context: AuthenticatedHttpRequestContext = Object.freeze({
      identity,
      signal: requestDeadline.signal,
      requestMetadataProvider: createAuthenticatedRequestMetadataProvider(
        identity,
        createHttpCorrelationIdFactory(requestCorrelationId)
      ),
      markToolAuditObserved: () => {
        toolAuditObserved = true;
      },
    });
    let ownedMcpServer: McpServer | undefined;
    let factoryState: "pending" | "accepted" | "abandoned" = "pending";
    let earlyFactoryResult: unknown;
    const factoryResult = Promise.resolve().then(() => this.#createMcpServer(context));
    void factoryResult.then(
      (candidate) => {
        if (factoryState === "abandoned") {
          this.#closeLateFactoryServer(candidate);
        } else if (factoryState === "pending") {
          earlyFactoryResult = candidate;
        }
      },
      () => {
        // requestDeadline.run observes an in-time rejection. A rejection that
        // arrives after cancellation is intentionally consumed here.
      }
    );
    try {
      const candidate = await requestDeadline.run(factoryResult);
      factoryState = "accepted";
      earlyFactoryResult = undefined;
      if (!(candidate instanceof McpServer)) {
        throw new TypeError("HTTP server factory must return an McpServer");
      }
      if (candidate.isConnected()) {
        throw new TypeError("HTTP server factory must return an unconnected McpServer");
      }

      // Ownership transfers only after the candidate passes both checks. An
      // invalid return or caller-owned connected server is never closed here.
      ownedMcpServer = candidate;
      if (this.#state !== "listening" || request.aborted || response.destroyed) {
        observedReason = "service_unavailable";
        writeJsonRpcError(response, 503, -32000, "Service unavailable.");
        return;
      }

      this.#activeMcpServers.add(ownedMcpServer);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await requestDeadline.run(ownedMcpServer.connect(transport));
      await requestDeadline.run(
        transport.handleRequest(request, response, parsedBody)
      );
    } catch (error) {
      if (error instanceof HttpRequestDeadlineError) {
        factoryState = "abandoned";
        if (earlyFactoryResult !== undefined) {
          this.#closeLateFactoryServer(earlyFactoryResult);
          earlyFactoryResult = undefined;
        }
        observedReason = "request_timeout";
        if (!response.headersSent && !response.destroyed) {
          writeRequestTimeout(request, response);
        } else if (!response.writableEnded) {
          response.destroy();
        }
      } else if (error instanceof HttpRequestCancellationError) {
        factoryState = "abandoned";
        if (earlyFactoryResult !== undefined) {
          this.#closeLateFactoryServer(earlyFactoryResult);
          earlyFactoryResult = undefined;
        }
        observedReason = cancellationObservationReason(error);
      } else if (!response.headersSent && !response.destroyed) {
        observedReason = "internal_error";
        writeJsonRpcError(response, 500, -32603, "Internal server error.");
      } else if (!response.writableEnded) {
        observedReason = "internal_error";
        response.destroy();
      }
    } finally {
      if (ownedMcpServer) {
        const serverToClose = ownedMcpServer;
        const closing = closeMcpServer(serverToClose);
        const closed = await settleWithin(
          closing,
          Math.min(
            MCP_SERVER_CLOSE_TIMEOUT_MS,
            this.#requestPolicyLimits.requestDeadlineMs
          )
        );
        if (closed === true) {
          this.#activeMcpServers.delete(serverToClose);
        } else if (closed === "deadline") {
          // Keep timed-out resources owned by the runtime so a later forced
          // runtime close can retry them. Remove them if the original close
          // eventually succeeds in the meantime.
          void closing.then((eventuallyClosed) => {
            if (eventuallyClosed) this.#activeMcpServers.delete(serverToClose);
          });
        }
      }
      if (
        fallbackTool &&
        !toolAuditObserved &&
        response.statusCode < 400
      ) {
        try {
          suppressUnexpectedThenable(
            fallbackTool.observation.finish(fallbackTool.record)
          );
        } catch {
          // Pre-validation observability is isolated from protocol behavior.
        }
      }
    }
    } finally {
      activeRequestDeadline = undefined;
      this.#activeRequestDeadlines.delete(requestDeadline);
      requestDeadline.dispose();
      releaseAdmission();
    }
  }
}

function createFallbackToolObservation(
  observability: HttpObservability | undefined,
  parsedBody: unknown,
  identity: AuthenticatedOwnerClientIdentity,
  requestSeed: string
):
  | {
      readonly observation: ReturnType<HttpObservability["beginTool"]>;
      readonly record: PreContextAuditRecord;
    }
  | undefined {
  if (!observability || typeof parsedBody !== "object" || parsedBody === null) {
    return undefined;
  }
  try {
    const body = parsedBody as Record<string, unknown>;
    const params = body.params;
    if (
      body.method !== "tools/call" ||
      (typeof body.id !== "string" && typeof body.id !== "number") ||
      typeof params !== "object" ||
      params === null
    ) {
      return undefined;
    }
    const tool = Reflect.get(params, "name");
    if (typeof tool !== "string" || !/^sn_[a-z0-9_]{1,61}$/u.test(tool)) {
      return undefined;
    }
    const correlationId = createHttpCorrelationIdFactory(requestSeed)({
      tool,
      requestId: body.id,
    });
    const observation = observability.beginTool();
    if (!observation || typeof observation.finish !== "function") return undefined;
    const record = createPreContextAuditRecord({
      tool,
      request: { correlationId, identity },
      reason: "input_validation_failed",
    });
    return Object.freeze({ observation, record });
  } catch {
    return undefined;
  }
}

class HttpBodyReadError extends Error {
  constructor(readonly kind: "malformed" | "too_large" | "timeout" | "aborted") {
    super("HTTP request body rejected");
    this.name = "HttpBodyReadError";
  }
}

class HttpRequestDeadlineError extends Error {
  constructor() {
    super("HTTP request deadline exceeded");
    this.name = "HttpRequestDeadlineError";
  }
}

type HttpRequestCancellationKind = "client_disconnected" | "shutdown";

class HttpRequestCancellationError extends Error {
  constructor(readonly kind: HttpRequestCancellationKind) {
    super("HTTP request cancelled");
    this.name = "HttpRequestCancellationError";
  }
}

const REQUEST_ABORTED = Symbol("http-request-aborted");

interface HttpRequestAbortOutcome {
  readonly marker: typeof REQUEST_ABORTED;
  readonly error: HttpRequestDeadlineError | HttpRequestCancellationError;
}

/** One bounded deadline shared by every asynchronous stage of an MCP POST. */
class HttpRequestDeadline {
  readonly #controller = createHttpRequestSignalController();
  readonly #expiration: Promise<HttpRequestAbortOutcome>;
  #resolveExpiration: ((outcome: HttpRequestAbortOutcome) => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #error: HttpRequestDeadlineError | HttpRequestCancellationError | undefined;
  #disposed = false;

  constructor(timeoutMs: number) {
    this.#expiration = new Promise((resolve) => {
      this.#resolveExpiration = resolve;
      this.#timer = setTimeout(() => {
        this.#abort(new HttpRequestDeadlineError(), "deadline");
      }, timeoutMs);
      this.#timer.unref?.();
    });
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get abortError():
    | HttpRequestDeadlineError
    | HttpRequestCancellationError
    | undefined {
    return this.#error;
  }

  cancel(kind: HttpRequestCancellationKind): void {
    this.#abort(new HttpRequestCancellationError(kind), kind);
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    if (this.#error) throw this.#error;
    if (this.#disposed) throw new HttpRequestDeadlineError();
    const outcome = await Promise.race([operation, this.#expiration]);
    if (
      typeof outcome === "object" &&
      outcome !== null &&
      Reflect.get(outcome, "marker") === REQUEST_ABORTED
    ) {
      throw (outcome as HttpRequestAbortOutcome).error;
    }
    return outcome as T;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#resolveExpiration = undefined;
  }

  #abort(
    error: HttpRequestDeadlineError | HttpRequestCancellationError,
    kind: HttpRequestAbortKind
  ): void {
    if (this.#error || this.#disposed) return;
    this.#error = error;
    if (this.#timer) clearTimeout(this.#timer);
    this.#controller.abort(kind, error);
    this.#resolveExpiration?.(Object.freeze({ marker: REQUEST_ABORTED, error }));
    this.#resolveExpiration = undefined;
  }
}

function hasSupportedProtocolHeader(request: IncomingMessage): boolean {
  const candidate = request.headers["mcp-protocol-version"];
  if (candidate === undefined) return true;
  return (
    typeof candidate === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(candidate)
  );
}

async function readBoundedJsonBody(
  request: IncomingMessage,
  maximumBytes: number,
  timeoutMs: number
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HttpBodyReadError("timeout")), timeoutMs);
    timer.unref?.();
  });

  const consume = async (): Promise<unknown> => {
    return new Promise<unknown>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      const cleanup = (): void => {
        request.off("data", onData);
        request.off("end", onEnd);
        request.off("aborted", onAborted);
        request.off("error", onError);
      };
      const rejectOnce = (error: HttpBodyReadError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onData = (candidate: Buffer | Uint8Array): void => {
        if (settled) return;
        const chunk = Buffer.isBuffer(candidate)
          ? candidate
          : Buffer.from(candidate);
        total += chunk.length;
        if (total > maximumBytes) {
          rejectOnce(new HttpBodyReadError("too_large"));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          resolve(JSON.parse(Buffer.concat(chunks, total).toString("utf8")));
        } catch {
          reject(new HttpBodyReadError("malformed"));
        }
      };
      const onAborted = (): void => rejectOnce(new HttpBodyReadError("aborted"));
      const onError = (): void =>
        rejectOnce(
          new HttpBodyReadError(request.aborted ? "aborted" : "malformed")
        );

      request.on("data", onData);
      request.once("end", onEnd);
      request.once("aborted", onAborted);
      request.once("error", onError);
    });
  };

  try {
    return await Promise.race([consume(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function beginRequestObservation(
  observability: HttpObservability | undefined
): HttpRequestObservation | undefined {
  if (!observability) return undefined;
  try {
    const observation = observability.beginRequest();
    return observation && typeof observation.finish === "function"
      ? observation
      : undefined;
  } catch {
    return undefined;
  }
}

function safeClientErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const candidate = Reflect.get(error, "code");
    return typeof candidate === "string" && candidate.length <= 64
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function suppressUnexpectedThenable(value: unknown): void {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof Reflect.get(value, "then") === "function"
  ) {
    void Promise.resolve(value).catch(() => {});
  }
}

function classifyHttpCompletion(
  statusCode: number,
  explicitReason: HttpRequestReason | null
): {
  readonly outcome: "success" | "rejected" | "error";
  readonly reason: HttpRequestReason | null;
  readonly statusCode: number;
} {
  if (statusCode < 400) {
    return { outcome: "success", reason: null, statusCode };
  }
  const reason = explicitReason ?? reasonFromHttpStatus(statusCode);
  return {
    outcome: statusCode >= 500 && reason === "internal_error" ? "error" : "rejected",
    reason,
    statusCode,
  };
}

function reasonFromHttpStatus(statusCode: number): HttpRequestReason {
  switch (statusCode) {
    case 400:
      return "malformed_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 408:
      return "request_timeout";
    case 413:
      return "request_too_large";
    case 415:
      return "invalid_content_type";
    case 429:
      return "pre_auth_rate_limited";
    case 503:
      return "service_unavailable";
    default:
      return statusCode >= 500 ? "internal_error" : "invalid_protocol";
  }
}

/** Keep MCP request linkage while namespacing it to one authenticated HTTP request. */
function createHttpCorrelationIdFactory(
  requestSeed: string
): NonNullable<Parameters<typeof createAuthenticatedRequestMetadataProvider>[1]> {
  return (invocation) =>
    `${correlationIdFromMcpRequest(invocation)}-${requestSeed}`;
}

function requestPath(rawUrl: string | undefined): string | undefined {
  if (typeof rawUrl !== "string") return undefined;
  try {
    return new URL(rawUrl, "http://mcp.invalid").pathname;
  } catch {
    return undefined;
  }
}

function writeHealthResponse(
  request: IncomingMessage,
  response: ServerResponse,
  status: 200 | 503,
  body: string
): void {
  writeResponse(response, status, JSON_ERROR_HEADERS, body, request.method === "HEAD");
}

function isHealthMethod(method: string | undefined): method is "GET" | "HEAD" {
  return method === "GET" || method === "HEAD";
}

function writeHealthMethodNotAllowed(response: ServerResponse): void {
  writeJsonRpcError(response, 405, -32000, "Method not allowed.", {
    allow: "GET, HEAD",
  });
}

function writeRateLimitRejection(
  response: ServerResponse,
  decision: HttpRateLimitDecision
): void {
  const rejection = safeHttpRateLimitRejection(decision);
  writeResponse(response, rejection.status, rejection.headers, rejection.body);
}

function applyPolicyResponseHeaders(
  response: ServerResponse,
  headers: Readonly<Record<string, string>>
): void {
  if (response.headersSent || response.destroyed) return;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === REQUEST_CORRELATION_HEADER) continue;
    response.setHeader(name, value);
  }
}

function policyObservationReason(
  reason: HttpRequestPolicyRejectionReason
): HttpRequestReason {
  switch (reason) {
    case "disallowed_origin":
    case "invalid_preflight":
      return "forbidden";
    case "invalid_content_type":
      return "invalid_content_type";
    case "request_too_large":
      return "request_too_large";
    case "invalid_host":
    case "disallowed_host":
    case "invalid_origin":
      return "invalid_protocol";
  }
}

function cancellationObservationReason(
  error: HttpRequestCancellationError
): HttpRequestReason {
  return error.kind === "shutdown" ? "service_unavailable" : "client_disconnected";
}

function writePolicyRejection(
  response: ServerResponse,
  decision: Extract<HttpRequestPolicyDecision, { readonly kind: "reject" }>
): void {
  const [code, message] =
    decision.status === 403
      ? [-32000, "Forbidden."]
      : decision.status === 413
        ? [-32600, "Request body is too large."]
        : decision.status === 415
          ? [-32000, "Unsupported media type."]
          : decision.status === 421
            ? [-32600, "Misdirected request."]
            : [-32600, "Invalid request."];
  writeJsonRpcError(
    response,
    decision.status,
    code,
    message,
    decision.responseHeaders
  );
}

function writeEmptyResponse(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>>
): void {
  if (response.headersSent || response.destroyed) return;
  const correlationId = response.getHeader(REQUEST_CORRELATION_HEADER);
  response.writeHead(status, {
    ...headers,
    ...(typeof correlationId === "string"
      ? { [REQUEST_CORRELATION_HEADER]: correlationId }
      : {}),
    "content-length": "0",
  });
  response.end();
}

/**
 * Consume only a small, time-bounded remainder after an early response.
 *
 * Rejected requests can still be streaming a declared body after the response
 * has flushed. Leaving that IncomingMessage paused retains its socket until the
 * much longer parser timeout. A fully received small remainder remains eligible
 * for keep-alive; a stalled or larger remainder is destroyed deterministically.
 */
function disposeUnreadRequestBody(request: IncomingMessage): void {
  if (request.destroyed || request.readableEnded) return;

  let consumedBytes = 0;
  let settled = false;
  const cleanup = (): void => {
    request.off("data", onData);
    request.off("end", onEnd);
    request.off("aborted", onClosed);
    request.off("close", onClosed);
    request.off("error", onClosed);
    clearTimeout(timer);
  };
  const settle = (destroy: boolean): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (destroy && !request.destroyed) request.destroy();
  };
  const onData = (candidate: Buffer | Uint8Array): void => {
    const length = Buffer.isBuffer(candidate)
      ? candidate.length
      : candidate.byteLength;
    consumedBytes += length;
    if (consumedBytes > MAX_REJECTED_BODY_DRAIN_BYTES) settle(true);
  };
  const onEnd = (): void => settle(false);
  const onClosed = (): void => settle(false);

  request.on("data", onData);
  request.once("end", onEnd);
  request.once("aborted", onClosed);
  request.once("close", onClosed);
  request.once("error", onClosed);
  const timer = setTimeout(() => settle(true), REJECTED_BODY_DRAIN_TIMEOUT_MS);
  timer.unref?.();
  request.resume();
}

function writeRequestTimeout(
  request: IncomingMessage,
  response: ServerResponse
): void {
  if (response.destroyed) return;
  response.shouldKeepAlive = false;
  writeJsonRpcError(response, 408, -32000, "Request timeout.", {
    connection: "close",
  });
  if (response.writableFinished) {
    request.destroy();
  } else {
    response.once("finish", () => request.destroy());
  }
}

function writeConcurrencyRejection(
  request: IncomingMessage,
  response: ServerResponse
): void {
  if (response.destroyed) return;
  response.shouldKeepAlive = false;
  writeJsonRpcError(response, 503, -32000, "Service temporarily busy.", {
    connection: "close",
    "retry-after": "1",
  });
  if (response.writableFinished) {
    request.destroy();
  } else {
    response.once("finish", () => request.destroy());
  }
}

function writeJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Readonly<Record<string, string>> = {}
): void {
  writeResponse(
    response,
    status,
    { ...JSON_ERROR_HEADERS, ...headers },
    `${JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    })}\n`
  );
}

function writeResponse(
  response: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string,
  headOnly = false
): void {
  if (response.headersSent || response.destroyed) return;
  const correlationId = response.getHeader(REQUEST_CORRELATION_HEADER);
  response.writeHead(status, {
    ...headers,
    ...(typeof correlationId === "string"
      ? { [REQUEST_CORRELATION_HEADER]: correlationId }
      : {}),
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  response.end(headOnly ? undefined : body);
}

function closeNodeServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Convert synchronous throws and rejected cleanup into a bounded boolean. */
function closeMcpServer(server: McpServer): Promise<boolean> {
  try {
    return Promise.resolve(server.close()).then(
      () => true,
      () => false
    );
  } catch {
    return Promise.resolve(false);
  }
}

async function settleWithin(
  operation: Promise<boolean>,
  timeoutMs: number
): Promise<boolean | "deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateHost(host: unknown): string {
  if (typeof host !== "string" || host.trim().length === 0 || host.length > 255) {
    throw new TypeError("HTTP host must be a non-empty string of at most 255 characters");
  }
  if (/[^\x21-\x7E]/u.test(host)) {
    throw new TypeError("HTTP host must contain only visible ASCII characters");
  }
  return host;
}

function validatePort(port: unknown): number {
  if (!Number.isInteger(port) || Number(port) < 0 || Number(port) > 65_535) {
    throw new TypeError("HTTP port must be an integer from 0 through 65535");
  }
  return Number(port);
}

function validateMaxConcurrentRequests(candidate: unknown): number {
  if (
    !Number.isSafeInteger(candidate) ||
    Number(candidate) < 1 ||
    Number(candidate) > MAX_CONCURRENT_MCP_REQUESTS
  ) {
    throw new TypeError(
      `HTTP maxConcurrentRequests must be an integer from 1 through ${MAX_CONCURRENT_MCP_REQUESTS}`
    );
  }
  return Number(candidate);
}

function validateMaxConnections(candidate: unknown): number {
  if (
    !Number.isSafeInteger(candidate) ||
    Number(candidate) < 1 ||
    Number(candidate) > MAX_HTTP_CONNECTIONS
  ) {
    throw new TypeError(
      `HTTP maxConnections must be an integer from 1 through ${MAX_HTTP_CONNECTIONS}`
    );
  }
  return Number(candidate);
}

function validateGracePeriod(gracePeriodMs: unknown): number {
  if (
    !Number.isSafeInteger(gracePeriodMs) ||
    Number(gracePeriodMs) < 0 ||
    Number(gracePeriodMs) > 300_000
  ) {
    throw new TypeError("HTTP close gracePeriodMs must be an integer from 0 through 300000");
  }
  return Number(gracePeriodMs);
}

/**
 * What one tool call reports about itself: whether the metadata cache served
 * its reads, and where its time went.
 *
 * One {@link CallMetrics} lives in the per-call request scope (see
 * `runWithServiceNowRequestSignal`), so concurrent calls never share one and
 * nothing is global. It only observes: no request, cache decision or policy
 * reads from it. Everything it exposes is a number or one of four fixed
 * strings; it never holds a host, path, parameter or response data.
 *
 * Timing is wall-clock, measured with `performance.now()`. `upstream_ms` and
 * `watermark_ms` are not sums over requests: each is the time during which at
 * least one request of that kind was in flight, so requests that run
 * side by side count once. A figure can therefore never exceed `total_ms`,
 * though the two kinds can overlap each other.
 *
 * @module call-metrics
 */

/** How one cacheable read was served. */
export type CacheOutcome = "hit" | "miss" | "bypass";

/** The call's cache status: one outcome, or `mixed` when reads differed. */
export type CacheStatus = CacheOutcome | "mixed";

/** Which kind of ServiceNow request is being timed. */
export type RequestLane = "upstream" | "watermark";

/**
 * The lanes a call's clocks count: the two kinds of request, and the field
 * types lookup the dispatcher makes before a field-policy tool runs.
 */
export type TimedLane = RequestLane | "field_types";

export interface CallTiming {
  readonly total_ms: number;
  readonly upstream_ms: number;
  readonly watermark_ms: number;
  /**
   * The whole field types lookup (memo hit, reads, retry and its pause), 0
   * when the call made none. Its own reads are not in `upstream_ms`.
   */
  readonly field_types_ms: number;
}

export interface CallMetricsSnapshot {
  /** Absent when the call made no cacheable read. */
  readonly cache?: CacheStatus;
  readonly timing: CallTiming;
}

/**
 * Time during which at least one tracked request was in flight. A request
 * entering while another is running does not restart the clock.
 */
class BusyClock {
  #active = 0;
  #busySince = 0;
  #accumulated = 0;

  enter(): () => void {
    if (this.#active === 0) this.#busySince = performance.now();
    this.#active += 1;
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#active -= 1;
      if (this.#active === 0) this.#accumulated += performance.now() - this.#busySince;
    };
  }

  read(now: number): number {
    return this.#accumulated + (this.#active > 0 ? now - this.#busySince : 0);
  }
}

export class CallMetrics {
  readonly #startedAt = performance.now();
  readonly #outcomes = new Set<CacheOutcome>();
  readonly #clocks: Readonly<Record<TimedLane, BusyClock>> = {
    upstream: new BusyClock(),
    watermark: new BusyClock(),
    field_types: new BusyClock(),
  };

  recordCache(outcome: CacheOutcome): void {
    this.#outcomes.add(outcome);
  }

  /** Run one request, counting its time against `lane` whether it settles or throws. */
  async measure<T>(lane: TimedLane, request: () => Promise<T>): Promise<T> {
    const leave = this.#clocks[lane].enter();
    try {
      return await request();
    } finally {
      leave();
    }
  }

  snapshot(): CallMetricsSnapshot {
    const now = performance.now();
    const cache: CacheStatus | undefined =
      this.#outcomes.size === 0
        ? undefined
        : this.#outcomes.size === 1
          ? [...this.#outcomes][0]
          : "mixed";
    return {
      ...(cache === undefined ? {} : { cache }),
      timing: {
        total_ms: wholeMs(now - this.#startedAt),
        upstream_ms: wholeMs(this.#clocks.upstream.read(now)),
        watermark_ms: wholeMs(this.#clocks.watermark.read(now)),
        field_types_ms: wholeMs(this.#clocks.field_types.read(now)),
      },
    };
  }
}

function wholeMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export const SERVER_ENTRYPOINT: string;

export interface SmokeOptions {
  /** Absolute path to the built stdio entrypoint this run spawns. */
  readonly entrypoint: string;
  readonly profile: string;
  readonly writeEnabled: boolean;
  readonly timeoutMs: number;
}

export function resolveSmokeOptions(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): SmokeOptions;
export function extractCreatedSysId(result: unknown): string;
export function runSmoke(options: SmokeOptions): Promise<void>;
export function writeRoundTrip(
  client: {
    callTool(
      request: unknown,
      resultSchema?: unknown,
      options?: { readonly signal?: AbortSignal; readonly timeout?: number }
    ): Promise<unknown>;
  },
  checks: Array<{ name: string; pass: boolean; note: string }>,
  profile: string,
  timeoutMs?: number
): Promise<void>;

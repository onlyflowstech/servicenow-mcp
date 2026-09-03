export const INSPECTOR_VERSION: "2.0.0";
export const INSPECTOR_NODE_MINIMUM: readonly [22, 19, 0];

export const SERVER_ENTRYPOINT: string;

export interface InspectorOptions {
  /** The stdio server command an operator enters in the Inspector UI. */
  readonly command: string;
  readonly args: readonly string[];
  readonly profile: string;
}

export interface InspectorLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export function resolveInspectorOptions(
  environment: Readonly<Record<string, string | undefined>>
): InspectorOptions;
export function assertInspectorNodeVersion(version?: string): void;
export function inspectorLaunch(
  environment: Readonly<Record<string, string | undefined>>
): InspectorLaunch;
export function launchInspector(
  options: InspectorOptions,
  environment?: Readonly<Record<string, string | undefined>>
): Promise<void>;

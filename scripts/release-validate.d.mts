export const PORTABLE_RELEASE_GATES: readonly string[];
export const CONTAINER_RELEASE_GATES: readonly string[];

export interface ReleaseContractOptions {
  readonly root?: string;
  readonly tag?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface ReleaseContractEvidence {
  readonly version: string;
  readonly tag: string | null;
  readonly inspectorVersion: string;
  readonly portableGateCount: number;
  readonly containerGateCount: number;
  readonly providerNeutral: true;
  readonly publicTunnelCreated: false;
}

export function validateReleaseContract(
  options?: ReleaseContractOptions
): ReleaseContractEvidence;

export interface ArtifactOutputReservation {
  readonly artifactDirectory: string;
  readonly destination: string;
  readonly directoryIdentity: DirectoryIdentity;
  readonly stagingDirectory: string;
  readonly stagingDirectoryIdentity: DirectoryIdentity;
  readonly stagingDestination: string;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly private: boolean;
  readonly role: "artifact" | "staging";
}

export interface ArtifactPublicationHooks {
  afterStagedArtifactOpened?(reservation: ArtifactOutputReservation): void;
  beforeDestinationOpen?(reservation: ArtifactOutputReservation): void;
  afterDestinationOpened?(reservation: ArtifactOutputReservation): void;
  afterDestinationCopied?(reservation: ArtifactOutputReservation): void;
}

export function createArtifactOutputReservation(
  repositoryRoot: string,
  outputName: string
): ArtifactOutputReservation;

export function publishArtifactOutput(
  reservation: ArtifactOutputReservation,
  hooks?: ArtifactPublicationHooks
): string;

export function cleanupArtifactOutput(
  reservation: ArtifactOutputReservation
): void;

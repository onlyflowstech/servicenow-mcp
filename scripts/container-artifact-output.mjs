/** Fail-closed staging and exclusive no-clobber publication for OCI archives. */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const ACTIVE_RESERVATIONS = new WeakSet();
const NO_FOLLOW = constants.O_NOFOLLOW;
const MAX_OCI_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
  throw new Error("OCI artifact publication requires O_NOFOLLOW support");
}

export function createArtifactOutputReservation(repositoryRoot, outputName) {
  if (
    typeof outputName !== "string" ||
    outputName.length === 0 ||
    basename(outputName) !== outputName
  ) {
    throw new Error("OCI output name must be a single path component");
  }
  const canonicalRoot = realpathSync(repositoryRoot);
  const artifactDirectory = resolve(canonicalRoot, "artifacts");
  try {
    mkdirSync(artifactDirectory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  secureDirectoryIdentity(artifactDirectory);
  const directoryIdentity = secureDirectoryIdentity(
    artifactDirectory,
    true,
    "artifact"
  );
  const destination = resolve(artifactDirectory, outputName);
  if (
    dirname(destination) !== artifactDirectory ||
    pathEntryExists(destination)
  ) {
    throw new Error("OCI output must be a new file directly under artifacts/");
  }

  const canonicalTempRoot = realpathSync(tmpdir());
  const stagingDirectory = mkdtempSync(join(canonicalTempRoot, "servicenow-mcp-oci-"));
  const stagingDirectoryIdentity = secureDirectoryIdentity(
    stagingDirectory,
    true,
    "staging"
  );
  assertSameDirectory(artifactDirectory, directoryIdentity);
  const stagingDestination = join(stagingDirectory, "payload.oci.tar");
  const reservation = Object.freeze({
    artifactDirectory,
    destination,
    directoryIdentity,
    stagingDirectory,
    stagingDirectoryIdentity,
    stagingDestination,
  });
  ACTIVE_RESERVATIONS.add(reservation);
  return reservation;
}

export function publishArtifactOutput(reservation, hooks = {}) {
  assertActiveReservation(reservation);
  const validatedHooks = validatePublicationHooks(hooks);
  let sourceDescriptor;
  let publicationDescriptor;
  let sourceIdentity;
  let publicationIdentity;
  try {
    assertSameDirectory(
      reservation.stagingDirectory,
      reservation.stagingDirectoryIdentity,
      true
    );
    sourceDescriptor = openSync(
      reservation.stagingDestination,
      constants.O_RDONLY | NO_FOLLOW
    );
    sourceIdentity = regularFileIdentity(
      sourceDescriptor,
      reservation.stagingDestination,
      "OCI builder did not produce a safe regular archive"
    );
    if (
      sourceIdentity.size <= 0 ||
      sourceIdentity.size > MAX_OCI_ARCHIVE_BYTES
    ) {
      throw new Error("OCI archive size is invalid");
    }
    validatedHooks.afterStagedArtifactOpened?.(reservation);

    assertSameDirectory(
      reservation.artifactDirectory,
      reservation.directoryIdentity
    );
    validatedHooks.beforeDestinationOpen?.(reservation);
    publicationDescriptor = openSync(
      reservation.destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        NO_FOLLOW,
      0o600
    );
    publicationIdentity = fstatSync(publicationDescriptor);
    assertRegularIdentity(publicationIdentity, "OCI publication destination is invalid");
    fchmodSync(publicationDescriptor, 0o600);
    const permissionIdentity = fstatSync(publicationDescriptor);
    if (
      permissionIdentity.dev !== publicationIdentity.dev ||
      permissionIdentity.ino !== publicationIdentity.ino ||
      (process.platform !== "win32" &&
        (permissionIdentity.mode & 0o777) !== 0o600)
    ) {
      throw new Error("OCI publication destination permissions are invalid");
    }
    publicationIdentity = permissionIdentity;
    validatedHooks.afterDestinationOpened?.(reservation);
    assertSameDirectory(
      reservation.artifactDirectory,
      reservation.directoryIdentity
    );
    assertPathIdentity(reservation.destination, publicationIdentity);
    copyExactFile(
      sourceDescriptor,
      publicationDescriptor,
      sourceIdentity.size
    );
    fsyncSync(publicationDescriptor);
    const completedIdentity = fstatSync(publicationDescriptor);
    assertRegularIdentity(completedIdentity, "OCI publication destination is invalid");
    if (
      completedIdentity.dev !== publicationIdentity.dev ||
      completedIdentity.ino !== publicationIdentity.ino ||
      completedIdentity.size !== sourceIdentity.size
    ) {
      throw new Error("OCI archive publication descriptor identity check failed");
    }
    validatedHooks.afterDestinationCopied?.(reservation);
    assertSameDirectory(
      reservation.artifactDirectory,
      reservation.directoryIdentity
    );
    assertPathIdentity(reservation.destination, completedIdentity);

    closeSync(publicationDescriptor);
    publicationDescriptor = undefined;
    closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    cleanupStagingReservation(reservation);
    ACTIVE_RESERVATIONS.delete(reservation);
    return reservation.destination;
  } catch (error) {
    if (publicationDescriptor !== undefined && publicationIdentity) {
      removePathOnlyIfIdentityMatches(
        reservation.artifactDirectory,
        reservation.directoryIdentity,
        reservation.destination,
        publicationIdentity
      );
    }
    if (publicationDescriptor !== undefined) closeSync(publicationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
    throw error;
  }
}

export function cleanupArtifactOutput(reservation) {
  if (!ACTIVE_RESERVATIONS.has(reservation)) return;
  cleanupStagingReservation(reservation);
  ACTIVE_RESERVATIONS.delete(reservation);
}

function secureDirectoryIdentity(
  directory,
  requirePrivate = false,
  role = "unclassified"
) {
  const entry = lstatSync(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    realpathSync(directory) !== directory ||
    (requirePrivate && process.platform !== "win32" && (entry.mode & 0o777) !== 0o700) ||
    (requirePrivate &&
      typeof process.getuid === "function" &&
      entry.uid !== process.getuid())
  ) {
    throw new Error(
      requirePrivate
        ? "OCI staging directory must be private and owner-controlled"
        : "artifacts/ must be a real directory under the repository"
    );
  }
  return Object.freeze({
    dev: entry.dev,
    ino: entry.ino,
    mode: entry.mode,
    uid: entry.uid,
    private: requirePrivate,
    role,
  });
}

function assertSameDirectory(
  directory,
  expected,
  requirePrivate = expected.private === true
) {
  const actual = secureDirectoryIdentity(
    directory,
    requirePrivate,
    expected.role
  );
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(
      expected.role === "staging"
        ? "OCI staging directory changed during the build"
        : "artifacts/ changed during the build"
    );
  }
}

function regularFileIdentity(descriptor, path, message) {
  const descriptorIdentity = fstatSync(descriptor);
  assertRegularIdentity(descriptorIdentity, message);
  const pathIdentity = lstatSync(path);
  if (
    pathIdentity.isSymbolicLink() ||
    !pathIdentity.isFile() ||
    pathIdentity.dev !== descriptorIdentity.dev ||
    pathIdentity.ino !== descriptorIdentity.ino
  ) {
    throw new Error(message);
  }
  return descriptorIdentity;
}

function assertRegularIdentity(identity, message) {
  if (identity.isSymbolicLink() || !identity.isFile()) throw new Error(message);
}

function assertPathIdentity(path, expected) {
  const actual = lstatSync(path);
  if (
    actual.isSymbolicLink() ||
    !actual.isFile() ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error("OCI archive publication identity check failed");
  }
}

function copyExactFile(source, destination, size) {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let remaining = size;
  while (remaining > 0) {
    const count = readSync(source, buffer, 0, Math.min(buffer.length, remaining), null);
    if (count <= 0) throw new Error("OCI archive changed while being copied");
    let offset = 0;
    while (offset < count) {
      const written = writeSync(destination, buffer, offset, count - offset);
      if (written <= 0) throw new Error("OCI archive publication write failed");
      offset += written;
    }
    remaining -= count;
  }
  if (readSync(source, buffer, 0, 1, null) !== 0) {
    throw new Error("OCI archive changed while being copied");
  }
}

function cleanupStagingReservation(reservation) {
  try {
    assertSameDirectory(
      reservation.stagingDirectory,
      reservation.stagingDirectoryIdentity,
      true
    );
  } catch {
    return;
  }
  try {
    lstatSync(reservation.stagingDestination);
    unlinkSync(reservation.stagingDestination);
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
  try {
    rmdirSync(reservation.stagingDirectory);
  } catch {
    // A changed/non-empty private staging directory is left for safe operator cleanup.
  }
}

function removePathOnlyIfIdentityMatches(parent, parentIdentity, path, identity) {
  try {
    assertSameDirectory(parent, parentIdentity);
    const candidate = lstatSync(path);
    if (
      !candidate.isSymbolicLink() &&
      candidate.isFile() &&
      candidate.dev === identity.dev &&
      candidate.ino === identity.ino
    ) {
      unlinkSync(path);
      assertSameDirectory(parent, parentIdentity);
      if (pathEntryExists(path)) {
        throw new Error("OCI publication cleanup could not be verified");
      }
    }
  } catch {
    // Never unlink through an unverified or swapped parent.
  }
}

function validatePublicationHooks(candidate) {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("OCI publication hooks are invalid");
  }
  const allowed = new Set([
    "afterStagedArtifactOpened",
    "beforeDestinationOpen",
    "afterDestinationOpened",
    "afterDestinationCopied",
  ]);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error("OCI publication hooks are invalid");
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new Error("OCI publication hooks are invalid");
    }
  }
  return candidate;
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertActiveReservation(reservation) {
  if (
    typeof reservation !== "object" ||
    reservation === null ||
    !ACTIVE_RESERVATIONS.has(reservation)
  ) {
    throw new Error("OCI output reservation is invalid or already consumed");
  }
}

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIN_WAV_SIZE_BYTES = 45;
const MAX_TRACK_SEGMENT_LENGTH = 80;
const MAX_SHORT_ID_LENGTH = 11;

const LOOPBACK_DEVICE_PATTERNS = [
  /virtual-audio-capturer/i,
  /(?:^|[._\s-])loopback(?:$|[._\s-])/i,
  /(?:^|[._\s-])monitor(?:$|[._\s-])/i,
  /monitor of /i,
  /stereo mix/i,
  /what (?:u|you) hear/i,
  /vb-audio/i,
  /cable output/i,
  /blackhole/i
];

function isDedicatedInputDevice(device) {
  if (typeof device !== 'string' || !device.trim()) return false;
  return !LOOPBACK_DEVICE_PATTERNS.some(pattern => pattern.test(device));
}

function assertDedicatedInputDevice(device) {
  if (!isDedicatedInputDevice(device)) {
    throw new Error('Select a dedicated audio input device; system loopback capture is not supported');
  }
  return device.trim();
}

function buildCaptureProcessSpec({ platform, device, outputPath = '-', sampleRate = 16000 }) {
  const inputDevice = assertDedicatedInputDevice(device);
  const rate = Number(sampleRate);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000) {
    throw new Error('Invalid audio sample rate');
  }

  if (platform === 'win32') {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'dshow',
      '-i', `audio=${inputDevice}`,
      '-ac', '2',
      '-ar', String(rate)
    ];
    if (outputPath === '-') {
      args.push('-f', 's16le', '-');
    } else {
      args.push('-c:a', 'pcm_s16le', '-f', 'wav', '-y', outputPath);
    }
    return { command: 'ffmpeg', args };
  }

  if (platform === 'linux') {
    return {
      command: 'pw-record',
      args: [
        '--target', inputDevice,
        '--format', 's16',
        '--rate', String(rate),
        '--channels', '2',
        outputPath
      ]
    };
  }

  throw new Error(`Owned-input capture is not supported on ${platform}`);
}

function sanitizeTrackSegment(value, fallback) {
  const sanitized = String(value || '')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, MAX_TRACK_SEGMENT_LENGTH)
    .replace(/[. ]+$/g, '');
  return sanitized || fallback;
}

function normalizeShortId(value) {
  const supplied = String(value || '')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SHORT_ID_LENGTH);
  return supplied || crypto.randomBytes(4).toString('hex');
}

function normalizeTrackMetadata({ artist, title } = {}) {
  return {
    artist: sanitizeTrackSegment(artist, 'Unknown Artist'),
    title: sanitizeTrackSegment(title, 'Owned Recording')
  };
}

function createTrackFilename({ artist, title, id } = {}) {
  const normalized = normalizeTrackMetadata({ artist, title });
  return `${normalized.artist} - ${normalized.title} [${normalizeShortId(id)}].wav`;
}

function getTrackDestination({ directory, artist, title, id, attempt = 1 }) {
  const normalized = normalizeTrackMetadata({ artist, title });
  const baseId = normalizeShortId(id);
  const suffix = `-${attempt}`;
  const candidateId = attempt === 1
    ? baseId
    : `${baseId.slice(0, Math.max(1, MAX_SHORT_ID_LENGTH - suffix.length))}${suffix}`;
  const filename = createTrackFilename({ ...normalized, id: candidateId });
  return { filename, filePath: path.join(directory, filename) };
}

async function linkStagedTrackNoClobber({
  sourcePath,
  sourceHandle,
  canonicalSourceRoot,
  directory,
  artist,
  title,
  id,
  linkFile = fs.promises.link.bind(fs.promises)
}) {
  for (let attempt = 1; attempt <= 9999; attempt += 1) {
    const destination = getTrackDestination({ directory, artist, title, id, attempt });
    try {
      await assertPathIdentifiesHeldFile(sourcePath, sourceHandle, canonicalSourceRoot);
      await linkFile(sourcePath, destination.filePath);
      try {
        await assertPathMatchesHeldFile(destination.filePath, sourceHandle);
      } catch (error) {
        throw new Error(
          `Recording source changed during finalization; public artifact was preserved for recovery at ${destination.filePath}`,
          { cause: error }
        );
      }
      return destination;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Unable to reserve a collision-safe track filename');
}

async function validateWavHandle(handle) {
  const stats = await handle.stat({ bigint: true });
  if (!stats.isFile() || stats.size < BigInt(MIN_WAV_SIZE_BYTES)) {
    throw new Error('Recording does not contain an audio payload');
  }
  const header = Buffer.alloc(12);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead !== header.length || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Recording is not a valid WAV file');
  }
  return { sizeBytes: Number(stats.size) };
}

async function validateWavFile(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    return await validateWavHandle(handle);
  } finally {
    await handle.close();
  }
}

function waitForChildClose(childProcess) {
  return new Promise(resolve => {
    let spawnError = null;
    childProcess.once('error', error => {
      spawnError = error;
    });
    childProcess.once('close', (code, signal) => {
      resolve({ code, signal, spawnError });
    });
  });
}

function isPathInside(parentDirectory, childPath) {
  const relative = path.relative(path.resolve(parentDirectory), path.resolve(childPath));
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function isPathInsideOrEqual(parentDirectory, childPath) {
  const relative = path.relative(path.resolve(parentDirectory), path.resolve(childPath));
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertStableFileIdentity(stats) {
  if (typeof stats.dev !== 'bigint' || typeof stats.ino !== 'bigint' || (stats.dev === 0n && stats.ino === 0n)) {
    throw new Error('Filesystem does not expose a stable file identity');
  }
}

async function assertPathMatchesHeldFile(filePath, handle) {
  const handleStats = await handle.stat({ bigint: true });
  assertStableFileIdentity(handleStats);
  const pathStats = await fs.promises.lstat(filePath, { bigint: true });
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || !sameFileIdentity(handleStats, pathStats)) {
    throw new Error('Recording source changed while it was being processed');
  }
  return handleStats;
}

async function assertPathIdentifiesHeldFile(filePath, handle, canonicalRoot) {
  const handleStats = await assertPathMatchesHeldFile(filePath, handle);
  const realSource = await fs.promises.realpath(filePath);
  if (!isPathInsideOrEqual(canonicalRoot, realSource)) {
    throw new Error('Recording source resolves outside the recordings directory');
  }
  const finalPathStats = await fs.promises.lstat(filePath, { bigint: true });
  if (finalPathStats.isSymbolicLink() || !finalPathStats.isFile() || !sameFileIdentity(handleStats, finalPathStats)) {
    throw new Error('Recording source changed while it was being processed');
  }
  return handleStats;
}

async function openHeldRegularContainedFile(rootDirectory, candidatePath, { allowRoot = false } = {}) {
  const resolvedRoot = path.resolve(rootDirectory);
  const resolvedPath = path.resolve(candidatePath);
  const contained = allowRoot
    ? isPathInsideOrEqual(resolvedRoot, resolvedPath)
    : isPathInside(resolvedRoot, resolvedPath);
  if (!contained) {
    throw new Error('Recording source resolves outside the recordings directory');
  }

  const canonicalRoot = await fs.promises.realpath(resolvedRoot);
  const entryStats = await fs.promises.lstat(resolvedPath, { bigint: true });
  if (entryStats.isSymbolicLink()) {
    throw new Error('Recording source must not be a symbolic link');
  }
  if (!entryStats.isFile()) {
    throw new Error('Recording source must be a regular file');
  }
  assertStableFileIdentity(entryStats);
  const realSource = await fs.promises.realpath(resolvedPath);
  if (!isPathInsideOrEqual(canonicalRoot, realSource)) {
    throw new Error('Recording source resolves outside the recordings directory');
  }

  const handle = await fs.promises.open(resolvedPath, 'r');
  try {
    const identity = await assertPathIdentifiesHeldFile(resolvedPath, handle, canonicalRoot);
    if (!sameFileIdentity(entryStats, identity)) {
      throw new Error('Recording source changed while it was being opened');
    }
    return { handle, identity, sourcePath: resolvedPath, canonicalRoot };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameFileVersion(left, right) {
  return sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function copyHeldFile(sourceHandle, destinationHandle, expectedSourceStats) {
  const sizeBytes = Number(expectedSourceStats.size);
  if (!Number.isSafeInteger(sizeBytes)) {
    throw new Error('Recording is too large to copy safely');
  }

  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < sizeBytes) {
    const requested = Math.min(buffer.length, sizeBytes - position);
    const { bytesRead } = await sourceHandle.read(buffer, 0, requested, position);
    if (bytesRead === 0) {
      throw new Error('Recording source changed while it was being copied');
    }
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) {
        throw new Error('Unable to write the publication staging file');
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }

  const finalSourceStats = await sourceHandle.stat({ bigint: true });
  if (!sameFileVersion(expectedSourceStats, finalSourceStats)) {
    throw new Error('Recording source changed while it was being copied');
  }
  const destinationStats = await destinationHandle.stat({ bigint: true });
  if (!destinationStats.isFile() || destinationStats.size !== expectedSourceStats.size) {
    throw new Error('Publication staging copy is incomplete');
  }
  return destinationStats;
}

async function openExclusiveTemporaryFile(filePath) {
  const handle = await fs.promises.open(filePath, 'wx+', 0o600);
  try {
    const identity = await handle.stat({ bigint: true });
    if (!identity.isFile()) throw new Error('Exclusive staging entry is not a regular file');
    assertStableFileIdentity(identity);
    return { filePath, handle, identity };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function cleanupOwnedTemporaryPath(filePath, expectedIdentity) {
  // This helper is intentionally restricted to private staging names. Public
  // destinations are never rolled back because Node has no conditional unlink.
  let currentStats;
  try {
    currentStats = await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  if (currentStats.isSymbolicLink() || !currentStats.isFile() || !sameFileIdentity(currentStats, expectedIdentity)) {
    return false;
  }
  await fs.promises.unlink(filePath);
  return true;
}

async function finalizeOwnedRecording({
  tempPath,
  recordingsDir,
  artist,
  title,
  id,
  device = '',
  capturedAt = new Date().toISOString(),
  persistMetadata = () => {},
  linkFile = fs.promises.link.bind(fs.promises)
}) {
  const stagingDirectory = path.join(recordingsDir, '.staging');
  if (!isPathInside(stagingDirectory, tempPath)) {
    throw new Error('Recording temporary file must be inside the staging directory');
  }
  const source = await openHeldRegularContainedFile(stagingDirectory, tempPath);
  try {
    const validation = await validateWavHandle(source.handle);
    const normalized = normalizeTrackMetadata({ artist, title });
    const destination = await linkStagedTrackNoClobber({
      sourcePath: source.sourcePath,
      sourceHandle: source.handle,
      canonicalSourceRoot: source.canonicalRoot,
      directory: recordingsDir,
      ...normalized,
      id,
      linkFile
    });
    const metadata = {
      ...normalized,
      tags: [],
      notes: '',
      favorite: false,
      sourceKind: 'owned_input',
      captureDevice: String(device || ''),
      capturedAt,
      embeddedTags: false
    };
    try {
      await persistMetadata(destination.filename, metadata);
    } catch (error) {
      throw new Error(
        `Metadata persistence failed; finalized audio was preserved for recovery at ${destination.filePath}`,
        { cause: error }
      );
    }
    const stagingSourceRemoved = await cleanupOwnedTemporaryPath(source.sourcePath, source.identity)
      .catch(() => false);

    return {
      ...destination,
      ...validation,
      metadata,
      stagingCleanupPending: !stagingSourceRemoved
    };
  } finally {
    await source.handle.close().catch(() => {});
  }
}

function assertSimpleWavFilename(filename) {
  if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..') {
    throw new Error('Invalid source filename');
  }
  if (path.posix.basename(filename) !== filename || path.win32.basename(filename) !== filename) {
    throw new Error('Invalid source filename');
  }
  if (/[<>:"|?*\u0000-\u001f]/.test(filename) || /[. ]$/.test(filename)) {
    throw new Error('Invalid source filename');
  }
  if (!/^[^\u0000-\u001f]+\.wav$/i.test(filename)) {
    throw new Error('Only finalized WAV recordings can be published');
  }
}

async function writeJsonAtomically(
  filePath,
  value,
  { linkFile = fs.promises.link.bind(fs.promises) } = {}
) {
  const temporaryPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let temporaryFile = null;
  try {
    temporaryFile = await openExclusiveTemporaryFile(temporaryPath);
    await temporaryFile.handle.writeFile(serialized, { encoding: 'utf8' });
    await temporaryFile.handle.sync();
    await assertPathMatchesHeldFile(temporaryFile.filePath, temporaryFile.handle);
    await linkFile(temporaryFile.filePath, filePath);
    try {
      await assertPathMatchesHeldFile(filePath, temporaryFile.handle);
    } catch (error) {
      throw new Error(`Sidecar publication could not be verified; public artifact was preserved for recovery at ${filePath}`, { cause: error });
    }
  } finally {
    if (temporaryFile) {
      await cleanupOwnedTemporaryPath(temporaryFile.filePath, temporaryFile.identity).catch(() => {});
      await temporaryFile.handle.close().catch(() => {});
    }
  }
}

async function pathEntryExists(filePath) {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function openRegularContainedSource(recordingsDir, filename) {
  const recordingsRoot = path.resolve(recordingsDir);
  return openHeldRegularContainedFile(recordingsRoot, path.resolve(recordingsRoot, filename));
}

async function publishOwnedRecording({
  filename,
  recordingsDir,
  publishDir,
  metadata = {},
  id,
  publishedAt = new Date().toISOString(),
  linkFile = fs.promises.link.bind(fs.promises)
}) {
  assertSimpleWavFilename(filename);
  if (typeof publishDir !== 'string' || !publishDir.trim()) {
    throw new Error('BREAK_WAVE_PUBLISH_DIR is not configured');
  }

  const source = await openRegularContainedSource(recordingsDir, filename);
  let temporaryAudio = null;
  try {
    await validateWavHandle(source.handle);
    const normalized = normalizeTrackMetadata(metadata);
    await assertPathIdentifiesHeldFile(source.sourcePath, source.handle, source.canonicalRoot);
    await fs.promises.mkdir(publishDir, { recursive: true });

    const temporaryAudioPath = path.join(
      publishDir,
      `.wavesentry-publish-${crypto.randomBytes(8).toString('hex')}.wav`
    );
    temporaryAudio = await openExclusiveTemporaryFile(temporaryAudioPath);
    await copyHeldFile(source.handle, temporaryAudio.handle, source.identity);
    await validateWavHandle(temporaryAudio.handle);
    await temporaryAudio.handle.sync();
    await assertPathIdentifiesHeldFile(source.sourcePath, source.handle, source.canonicalRoot);
    const sidecar = {
      schemaVersion: 1,
      ...normalized,
      notes: String(metadata.notes || ''),
      tags: Array.isArray(metadata.tags) ? metadata.tags.map(String) : [],
      sourceKind: 'owned_recording',
      sourceFilename: filename,
      publishedAt,
      embeddedTags: false
    };

    for (let attempt = 1; attempt <= 9999; attempt += 1) {
      const destination = getTrackDestination({
        directory: publishDir,
        ...normalized,
        id,
        attempt
      });
      const sidecarPath = `${destination.filePath}.json`;
      if (await pathEntryExists(destination.filePath) || await pathEntryExists(sidecarPath)) {
        continue;
      }
      try {
        await linkFile(temporaryAudio.filePath, destination.filePath);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }

      try {
        await assertPathMatchesHeldFile(destination.filePath, temporaryAudio.handle);
      } catch (error) {
        throw new Error(
          `Published audio could not be verified; public artifact was preserved for recovery at ${destination.filePath}`,
          { cause: error }
        );
      }

      try {
        await writeJsonAtomically(sidecarPath, sidecar, { linkFile });
      } catch (error) {
        throw new Error(
          `Sidecar publication failed; published audio was preserved for recovery at ${destination.filePath}`,
          { cause: error }
        );
      }

      await cleanupOwnedTemporaryPath(temporaryAudio.filePath, temporaryAudio.identity).catch(() => {});
      return {
        filename: destination.filename,
        filePath: destination.filePath,
        sidecarPath,
        metadata: sidecar
      };
    }
    throw new Error('Unable to reserve a collision-safe published track filename');
  } catch (error) {
    if (temporaryAudio) {
      await cleanupOwnedTemporaryPath(temporaryAudio.filePath, temporaryAudio.identity).catch(() => {});
    }
    throw error;
  } finally {
    if (temporaryAudio) await temporaryAudio.handle.close().catch(() => {});
    await source.handle.close().catch(() => {});
  }
}

module.exports = {
  assertDedicatedInputDevice,
  assertSimpleWavFilename,
  buildCaptureProcessSpec,
  createTrackFilename,
  finalizeOwnedRecording,
  isDedicatedInputDevice,
  normalizeTrackMetadata,
  publishOwnedRecording,
  sanitizeTrackSegment,
  validateWavFile,
  waitForChildClose
};

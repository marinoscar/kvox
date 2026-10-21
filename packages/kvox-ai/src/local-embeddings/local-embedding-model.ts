import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';

import {
  downloadVerifiedFile,
  type VerifiedDownloadErrors,
} from '../download/index.js';
import {
  LOCAL_EMBEDDING_DOWNLOAD_HOSTS,
  LOCAL_EMBEDDING_MANIFEST,
  type LocalEmbeddingManifest,
} from './local-embedding-files.js';

// =============================================================================
// Downloading, finding and removing the model (issue #660)
// =============================================================================
//
// Layout under the host's `directory`:
//
//   <directory>/<model id>/model.onnx, tokenizer.json, tokenizer_config.json,
//                          installed.json   (the record of a finished install)
//   <directory>/.stage-<nonce>/             (a download in progress; deleted on failure)
//
// A model directory exists only whole: files are verified inside the staging
// directory and the directory is renamed into place last.
// =============================================================================

const RECORD_FILE = 'installed.json';

/**
 * Why a download failed.
 *
 * @stability experimental
 */
export type LocalEmbeddingDownloadErrorCode =
  | 'invalid'
  | 'host_refused'
  | 'download_failed'
  | 'checksum_mismatch'
  | 'download_too_large';

/**
 * The error {@link downloadLocalEmbeddingModel} throws. Carries no URL query or secret.
 *
 * @stability experimental
 */
export class LocalEmbeddingDownloadError extends Error {
  /** What went wrong. */
  readonly code: LocalEmbeddingDownloadErrorCode;
  /** The host a refusal names, when there is one. */
  readonly host?: string;

  constructor(code: LocalEmbeddingDownloadErrorCode, message: string, host?: string) {
    super(message);
    this.name = 'LocalEmbeddingDownloadError';
    this.code = code;
    if (host !== undefined) this.host = host;
  }
}

/**
 * What {@link downloadLocalEmbeddingModel} takes.
 *
 * @stability experimental
 */
export interface DownloadLocalEmbeddingModelOptions {
  /** The host's app-private folder for models. Created when missing. */
  directory: string;
  /** Cancels the download; staged files are deleted. */
  signal?: AbortSignal;
  /** Bytes received so far across all files, and the total of the manifest. Never breaks the download. */
  onProgress?(received: number, total: number): void;
  /** Replaces the global `fetch` (tests, a proxy-aware client). */
  fetch?: typeof fetch;
  /** A different manifest (a mirror, a test). Default: {@link LOCAL_EMBEDDING_MANIFEST}. */
  manifest?: LocalEmbeddingManifest;
  /** Hosts allowed on every hop. Default: {@link LOCAL_EMBEDDING_DOWNLOAD_HOSTS}. */
  allowedHosts?: readonly string[];
}

/**
 * The result of an install.
 *
 * @stability experimental
 */
export interface LocalEmbeddingInstall {
  /** The installed model directory (`<directory>/<model id>`). */
  path: string;
}

/**
 * What an install leaves behind and {@link localEmbeddingModelStatus} reports.
 *
 * @stability experimental
 */
export interface LocalEmbeddingModelStatus {
  /** True when the model directory holds every file at its pinned size and a matching record. */
  installed: boolean;
  /** The model directory (`<directory>/<model id>`), when installed. */
  path?: string;
}

interface InstallRecord {
  model: string;
  files: { name: string; size: number; sha256: string }[];
}

const errors: VerifiedDownloadErrors = {
  invalid: (text) => new LocalEmbeddingDownloadError('invalid', text),
  refusedHost: (text, host) =>
    new LocalEmbeddingDownloadError('host_refused', text, host?.replace(/[^A-Za-z0-9.-]/g, '?').slice(0, 100)),
  failed: (text) => new LocalEmbeddingDownloadError('download_failed', text),
  mismatch: () =>
    new LocalEmbeddingDownloadError('checksum_mismatch', 'A downloaded model file does not match its checksum; it was deleted.'),
  tooLarge: () => new LocalEmbeddingDownloadError('download_too_large', 'A model file is larger than allowed.'),
  isOwn: (err) => err instanceof LocalEmbeddingDownloadError,
};

/**
 * Downloads `KVOX_LOCAL_EMBEDDING`'s files into `<directory>/<model id>/`,
 * verified.
 *
 * @remarks
 * Idempotent: when the model is already installed (every file present at its
 * pinned size, a matching `installed.json`) it returns at once and makes no
 * request. Otherwise each file is fetched from an allowlisted host (https only,
 * redirects checked hop by hop), capped at its pinned size, hashed while it
 * streams and compared with its pinned SHA-256 inside a staging directory; the
 * record is written and the directory is renamed into place last. Any failure
 * (including an abort) deletes the staging directory and installs nothing.
 *
 * @param o - the target directory and optional signal, progress callback and fetch.
 * @returns `path`, the installed model directory.
 * @throws LocalEmbeddingDownloadError
 *
 * @stability experimental
 */
export async function downloadLocalEmbeddingModel(o: DownloadLocalEmbeddingModelOptions): Promise<LocalEmbeddingInstall> {
  const manifest = o.manifest ?? LOCAL_EMBEDDING_MANIFEST;
  const dir = join(o.directory, manifest.model);
  const existing = await readStatus(o.directory, manifest);
  if (existing.installed) return { path: dir };

  const hosts = new Set((o.allowedHosts ?? LOCAL_EMBEDDING_DOWNLOAD_HOSTS).map((h) => h.trim().toLowerCase()));
  const total = manifest.files.reduce((n, f) => n + f.size, 0);
  await fsp.mkdir(o.directory, { recursive: true });
  const staging = join(o.directory, `.stage-${randomBytes(6).toString('hex')}`);
  await fsp.mkdir(staging);
  try {
    let done = 0;
    for (const file of manifest.files) {
      const base = done;
      const written = await downloadVerifiedFile({
        url: file.url,
        sha256: file.sha256,
        maxBytes: file.size,
        allowedHosts: hosts,
        destination: join(staging, file.name),
        ...(o.signal ? { signal: o.signal } : {}),
        onProgress: (received) => o.onProgress?.(base + received, total),
        ...(o.fetch ? { fetch: o.fetch } : {}),
        errors,
        subject: 'model file',
      });
      if (written !== file.size) {
        throw new LocalEmbeddingDownloadError('checksum_mismatch', 'A downloaded model file has an unexpected size.');
      }
      done += file.size;
    }
    const record: InstallRecord = {
      model: manifest.model,
      files: manifest.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
    };
    await fsp.writeFile(join(staging, RECORD_FILE), JSON.stringify(record));
    // Atomic: the model directory appears whole or not at all.
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(staging, dir);
    return { path: dir };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Whether the model is installed under `directory`, by file sizes and the
 * install record (no hashing, so it is cheap enough to call on every start).
 *
 * @param directory - the host's model folder.
 * @returns `installed` and, when true, the model directory.
 *
 * @stability experimental
 */
export async function localEmbeddingModelStatus(directory: string): Promise<LocalEmbeddingModelStatus> {
  return readStatus(directory, LOCAL_EMBEDDING_MANIFEST);
}

/**
 * Deletes the installed model (and any leftover staging directory). Resolves
 * also when nothing is installed.
 *
 * @param directory - the host's model folder.
 *
 * @stability experimental
 */
export async function removeLocalEmbeddingModel(directory: string): Promise<void> {
  await fsp.rm(join(directory, LOCAL_EMBEDDING_MANIFEST.model), { recursive: true, force: true });
  let names: string[] = [];
  try {
    names = await fsp.readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names.filter((n) => n.startsWith('.stage-')).map((n) => fsp.rm(join(directory, n), { recursive: true, force: true })),
  );
}

async function readStatus(directory: string, manifest: LocalEmbeddingManifest): Promise<LocalEmbeddingModelStatus> {
  const dir = join(directory, manifest.model);
  try {
    const record = JSON.parse(await fsp.readFile(join(dir, RECORD_FILE), 'utf8')) as Partial<InstallRecord>;
    if (record.model !== manifest.model || !Array.isArray(record.files)) return { installed: false };
    for (const file of manifest.files) {
      const entry = record.files.find((f) => f?.name === file.name);
      if (!entry || entry.sha256 !== file.sha256 || entry.size !== file.size) return { installed: false };
      const st = await fsp.stat(join(dir, file.name));
      if (!st.isFile() || st.size !== file.size) return { installed: false };
    }
    return { installed: true, path: dir };
  } catch {
    return { installed: false };
  }
}

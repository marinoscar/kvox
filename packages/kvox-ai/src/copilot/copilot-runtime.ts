import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { AiError } from '@marinoscar/platform-ai-providers';

import { copilotErrorFromThrown, redactTokens } from './copilot-errors.js';

// =============================================================================
// Preparing the Copilot runtime: directories, location, checksum (issue #630)
// =============================================================================
//
// `@github/copilot-sdk` drives a per-platform runtime of about 133-174 MB. A
// host (KVox Desktop) must not own the mechanics of finding it, checking it and
// keeping Copilot's directories app-private, so `prepareCopilotRuntime` owns
// them.
//
// WHAT THE SPIKE FOUND (SDK 1.0.22, runtime 1.0.98; read from the published
// packages, nothing run against a signed-in account):
//
//   • The runtime is NOT downloaded by the SDK. It ships as an optional npm
//     dependency, `@github/copilot-sdk-<platform>` (eight platforms), whose
//     `prebuilds/<platform>/` holds a small wrapper (`copilot-runtime`, or
//     `copilot-runtime.exe` on Windows) and a ~136 MB `runtime.node` next to it.
//     The wrapper is what a transport launches; it needs its siblings.
//   • The SDK ships NO checksum or release manifest for it. Its README names a
//     release asset `github-copilot-<version>-<platform>.tgz` and "checksum and
//     package downloads" at `github/copilot-cli` `v<version>` (or
//     `github/copilot-sdk` `runtime-<version>`), but the file name and format of
//     that checksum are not in the package and were not verified. The npm
//     registry publishes an integrity value (sha512) for each platform package,
//     which is a different digest of a different artifact.
//
// THEREFORE (the gap, stated plainly): there is no manifest this module can
// trust by default, so a download needs the expected SHA-256 from the HOST
// (`download.sha256`, pinned at build time next to the URL it belongs to) or
// from a manifest the host points at (`download.manifestUrl`). A manifest on the
// same origin as the file proves the transfer was intact, not that the host
// serving both is honest; a pinned `sha256` does. Prefer the bundled runtime
// (`bundledRuntimePath`): the app's own signature then covers it.
//
// RULES:
//   • A bundled runtime is preferred. A bundled runtime that is missing or fails
//     its checksum is an error, never a silent fall back to a download.
//   • A download happens only when `download` is present (the user's explicit
//     opt-in) and only from `download.allowedHosts`: https only, no credentials
//     in the URL, the default port, an exact hostname match (no wildcard), and
//     every redirect hop checked the same way. A refused host throws BEFORE any
//     network call.
//   • The file is written to a temporary name beside its destination, hashed as
//     it is written, compared to the expected SHA-256, and only then renamed
//     into place. A mismatch deletes the partial file.
//   • `workingDirectory` is created EMPTY on every call (leftovers are removed),
//     so no AGENTS.md, CLAUDE.md, skill or MCP configuration is ever discovered
//     from it.
//   • Nothing here holds or logs a token. Every message is passed through
//     `redactTokens`; a URL's query string and fragment never appear in one.
// =============================================================================

/**
 * The Copilot runtime version that `@github/copilot-sdk@1.0.22` pins
 * (`copilotCliVersion` in its `package.json`). The version reported for a
 * bundled runtime unless the host says otherwise.
 *
 * @stability experimental
 */
export const COPILOT_RUNTIME_VERSION = '1.0.98';

/** Directory names under `dataDirectory`. */
const HOME_DIR = 'home';
const WORK_DIR = 'work';
const RUNTIME_DIR = 'runtime';
/** The record a finished install leaves in its directory. */
const RECORD_FILE = 'installed.json';

/** The most redirect hops followed. */
const MAX_REDIRECTS = 5;
/** The default largest download: the runtime is 133-174 MB unpacked. */
const DEFAULT_MAX_BYTES = 768 * 1024 * 1024;
/** A version or file name that is safe as one path segment. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The file-system calls {@link prepareCopilotRuntime} makes, so a test can
 * replace them. The default is `node:fs` and `node:fs/promises`.
 *
 * @stability experimental
 */
export interface CopilotRuntimeFs {
  /** `fs.promises.mkdir` (always recursive). */
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  /** `fs.promises.rm` (always recursive and forced). */
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  /** `fs.promises.stat`. */
  stat(path: string): Promise<{ isFile(): boolean; size: number }>;
  /** `fs.promises.readFile` as UTF-8 text. */
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  /** `fs.promises.writeFile` of UTF-8 text. */
  writeFile(path: string, data: string): Promise<void>;
  /** `fs.promises.rename`. */
  rename(from: string, to: string): Promise<void>;
  /** `fs.promises.chmod`. */
  chmod(path: string, mode: number): Promise<void>;
  /** `fs.promises.open` for exclusive writing (`wx`). */
  open(path: string, flags: 'wx'): Promise<{ write(data: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
  /** `fs.createReadStream`, as the chunks it yields. */
  createReadStream(path: string): AsyncIterable<Uint8Array | string>;
}

/**
 * What a manifest (`download.manifestUrl`) must say: JSON with exactly these
 * fields. Not a GitHub format (the SDK publishes none we could verify): the
 * shape a host publishes next to its own copy of the runtime.
 *
 * @stability experimental
 */
export interface CopilotRuntimeManifest {
  /** The runtime version (`1.0.98`); one safe path segment. */
  version: string;
  /** The https URL of the file; its host must be in `allowedHosts`. */
  url: string;
  /** The file's SHA-256, 64 lowercase hex characters (an optional `sha256:` prefix is accepted). */
  sha256: string;
}

/**
 * The first-opt-in download. Its mere presence is the opt-in: the host passes it
 * only after the user agreed.
 *
 * @remarks
 * Give EITHER `url` and `sha256` (a pin the host controls, the strong form) OR
 * `manifestUrl` (a JSON {@link CopilotRuntimeManifest}, same origin rules).
 *
 * @stability experimental
 */
export interface CopilotRuntimeDownload {
  /** Exact hostnames the file, the manifest and every redirect may use. Empty refuses everything. */
  allowedHosts: readonly string[];
  /** Called as bytes arrive (and once at the start, with `received: 0`). A throw is ignored. */
  onProgress?(p: { received: number; total?: number }): void;
  /** The https URL of the file. */
  url?: string;
  /** The file's expected SHA-256 (64 hex characters; an optional `sha256:` prefix is accepted). */
  sha256?: string;
  /** The runtime version the file is (`1.0.98`); defaults to {@link COPILOT_RUNTIME_VERSION}. */
  version?: string;
  /** The https URL of a JSON {@link CopilotRuntimeManifest}, instead of `url` and `sha256`. */
  manifestUrl?: string;
  /**
   * Unpacks a downloaded archive. The official artifact is a `.tgz` of a bundle
   * (wrapper plus `runtime.node`), and node has no tar: the host passes its own
   * extractor. It receives the verified archive and an empty directory and
   * returns the runtime wrapper's path (absolute, or relative to that
   * directory). Without it the downloaded file IS the runtime.
   */
  extract?(archivePath: string, destinationDirectory: string): Promise<string>;
  /** Refuses a file larger than this many bytes (default 768 MiB). */
  maxBytes?: number;
  /** Cancels the download. */
  signal?: AbortSignal;
}

/**
 * Options of {@link prepareCopilotRuntime}.
 *
 * @stability experimental
 */
export interface CopilotRuntimeOptions {
  /** The host's app-private directory for Copilot, for example `<userData>/copilot`. */
  dataDirectory: string;
  /** The runtime wrapper the host ships (`asarUnpack` or `extraResources`). Preferred over a download. */
  bundledRuntimePath?: string;
  /** The bundled file's expected SHA-256; else a sibling `<path>.sha256` file is read if it exists. */
  bundledSha256?: string;
  /** The version of the bundled runtime; defaults to {@link COPILOT_RUNTIME_VERSION}. */
  bundledVersion?: string;
  /** The first-opt-in download; absent means "never download". */
  download?: CopilotRuntimeDownload;
  /** Replaces the global `fetch` (tests, a proxy-aware client). */
  fetch?: typeof fetch;
  /** Replaces the file-system calls (tests). */
  fs?: CopilotRuntimeFs;
}

/**
 * What {@link prepareCopilotRuntime} hands the transport.
 *
 * @stability experimental
 */
export interface PreparedCopilotRuntime {
  /** The runtime wrapper to launch. */
  runtimePath: string;
  /** `baseDirectory` for `createSdkCopilotTransport`: Copilot's private home. */
  baseDirectory: string;
  /** `workingDirectory` for `createSdkCopilotTransport`: EMPTY. */
  workingDirectory: string;
  /** The runtime version. */
  version: string;
  /** Where it came from: shipped by the host, downloaded now, or reused from an earlier download. */
  source: 'bundled' | 'downloaded' | 'cached';
  /** Whether a checksum was checked (false only for a bundled file with no expected value). */
  verified: boolean;
}

const defaultFs: CopilotRuntimeFs = {
  mkdir: (p, o) => fsp.mkdir(p, o),
  rm: (p, o) => fsp.rm(p, o),
  stat: (p) => fsp.stat(p),
  readFile: (p, e) => fsp.readFile(p, e),
  writeFile: (p, d) => fsp.writeFile(p, d),
  rename: (a, b) => fsp.rename(a, b),
  chmod: (p, m) => fsp.chmod(p, m),
  open: (p, f) => fsp.open(p, f),
  createReadStream: (p) => createReadStream(p),
};

/**
 * Creates Copilot's private directories (an EMPTY working directory), resolves
 * the runtime (bundled first, else an opt-in download from allowed hosts only),
 * verifies its SHA-256 and returns what `createSdkCopilotTransport` needs.
 *
 * @remarks
 * Layout under `dataDirectory`: `home/` (`baseDirectory`), `work/`
 * (`workingDirectory`, emptied on every call) and `runtime/<version>/` (a
 * downloaded runtime and its `installed.json` record). A download that is
 * already installed (same SHA-256 recorded, file present) is reused without
 * touching the network; a downloaded single file is re-hashed on reuse.
 *
 * Failures are `AiError`s: `AI_INVALID_REQUEST` for options that are wrong or a
 * host that is not allowed (thrown before any network call), and
 * `AI_PROVIDER_UNAVAILABLE` (`details.check` names which: `runtime_missing`,
 * `checksum_mismatch`, `download_failed`, `download_too_large`) for the rest.
 * No message carries a token or a URL's query string.
 *
 * @example
 * ```ts
 * const rt = await prepareCopilotRuntime({
 *   dataDirectory: join(app.getPath('userData'), 'copilot'),
 *   bundledRuntimePath: join(process.resourcesPath, 'copilot', 'copilot-runtime'),
 * });
 * const transport = createSdkCopilotTransport({
 *   baseDirectory: rt.baseDirectory,
 *   workingDirectory: rt.workingDirectory,
 * });
 * ```
 *
 * @param o - the directory, the bundled path and the optional download.
 * @returns the runtime path, the two directories and the version.
 * @throws AiError as described above.
 * @stability experimental
 */
export async function prepareCopilotRuntime(o: CopilotRuntimeOptions): Promise<PreparedCopilotRuntime> {
  try {
    return await prepare(o);
  } catch (err) {
    // Our own AiErrors pass through; anything else (an fs failure) is redacted.
    throw copilotErrorFromThrown(err);
  }
}

async function prepare(o: CopilotRuntimeOptions): Promise<PreparedCopilotRuntime> {
  const fs = o.fs ?? defaultFs;
  if (typeof o.dataDirectory !== 'string' || o.dataDirectory.trim() === '' || !isAbsolute(o.dataDirectory)) {
    throw invalid('dataDirectory must be an absolute path.', 'data_directory');
  }
  const dataDirectory = resolve(o.dataDirectory);
  const baseDirectory = join(dataDirectory, HOME_DIR);
  const workingDirectory = join(dataDirectory, WORK_DIR);

  // Option mistakes are reported before a single directory is touched, and
  // before any network call.
  const plan = o.download ? planDownload(o.download) : undefined;
  const bundledSha = o.bundledSha256 !== undefined ? normalizeSha(o.bundledSha256, 'bundledSha256') : undefined;
  const bundledVersion = o.bundledVersion ?? COPILOT_RUNTIME_VERSION;
  if (o.bundledRuntimePath !== undefined) assertSegment(bundledVersion, 'bundledVersion');

  await fs.mkdir(baseDirectory, { recursive: true });
  // Empty even when it existed with leftovers.
  await fs.rm(workingDirectory, { recursive: true, force: true });
  await fs.mkdir(workingDirectory, { recursive: true });

  if (o.bundledRuntimePath !== undefined) {
    const verified = await verifyBundled(fs, o.bundledRuntimePath, bundledSha);
    return {
      runtimePath: o.bundledRuntimePath,
      baseDirectory,
      workingDirectory,
      version: bundledVersion,
      source: 'bundled',
      verified,
    };
  }

  if (!plan || !o.download) {
    throw new AiError(
      'AI_PROVIDER_UNAVAILABLE',
      'GitHub Copilot: no runtime is available. Ship it with the app (bundledRuntimePath) or opt in to the download.',
      { details: { check: 'runtime_missing' } },
    );
  }

  const fetchImpl = o.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw invalid('No fetch is available to download the runtime.', 'fetch');
  const resolved = await resolveTarget(plan, o.download, fetchImpl);
  const installed = await installDownload({
    fs,
    fetchImpl,
    download: o.download,
    target: resolved,
    runtimeRoot: join(dataDirectory, RUNTIME_DIR),
  });
  return { ...installed, baseDirectory, workingDirectory, version: resolved.version, verified: true };
}

// --- bundled -----------------------------------------------------------------

async function verifyBundled(fs: CopilotRuntimeFs, path: string, given: string | undefined): Promise<boolean> {
  let st: { isFile(): boolean; size: number };
  try {
    st = await fs.stat(path);
  } catch {
    throw missing('The bundled Copilot runtime is missing.');
  }
  if (!st.isFile() || st.size === 0) throw missing('The bundled Copilot runtime is missing or empty.');

  let expected = given;
  if (expected === undefined) {
    try {
      expected = normalizeSha((await fs.readFile(`${path}.sha256`, 'utf8')).trim().split(/\s+/)[0] ?? '', 'sha256 file');
    } catch (err) {
      // No sibling file is "no expected value"; a sibling that is malformed is an error.
      if (AiError.isAiError(err)) throw err;
      return false;
    }
  }
  const actual = await sha256OfFile(fs, path);
  if (actual !== expected) throw mismatch('The bundled Copilot runtime does not match its checksum.');
  return true;
}

// --- download: planning and host policy -------------------------------------------

interface Plan {
  hosts: ReadonlySet<string>;
  url?: URL;
  sha256?: string;
  version?: string;
  manifestUrl?: URL;
  maxBytes: number;
}

function planDownload(d: CopilotRuntimeDownload): Plan {
  if (!Array.isArray(d.allowedHosts)) throw invalid('download.allowedHosts must be a list of hostnames.', 'allowed_hosts');
  const hosts = new Set(d.allowedHosts.map((h) => String(h).trim().toLowerCase()).filter((h) => h !== ''));
  if (hosts.size === 0) throw refusedHost('download.allowedHosts is empty: nothing may be downloaded.', undefined);
  const hasPin = d.url !== undefined || d.sha256 !== undefined;
  if (hasPin === (d.manifestUrl !== undefined)) {
    throw invalid('Give download.url with download.sha256, or download.manifestUrl, not both and not neither.', 'download_source');
  }
  const maxBytes = d.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw invalid('download.maxBytes must be positive.', 'max_bytes');

  if (d.manifestUrl !== undefined) {
    return { hosts, manifestUrl: assertAllowedUrl(d.manifestUrl, hosts), maxBytes };
  }
  if (d.url === undefined || d.sha256 === undefined) {
    throw invalid('download.url and download.sha256 go together.', 'download_source');
  }
  const version = d.version ?? COPILOT_RUNTIME_VERSION;
  assertSegment(version, 'download.version');
  return { hosts, url: assertAllowedUrl(d.url, hosts), sha256: normalizeSha(d.sha256, 'download.sha256'), version, maxBytes };
}

/** https, no credentials, default port, exact host match. Throws before any network call. */
function assertAllowedUrl(raw: string, hosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('A download URL is not a valid URL.', 'url');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw refusedHost(`Refusing a non-https download (host ${safeHost(host)}).`, host);
  if (url.username !== '' || url.password !== '') throw refusedHost('Refusing a download URL that carries credentials.', host);
  if (url.port !== '') throw refusedHost(`Refusing a download from a non-default port (host ${safeHost(host)}).`, host);
  if (!hosts.has(host)) throw refusedHost(`Refusing to download from ${safeHost(host)}: not in allowedHosts.`, host);
  return url;
}

interface Target {
  url: URL;
  sha256: string;
  version: string;
}

async function resolveTarget(plan: Plan, d: CopilotRuntimeDownload, fetchImpl: typeof fetch): Promise<Target> {
  if (plan.url && plan.sha256 && plan.version) return { url: plan.url, sha256: plan.sha256, version: plan.version };
  if (!plan.manifestUrl) throw invalid('No download source.', 'download_source');

  const res = await fetchChecked(fetchImpl, plan.manifestUrl, plan.hosts, d.signal);
  if (!res.ok) throw downloadFailed(`The runtime manifest request failed (status ${res.status}).`);
  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw downloadFailed('The runtime manifest is not valid JSON.');
  }
  const m = json as Partial<CopilotRuntimeManifest> | null;
  if (!m || typeof m.version !== 'string' || typeof m.url !== 'string' || typeof m.sha256 !== 'string') {
    throw downloadFailed('The runtime manifest must carry version, url and sha256.');
  }
  assertSegment(m.version, 'manifest version');
  return { url: assertAllowedUrl(m.url, plan.hosts), sha256: normalizeSha(m.sha256, 'manifest sha256'), version: m.version };
}

/** fetch with manual redirects: every hop is checked against the allowed hosts before it is requested. */
async function fetchChecked(
  fetchImpl: typeof fetch,
  first: URL,
  hosts: ReadonlySet<string>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  let url = first;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res: Response;
    try {
      res = await fetchImpl(url.href, { redirect: 'manual', ...(signal ? { signal } : {}) });
    } catch (err) {
      if (signal?.aborted) throw downloadFailed('The download was cancelled.');
      throw downloadFailed(`The download from ${safeHost(url.hostname)} failed: ${errorText(err)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw downloadFailed('A redirect carried no location.');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw downloadFailed('A redirect carried an invalid location.');
      }
      // Refuses a redirect to another host (or http) before it is requested.
      url = assertAllowedUrl(next.href, hosts);
      continue;
    }
    return res;
  }
  throw downloadFailed('Too many redirects.');
}

// --- download: install --------------------------------------------------------------

interface InstallInput {
  fs: CopilotRuntimeFs;
  fetchImpl: typeof fetch;
  download: CopilotRuntimeDownload;
  target: Target;
  runtimeRoot: string;
}

async function installDownload(i: InstallInput): Promise<{ runtimePath: string; source: 'downloaded' | 'cached' }> {
  const { fs, target } = i;
  const dir = join(i.runtimeRoot, target.version);

  const cached = await cachedRuntime(fs, dir, target.sha256, i.download.extract !== undefined);
  if (cached) return { runtimePath: cached, source: 'cached' };

  await fs.mkdir(i.runtimeRoot, { recursive: true });
  const nonce = randomBytes(6).toString('hex');
  const partial = join(i.runtimeRoot, `.dl-${nonce}.part`);
  const staging = join(i.runtimeRoot, `.stage-${nonce}`);
  try {
    await downloadTo(i, partial);
    await fs.mkdir(staging, { recursive: true });

    let relative: string;
    if (i.download.extract) {
      const out = await i.download.extract(partial, staging);
      relative = relativeInside(staging, out);
      await fs.rm(partial, { recursive: true, force: true });
    } else {
      relative = fileNameOf(target.url);
      await fs.rename(partial, join(staging, relative));
    }
    const runtime = join(staging, relative);
    const st = await fs.stat(runtime).catch(() => undefined);
    if (!st || !st.isFile()) throw missing('The downloaded Copilot runtime has no runtime file at the expected path.');
    await fs.chmod(runtime, 0o755);
    await fs.writeFile(join(staging, RECORD_FILE), JSON.stringify({ sha256: target.sha256, runtime: relative.split(sep).join('/') }));

    // Atomic: the version directory appears whole or not at all.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(staging, dir);
    return { runtimePath: join(dir, relative), source: 'downloaded' };
  } finally {
    await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The runtime path of an earlier install of exactly this SHA-256, or undefined. */
async function cachedRuntime(fs: CopilotRuntimeFs, dir: string, sha: string, extracted: boolean): Promise<string | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(join(dir, RECORD_FILE), 'utf8')) as { sha256?: unknown; runtime?: unknown };
    if (record.sha256 !== sha || typeof record.runtime !== 'string') return undefined;
    const runtime = join(dir, ...record.runtime.split('/'));
    relativeInside(dir, runtime);
    const st = await fs.stat(runtime);
    if (!st.isFile() || st.size === 0) return undefined;
    // An archive is gone after extraction, so only a single file can be re-hashed.
    if (!extracted && (await sha256OfFile(fs, runtime)) !== sha) return undefined;
    return runtime;
  } catch {
    return undefined;
  }
}

async function downloadTo(i: InstallInput, partial: string): Promise<void> {
  const { fs, target, download } = i;
  const hosts = new Set(download.allowedHosts.map((h) => h.trim().toLowerCase()));
  const maxBytes = download.maxBytes ?? DEFAULT_MAX_BYTES;
  const res = await fetchChecked(i.fetchImpl, target.url, hosts, download.signal);
  if (!res.ok || !res.body) throw downloadFailed(`The runtime download failed (status ${res.status}).`);

  const lengthHeader = Number(res.headers.get('content-length'));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined;
  if (total !== undefined && total > maxBytes) {
    await res.body.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const progress = (received: number): void => {
    try {
      download.onProgress?.({ received, ...(total !== undefined ? { total } : {}) });
    } catch {
      /* a progress callback must never break the download */
    }
  };
  progress(0);

  const hash = createHash('sha256');
  const file = await fs.open(partial, 'wx');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      hash.update(value);
      await file.write(value);
      progress(received);
    }
  } catch (err) {
    await file.close().catch(() => undefined);
    await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
    if (AiError.isAiError(err)) throw err;
    if (download.signal?.aborted) throw downloadFailed('The download was cancelled.');
    throw downloadFailed(`The runtime download was interrupted: ${errorText(err)}`);
  }
  await file.close();

  if (hash.digest('hex') !== target.sha256) {
    await fs.rm(partial, { recursive: true, force: true });
    throw mismatch('The downloaded Copilot runtime does not match its checksum; it was deleted.');
  }
}

// --- helpers ---------------------------------------------------------------------------

async function sha256OfFile(fs: CopilotRuntimeFs, path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function normalizeSha(raw: string, label: string): string {
  const value = String(raw).trim().toLowerCase().replace(/^sha256:/, '');
  if (!SHA256_HEX.test(value)) throw invalid(`${label} must be 64 hexadecimal characters (SHA-256).`, 'sha256');
  return value;
}

function assertSegment(value: string, label: string): void {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw invalid(`${label} must be a plain version string such as 1.0.98.`, 'version');
  }
}

/** The last path segment of the URL when it is safe as a file name, else `copilot-runtime`. */
function fileNameOf(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  return SAFE_SEGMENT.test(last) && !last.includes('..') ? last : 'copilot-runtime';
}

/** `candidate` relative to `root`; throws when it escapes `root` (a hostile archive or record). */
function relativeInside(root: string, candidate: string): string {
  const abs = resolve(root, candidate);
  const prefix = resolve(root) + sep;
  if (!abs.startsWith(prefix)) {
    throw missing('The runtime path points outside its install directory.');
  }
  return abs.slice(prefix.length);
}

/** A hostname for a message: letters, digits, dots, dashes only. */
function safeHost(host: string): string {
  return redactTokens(host.replace(/[^A-Za-z0-9.-]/g, '?').slice(0, 100));
}

function errorText(err: unknown): string {
  return redactTokens(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

const message = (text: string): string => `GitHub Copilot: ${redactTokens(text)}`;

function invalid(text: string, check: string): AiError {
  return new AiError('AI_INVALID_REQUEST', message(text), { details: { check } });
}

function refusedHost(text: string, host: string | undefined): AiError {
  return new AiError('AI_INVALID_REQUEST', message(text), {
    details: { check: 'download_host_refused', ...(host ? { host: safeHost(host) } : {}) },
  });
}

function missing(text: string): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', message(text), { details: { check: 'runtime_missing' } });
}

function mismatch(text: string): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', message(text), { details: { check: 'checksum_mismatch' } });
}

function downloadFailed(text: string): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', message(text), { details: { check: 'download_failed' } });
}

function tooLarge(): AiError {
  return new AiError('AI_PROVIDER_UNAVAILABLE', message('The runtime download is larger than allowed.'), {
    details: { check: 'download_too_large' },
  });
}

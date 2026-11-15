// =============================================================================
// The voice model download, probed without downloading it  (issue #831)
// =============================================================================
//
// The speaker voiceprint model (about 30 MB) is fetched once from the URL below
// and checked against a SHA-256 pinned in `@marinoscar/kvox-ai`. A host or an api
// container that cannot reach it never gets voice matching, and the failure used
// to surface only inside a queue job. This module answers "can it?" with a
// one-byte ranged GET, following redirects by hand and refusing any hop that is
// not on the allowlist, the same rule the downloader enforces.
//
// THE CONSTANTS ARE COPIES, ON PURPOSE. This CLI is installed on a server from
// the monorepo's `apps/cli` workspace alone (install.sh), so it cannot depend on
// `@marinoscar/kvox-ai`. `voiceprint-egress.test.ts` fails when either value
// drifts from `packages/kvox-ai/src/voiceprints/voiceprint-files.ts`.
//
// A probe never prints or returns a URL: reasons are short fixed phrases, so no
// signed redirect target (a query string) reaches the doctor output or a log.
// =============================================================================

/** The pinned model file (`VOICEPRINT_MANIFEST`). The release tag's spelling is upstream's. */
export const VOICEPRINT_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx';

/** The hosts the download may contact (`VOICEPRINT_DOWNLOAD_HOSTS`). */
export const VOICEPRINT_DOWNLOAD_HOSTS: readonly string[] = [
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
];

/** What an operator must allow through an egress filter. */
export const VOICEPRINT_REQUIRED_HOSTS = 'github.com and release-assets.githubusercontent.com';

/** Per-probe budget. */
export const EGRESS_PROBE_TIMEOUT_MS = 10_000;

/** The redirects followed before giving up (GitHub uses one). */
const MAX_REDIRECTS = 5;

/** The verdict of one probe: `reason` is a fixed short phrase, never a URL. */
export interface EgressProbeResult {
  ok: boolean;
  reason?: string | undefined;
}

/** A probe of the model URL from wherever it runs; a seam for the tests. */
export type EgressProbe = (url: string, hosts: readonly string[], timeoutMs: number) => Promise<EgressProbeResult>;

/** The minimal response a probe reads. */
export interface ProbeResponse {
  status: number;
  location: string | null;
  cancel(): Promise<void> | void;
}

/** `fetch` as the host probe uses it (redirects manual); a seam for the tests. */
export type ProbeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<ProbeResponse>;

const realFetch: ProbeFetch = async (url, init) => {
  const response = await fetch(url, { method: 'GET', headers: init.headers, signal: init.signal, redirect: 'manual' });
  return {
    status: response.status,
    location: response.headers.get('location'),
    cancel: () => response.body?.cancel(),
  };
};

/** The host probe: a ranged GET of one byte, redirects restricted to `hosts`. */
export function createHostEgressProbe(fetchImpl: ProbeFetch = realFetch): EgressProbe {
  return async (url, hosts, timeoutMs) => {
    const allowed = new Set(hosts.map((host) => host.toLowerCase()));
    const signal = AbortSignal.timeout(timeoutMs);
    let current = url;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:') return { ok: false, reason: 'a redirect left https' };
        if (!allowed.has(parsed.hostname.toLowerCase())) {
          return { ok: false, reason: `a redirect went to a host that is not allowed (${parsed.hostname.replace(/[^A-Za-z0-9.-]/g, '?').slice(0, 80)})` };
        }
        const response = await fetchImpl(current, { headers: { Range: 'bytes=0-0' }, signal });
        await response.cancel();
        if (response.status >= 300 && response.status < 400 && response.location !== null) {
          current = new URL(response.location, current).toString();
          continue;
        }
        return response.status === 200 || response.status === 206
          ? { ok: true }
          : { ok: false, reason: `the server answered ${response.status}` };
      }
      return { ok: false, reason: 'too many redirects' };
    } catch (error) {
      const name = (error as { name?: unknown }).name;
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'the connection failed' };
    }
  };
}

/** The probe the host runs. */
export const hostEgressProbe: EgressProbe = createHostEgressProbe();

/**
 * The same probe as a script for `docker exec <api> node -e <script> <url> <timeoutMs> <hosts...>`:
 * the api image has Node 24 with a global `fetch`. It prints one JSON line,
 * `{"ok":true}` or `{"ok":false,"reason":"..."}`, and never a URL.
 */
export const CONTAINER_EGRESS_SCRIPT = `
const [url, timeout, ...hosts] = process.argv.slice(1);
const allowed = new Set(hosts.map((h) => h.toLowerCase()));
const signal = AbortSignal.timeout(Number(timeout));
const out = (v) => { console.log(JSON.stringify(v)); };
(async () => {
  let current = url;
  for (let hop = 0; hop <= ${MAX_REDIRECTS}; hop += 1) {
    const u = new URL(current);
    if (u.protocol !== 'https:') return out({ ok: false, reason: 'a redirect left https' });
    if (!allowed.has(u.hostname.toLowerCase())) return out({ ok: false, reason: 'a redirect went to a host that is not allowed (' + u.hostname.replace(/[^A-Za-z0-9.-]/g, '?').slice(0, 80) + ')' });
    const r = await fetch(current, { headers: { Range: 'bytes=0-0' }, signal, redirect: 'manual' });
    await r.body?.cancel();
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { current = new URL(loc, current).toString(); continue; }
    return out(r.status === 200 || r.status === 206 ? { ok: true } : { ok: false, reason: 'the server answered ' + r.status });
  }
  return out({ ok: false, reason: 'too many redirects' });
})().catch((e) => out({ ok: false, reason: e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timed out' : 'the connection failed' }));
`;

/** The argv that runs {@link CONTAINER_EGRESS_SCRIPT} for the pinned model URL. */
export function containerEgressArgv(timeoutMs: number = EGRESS_PROBE_TIMEOUT_MS): string[] {
  return ['node', '-e', CONTAINER_EGRESS_SCRIPT, VOICEPRINT_MODEL_URL, String(timeoutMs), ...VOICEPRINT_DOWNLOAD_HOSTS];
}

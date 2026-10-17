import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// =============================================================================
// NO DIRECT VENDOR HOST (issue #477, epic #472)
// =============================================================================
//
// This app used to carry a hand-written OpenAI client over `fetch`: it imported no SDK, so the
// platform's `ai-no-sdk-leak` suite (which reads import specifiers) could not see it. A model call
// now goes through the platform AI slice only, which owns every vendor endpoint. This guard reads
// TEXT, not imports: no file under `apps/api/src`, `apps/cli/src`, `packages/kvox-api/src` or `packages/kvox-ai/src`
// (specs included) names a provider's API host, as a URL, a default or a fixture. `packages/kvox-ai` holds the
// model mechanics that moved out of `apps/api/src/ai-port/` (#579); it reaches a provider only through a
// host-supplied runtime, so it names no host either.
//
// A failure names the file and the host. Do not add an exception: route the call through `KVOX_AI`
// (`apps/api/src/ai-port/`), and let the administrator configure an endpoint in the AI settings.
// =============================================================================

const REPO = resolve(__dirname, '../../../..');
const ROOTS = ['apps/api/src', 'apps/cli/src', 'packages/kvox-api/src', 'packages/kvox-ai/src'];

const VENDOR_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'] as const;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

describe('no direct vendor host (#477)', () => {
  const files = ROOTS.flatMap((root) => walk(join(REPO, root)));

  it('scans a non-trivial tree, so a mistyped root cannot pass on nothing', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((file) => file.includes(`${sep}ai-port${sep}`))).toBe(true);
    expect(files.some((file) => file.includes(`${sep}kvox-ai${sep}src${sep}`))).toBe(true);
  });

  it.each(VENDOR_HOSTS)('no file under apps/api/src, apps/cli/src, packages/kvox-api/src or packages/kvox-ai/src contains %s', (host) => {
    const offenders = files
      .filter((file) => readFileSync(file, 'utf8').includes(host))
      .map((file) => relative(REPO, file).split(sep).join('/'));

    expect(offenders).toEqual([]);
  });

  it('the guard recognises a host in text (it is not matching nothing)', () => {
    const sample = 'const url = "https://api.openai.com/v1/responses";';

    expect(VENDOR_HOSTS.filter((host) => sample.includes(host))).toEqual(['api.openai.com']);
  });
});

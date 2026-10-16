// =============================================================================
// The storage-table boundary (issue #469)
// =============================================================================
//
// `storage_objects` and `storage_object_chunks` are the platform's org tables
// under forced row-level security. KVox's domain code reaches them through ONE
// service, `KvoxManagedObjects` (`src/kvox-objects/`), which runs every
// statement under `runInOrg` (or the caller's job transaction) and writes the
// ownership marker (`kvox_object_ownership`) in the same transaction.
//
// This is the grep-based tripwire that keeps it so, in the style of the
// platform's own `system-injection-boundary` spec: it scans every non-test
// source file under `src/` and fails when one outside the allowlist names the
// `storageObject` / `storageObjectChunk` delegates. A raw `prisma.storageObject`
// elsewhere would bypass the org scope and the ownership rules (a managed
// object listed, deleted or sized by the wrong module).
//
// WHAT IS ALLOWED, AND WHY
//   * `src/kvox-objects/**`: the gateway itself.
//   * the two platform BINDINGS below, which the platform's ports require to
//     read an object row (an avatar check, a node job's input object). They
//     are bindings, not domain code.
// Add to the allowlist only with a reason, in review.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

/** Files (relative to `src/`, POSIX separators) that may name the delegates, each with its reason. */
const ALLOWED_FILES: Readonly<Record<string, string>> = {
  'platform/settings/settings-profile-images.adapter.ts':
    'SETTINGS_PROFILE_IMAGES binding: reads one avatar row inside runInOrg',
  'platform/jobs/node-job-inputs.adapter.ts':
    'NODE_JOB_INPUTS binding: resolves a held job\'s input object through the platform helper inside JobScope.run',
};

/** Directory prefixes that may name the delegates. */
const ALLOWED_DIRS: readonly string[] = ['kvox-objects/'];

const DELEGATE = /\bstorageObject(?:Chunk)?\b/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith('.ts') && !full.endsWith('.spec.ts') && !full.endsWith('.d.ts')) {
      yield full;
    }
  }
}

/** Source with block and line comments removed, so prose that mentions a delegate is not a use. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

describe('storage table boundary (#469)', () => {
  const offenders: string[] = [];

  for (const file of walk(SRC_ROOT)) {
    const rel = posix(relative(SRC_ROOT, file));
    if (ALLOWED_DIRS.some((dir) => rel.startsWith(dir)) || rel in ALLOWED_FILES) continue;

    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (DELEGATE.test(line)) offenders.push(`${rel}:${index + 1}: ${line.trim()}`);
    });
  }

  it('no file outside src/kvox-objects/ and the platform bindings names storageObject or storageObjectChunk', () => {
    expect(offenders).toEqual([]);
  });

  it('the allowlisted binding files exist (a rename must update the allowlist)', () => {
    for (const rel of Object.keys(ALLOWED_FILES)) {
      expect(() => statSync(join(SRC_ROOT, ...rel.split('/')))).not.toThrow();
    }
  });

  describe('stripComments', () => {
    it('ignores a delegate named only in a comment', () => {
      const code = "// prisma.storageObject.find\n/* tx.storageObject */\nconst a = 1;";
      expect(DELEGATE.test(stripComments(code))).toBe(false);
    });

    it('still sees a real use', () => {
      expect(DELEGATE.test(stripComments('const r = await tx.storageObject.findMany({});'))).toBe(true);
      expect(DELEGATE.test(stripComments("Pick<PrismaClient, 'storageObjectChunk'>"))).toBe(true);
    });
  });
});

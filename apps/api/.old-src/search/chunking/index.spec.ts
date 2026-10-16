// =============================================================================
// ⚠ THE CHUNKER IS PURE (issue #186, epic #165)
// =============================================================================
//
// `chunk.types.ts`'s header states the rule and the argument: content
// addressing only buys anything if the same input produces byte-identical
// chunks every time, which means nothing in this directory may read a clock, a
// random source, a database, mutable module state or a locale.
//
// This file is the executable form of that rule, in the same spirit as
// `apps/api/test/jobs/cron-enqueue-only.spec.ts`. It is structural for the same
// reason that test is: THE REGRESSION IS INVISIBLE FROM INSIDE THE FILE THAT
// CAUSES IT. Somebody in 2027 adds `@Injectable()` and a constructor so the
// chunker can read a setting, every existing test still passes — the chunking is
// still correct, nothing crashes — and the only symptom is that the budget now
// varies by deployment, so a chunk's hash does too, so an unchanged document
// looks entirely edited on every pass and the incremental re-index silently
// degrades into a full re-embed of the corpus, billed to the owner, forever.
//
// What it honestly cannot check: a pure-looking helper imported from outside
// this directory that is itself impure. The import list below is the guard for
// that — this directory is allowed `node:crypto` and its own files, and nothing
// else. Widening that list is a pull request that has to argue for it.
// =============================================================================

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as chunking from './index';

const sourceFiles = readdirSync(__dirname)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
  .sort();

const read = (name: string): string => readFileSync(join(__dirname, name), 'utf8');

/**
 * A file's real code, with comments stripped. The headers in this directory
 * argue at length ABOUT the forbidden things, naming every one of them, so a
 * scan over raw text would fail on the very prose that states the rule.
 */
const code = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

/** Everything this directory may import. */
const ALLOWED_IMPORTS = ['node:crypto'];

/**
 * Markers of impurity. Each is a thing that would make a chunk's hash a
 * function of something other than the document's text.
 */
const FORBIDDEN = [
  // Dependency injection: one constructor parameter from holding a repository.
  { pattern: /@nestjs\//, why: 'a NestJS import' },
  { pattern: /@Injectable\s*\(/, why: 'an @Injectable decorator' },
  // The database.
  { pattern: /PrismaService|@prisma\/client/, why: 'a Prisma dependency' },
  // Non-determinism.
  { pattern: /randomUUID|Math\.random|crypto\.randomBytes/, why: 'a random source' },
  { pattern: /Date\.now|new Date\(|performance\.now/, why: 'a clock' },
  // Ambient configuration: the budget must not vary by deployment.
  { pattern: /process\.env/, why: 'an environment read' },
  // Locale: a boundary that moves with LANG is a hash that moves with LANG.
  { pattern: /localeCompare|toLocale[A-Z]|\bIntl\./, why: 'a locale-dependent operation' },
  // Dynamic loading, which would defeat the import allowlist below.
  { pattern: /\brequire\s*\(|\bimport\s*\(/, why: 'a dynamic import' },
];

describe('the chunking directory is pure', () => {
  it('has the files this module is documented to have', () => {
    expect(sourceFiles).toEqual([
      'chunk-packer.ts',
      'chunk.types.ts',
      'content-hash.ts',
      'index.ts',
      'note-chunker.ts',
      'transcript-chunker.ts',
    ]);
  });

  it.each(sourceFiles)('%s contains no marker of impurity', (name) => {
    const body = code(name);
    for (const { pattern, why } of FORBIDDEN) {
      expect({ name, why, found: pattern.test(body) }).toEqual({
        name,
        why,
        found: false,
      });
    }
  });

  it.each(sourceFiles)('%s imports only from this directory or node:crypto', (name) => {
    const specifiers = [...code(name).matchAll(/from\s+'([^']+)'/g)].map(
      (match) => match[1],
    );
    for (const specifier of specifiers) {
      const permitted =
        specifier.startsWith('./') || ALLOWED_IMPORTS.includes(specifier);
      expect({ name, specifier, permitted }).toEqual({
        name,
        specifier,
        permitted: true,
      });
    }
  });

  it('declares no module-level mutable state', () => {
    for (const name of sourceFiles) {
      const moduleLevel = code(name)
        .split('\n')
        .filter((line) => /^(let|var)\s/.test(line));
      expect({ name, moduleLevel }).toEqual({ name, moduleLevel: [] });
    }
  });
});

describe('the public surface', () => {
  it('exports the chunkers, the hashes, the budgets and the reconstructions', () => {
    for (const name of [
      'chunkTranscript',
      'chunkNote',
      'contentHash',
      'fingerprintDocument',
      'transcriptSourceBody',
      'noteSourceBody',
      'noteChunkPrefix',
      'packChunks',
      'overlapCut',
      'MAX_CHUNK_CHARS',
      'CHUNK_OVERLAP_CHARS',
      'MAX_TITLE_PREFIX_CHARS',
      'MAX_SPEAKER_LABEL_CHARS',
      'OVERLAP_SENTENCE_LOOKAHEAD_CHARS',
      'HARD_SPLIT_BACKTRACK_CHARS',
      'EMBEDDING_INPUT_TOKEN_CEILING',
      'CHARS_PER_TOKEN_FLOOR',
      'TRANSCRIPT_SEGMENT_SEPARATOR',
      'NOTE_BLOCK_SEPARATOR',
    ]) {
      expect(chunking).toHaveProperty(name);
    }
  });

  it('exposes no NestJS module or provider', () => {
    expect(code('index.ts')).not.toMatch(/Module|Injectable|Provider/);
  });

  it('chunks the same however the ambient environment is set', () => {
    // A blunt but direct check that no locale or timezone reaches a boundary.
    const segments = Array.from({ length: 12 }, (_unused, index) => ({
      ordinal: (index + 1) * 1000,
      text: `Segment ${index}: Straße, 会議, ﬁ, i̇, ${'w'.repeat(120)}.`,
      speakerLabel: index % 2 === 0 ? 'Åsa' : 'Bob',
    }));
    const markdown = segments.map((segment) => segment.text).join('\n\n');

    const previous = { lang: process.env.LANG, tz: process.env.TZ };
    const runs: string[] = [];
    try {
      for (const [lang, tz] of [
        ['en_US.UTF-8', 'UTC'],
        ['tr_TR.UTF-8', 'Pacific/Kiritimati'],
      ]) {
        process.env.LANG = lang;
        process.env.TZ = tz;
        runs.push(
          chunking.fingerprintDocument(chunking.chunkTranscript(segments)) +
            chunking.fingerprintDocument(chunking.chunkNote('Tıtle', markdown)),
        );
      }
    } finally {
      if (previous.lang === undefined) delete process.env.LANG;
      else process.env.LANG = previous.lang;
      if (previous.tz === undefined) delete process.env.TZ;
      else process.env.TZ = previous.tz;
    }
    expect(runs[0]).toBe(runs[1]);
  });
});

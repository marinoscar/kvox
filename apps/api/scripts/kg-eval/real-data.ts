// =============================================================================
// Opt-in, local-only evaluation on a developer's OWN real notes (issue #362).
//
// Real meetings are private conversations — there is no `transcripts:read_any`
// for exactly that reason — so nothing from this mode may ever land inside the
// repository. The one security control is `assertOutsideRepo`: every path this
// mode writes to or reads a real set from is resolved (symlinks included) and
// refused when it falls inside the git work tree. The single exception is the
// git-ignored `apps/api/.kg-eval/` scratch directory, and only for runs over
// the committed SYNTHETIC set.
//
// `exportNoteSkeleton` reads one note (plus its origin transcript's segments
// and speaker identities) and writes an UNLABELLED fixture skeleton — labels
// empty — for the developer to label by hand, outside the repository. It is
// read-only against the database and refuses a note the named user does not
// own with a plain "not found" (the 404-never-403 posture of the API).
// =============================================================================

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

import type { PrismaClient } from '@prisma/client';

import type { PrismaService } from '../../src/prisma/prisma.service';
import { parseSpeakerIdentities } from '../../src/transcripts/editing/speaker-identity';
import type { GoldenFixtureInput } from './fixture-schema';

export const REAL_DATA_REFUSAL = 'real meeting data must never be written inside the repository';

/** Exit code 3. */
export class RealDataPathError extends Error {
  constructor(readonly path: string) {
    super(`${REAL_DATA_REFUSAL}: ${path}`);
  }
}

/** Exit code 2 — a plain "not found", whoever actually owns the note. */
export class RealDataNotFoundError extends Error {}

/** The repository root(s): git's answer, plus this file's own location as a fallback. */
export function repositoryRoots(): string[] {
  const roots = new Set<string>();
  // scripts/kg-eval → scripts → api → apps → <root>
  roots.add(canonicalPath(resolve(__dirname, '..', '..', '..', '..')));
  for (const cwd of [__dirname, process.cwd()]) {
    try {
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (top) roots.add(canonicalPath(top));
    } catch {
      // Not a git checkout (or no git binary): the fallback above still applies.
    }
  }
  return [...roots];
}

/** Absolute, with symlinks resolved on the longest prefix that exists. */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync(existing);
  } catch {
    // keep the unresolved prefix
  }
  return rest.length > 0 ? join(real, ...rest) : real;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The git-ignored scratch directory synthetic runs may write into. */
export function syntheticRunsDir(): string {
  return canonicalPath(resolve(__dirname, '..', '..', '.kg-eval'));
}

/**
 * Throws `RealDataPathError` when `p` is inside the repository. With
 * `allowSyntheticRunsDir`, a path under `apps/api/.kg-eval/` is let through —
 * pass it ONLY for output of a run over the committed synthetic set.
 */
export function assertOutsideRepo(p: string, opts: { allowSyntheticRunsDir?: boolean } = {}): string {
  const abs = canonicalPath(p);
  if (opts.allowSyntheticRunsDir && isInside(abs, syntheticRunsDir())) return abs;
  for (const root of repositoryRoots()) {
    if (isInside(abs, root)) throw new RealDataPathError(abs);
  }
  return abs;
}

/** Next free `m9NN` id in a real directory (real ids never collide with the committed m01…). */
export function nextRealFixtureId(realDir: string): string {
  const used = new Set<number>();
  if (existsSync(realDir)) {
    for (const f of readdirSync(realDir)) {
      const m = /^m(\d{2,3})/.exec(f);
      if (m) used.add(Number(m[1]));
    }
  }
  let n = 901;
  while (used.has(n)) n += 1;
  return `m${n}`;
}

export interface ExportNoteArgs {
  prisma: PrismaClient;
  noteId: string;
  email: string;
  realDir: string;
}

export async function exportNoteSkeleton(args: ExportNoteArgs): Promise<string> {
  const realDir = assertOutsideRepo(args.realDir);
  const { prisma } = args;

  const user = await prisma.user.findUnique({ where: { email: args.email }, select: { id: true } });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const note =
    user && uuid.test(args.noteId)
      ? await prisma.note.findFirst({
          where: { id: args.noteId, ownerId: user.id, deletedAt: null, status: { not: 'deleting' } },
          select: {
            id: true,
            title: true,
            body: true,
            currentVersion: true,
            contextText: true,
            createdAt: true,
            sourceType: true,
            sourceTranscriptId: true,
            sourceNoteId: true,
          },
        })
      : null;
  if (!user || !note) throw new RealDataNotFoundError('not found');

  const version =
    note.currentVersion > 0
      ? await prisma.noteVersion.findFirst({
          where: { noteId: note.id, version: note.currentVersion },
          select: { version: true, body: true },
        })
      : null;

  // Required lazily: it pulls in Nest's decorators and the Prisma service
  // module, which a `--predictions` run has no reason to load. Nest is never
  // booted — the resolver is a plain class over the client it is handed.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NoteOriginService } = require('../../src/notes/note-origin.service') as typeof import('../../src/notes/note-origin.service');
  const origin = await new NoteOriginService(prisma as unknown as PrismaService).resolve(note, user.id);

  let recordedAt = note.createdAt;
  let speakers: GoldenFixtureInput['speakers'] = [];
  let segments: GoldenFixtureInput['segments'] = [];
  if (origin) {
    const transcript = await prisma.transcript.findUnique({
      where: { id: origin.id },
      select: {
        recordedAt: true,
        speakerIdentities: true,
        speakers: { select: { id: true, label: true, displayName: true } },
        segments: {
          orderBy: { ordinal: 'asc' },
          select: { id: true, speakerId: true, startMs: true, endMs: true, rev: true, text: true },
        },
      },
    });
    if (transcript) {
      recordedAt = transcript.recordedAt;
      const identities = parseSpeakerIdentities(transcript.speakerIdentities);
      speakers = transcript.speakers.map((s) => ({
        id: s.id,
        label: s.label ?? '',
        displayName: identities[s.id] ?? s.displayName ?? null,
      }));
      segments = transcript.segments.filter((s) => s.text.trim().length > 0);
    }
  }

  const id = nextRealFixtureId(realDir);
  const skeleton: GoldenFixtureInput = {
    id,
    title: note.title,
    tags: ['real'],
    recordedAt: recordedAt.toISOString(),
    contextText: note.contextText,
    hasTranscript: segments.length > 0,
    speakers,
    segments,
    note: { version: version?.version ?? Math.max(note.currentVersion, 1), body: version?.body ?? note.body },
    knownEntities: [],
    labels: { entities: [], relations: [], items: [], negatives: [] },
  };

  mkdirSync(realDir, { recursive: true });
  const file = join(realDir, `${id}-note-${note.id.slice(0, 8)}.json`);
  writeFileSync(file, `${JSON.stringify(skeleton, null, 2)}\n`, { mode: 0o600 });
  return file;
}

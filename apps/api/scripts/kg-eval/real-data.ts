// =============================================================================
// Opt-in, local-only evaluation on a developer's OWN real notes (issue #362).
//
// Real meetings are private conversations — there is no `transcripts:read_any`
// for exactly that reason — so nothing from this mode may ever land inside the
// repository. The one security control is `assertOutsideRepo`, which lives in
// `@marinoscar/kvox-eval` (#580) so the package's own `kvox-eval kg --real-dir`
// refuses the same paths: every path this mode writes to or reads a real set
// from is resolved (symlinks included) and refused when it falls inside the git
// work tree. The single exception is the git-ignored `apps/api/.kg-eval/`
// scratch directory, and only for runs over the committed SYNTHETIC set.
//
// `exportNoteSkeleton` reads one note (plus its origin transcript's segments
// and speaker identities) and writes an UNLABELLED fixture skeleton — labels
// empty — for the developer to label by hand, outside the repository. It is
// read-only against the database and refuses a note the named user does not
// own with a plain "not found" (the 404-never-403 posture of the API).
// =============================================================================

import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import type { PrismaClient } from '@prisma/client';

import { parseSpeakerIdentities } from '@marinoscar/kvox-api/transcripts';
import { assertOutsideRepo as assertOutsideRepoOf, canonicalPath, nextRealFixtureId } from '@marinoscar/kvox-eval';
import type { GoldenFixtureInput } from '@marinoscar/kvox-eval/fixtures';

export { canonicalPath, isInside, nextRealFixtureId, RealDataPathError, REAL_DATA_REFUSAL, repositoryRoots } from '@marinoscar/kvox-eval';

/** Exit code 2 — a plain "not found", whoever actually owns the note. */
export class RealDataNotFoundError extends Error {}

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
  return assertOutsideRepoOf(p, { allowInside: opts.allowSyntheticRunsDir ? syntheticRunsDir() : null });
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

  // Required lazily: it pulls in Nest's decorators, which a `--predictions` run has no reason to
  // load. Nest is never booted - the resolver is a plain class over the client it is handed. The
  // eval reads the owner's own notes, so the slice's owner-only sharing is the right answer for the
  // transcript behind one (a transcript shared with the owner is not part of an eval corpus).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NoteOriginService } = require('@marinoscar/kvox-api/notes') as typeof import('@marinoscar/kvox-api/notes');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OwnerOnlyTranscriptSharing } = require('@marinoscar/kvox-api/transcripts') as typeof import('@marinoscar/kvox-api/transcripts');
  const origin = await new NoteOriginService(prisma as never, new OwnerOnlyTranscriptSharing()).resolve(note, user.id);

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

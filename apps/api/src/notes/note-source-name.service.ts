/**
 * Resolving "from *Q3 planning*" for a page of notes, server-side — issue #192,
 * epic #162.
 *
 * =============================================================================
 * WHAT THIS REPLACES, AND WHY THE CLIENT COULD NOT KEEP DOING IT
 * =============================================================================
 *
 * `GET /api/notes` denormalises `templateName` onto every row but never the
 * SOURCE's name. A row carried `sourceType` plus one id and nothing else, so
 * the web client resolved the name itself: `apps/web/src/hooks/
 * useNoteSourceNames.ts` issued ONE REQUEST PER DISTINCT SOURCE on the page,
 * across three different endpoints, and its own header called itself a stand-in
 * "written to be deleted" and named this fix.
 *
 * At epic #162's scale that stops being acceptable arithmetic. "Load more"
 * three times is up to sixty extra round trips for LINK LABELS, over the
 * cellular connection the epic's own out-of-scope note protects when it rejects
 * auto-infinite-scroll.
 *
 * =============================================================================
 * A BOUNDED NUMBER OF QUERIES, NOT ONE PER ROW
 * =============================================================================
 *
 * At most THREE reads for a whole page, whatever it holds: the rows are grouped
 * by `sourceType` and each group is one `findMany` over an `id: { in: [...] }`.
 * Twenty notes from twenty different transcripts cost the same as twenty notes
 * from one. Moving an N+1 from the client to the server would have been no fix
 * at all.
 *
 * =============================================================================
 * ⚠ EVERY LOOKUP IS SCOPED TO WHAT THE CALLER MAY SEE
 * =============================================================================
 *
 * This is the part that would be a security bug if it were written the obvious
 * way. A note is owner-only, but its SOURCE need not still be readable by that
 * owner — a transcript shared with them can be unshared afterwards, and the
 * note keeps pointing at it forever.
 *
 * So the predicates below are not `id IN (...)`. They are `id IN (...) AND the
 * caller can read this`, which for a transcript means owned-or-shared and for a
 * note and a document means owned. An unreadable source resolves to `null`,
 * which is exactly the answer the client's own 404 path produced before this
 * existed — so the row renders its category noun ("a transcript") and no title
 * leaks. Widening any of these three predicates to a bare `id IN (...)` would
 * publish the titles of other people's private recordings on a list endpoint
 * every user can call.
 *
 * `null` therefore means "no name available", never "no source": a deleted
 * source, an unreadable one and a soft-deleted one all answer the same way, and
 * every consumer already degrades to the noun.
 */

import { Injectable } from '@nestjs/common';
import type { Note } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** What the resolver needs off a note. A full `Note` satisfies it structurally. */
export type NoteSourceFields = Pick<
  Note,
  'sourceType' | 'sourceTranscriptId' | 'sourceNoteId' | 'sourceObjectId'
>;

/**
 * The id a note's `sourceType` points at, or `null` for a row whose discriminant
 * and id columns disagree (which the schema permits and nothing should produce).
 */
export function noteSourceId(note: NoteSourceFields): string | null {
  switch (note.sourceType) {
    case 'transcript':
      return note.sourceTranscriptId;
    case 'note':
      return note.sourceNoteId;
    case 'document':
      return note.sourceObjectId;
    default:
      return null;
  }
}

/**
 * Names for a page of notes' sources, keyed by `<sourceType>:<id>`.
 *
 * The TYPE is part of the key deliberately: these ids are uuids from three
 * different tables, nothing stops one colliding with another, and a bare-id key
 * would label one row with another table's title.
 */
export type NoteSourceNames = Map<string, string>;

export function noteSourceNameKey(type: string, id: string): string {
  return `${type}:${id}`;
}

@Injectable()
export class NoteSourceNameService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve every source named by `notes`, as far as `userId` may read them.
   *
   * Issues at most three queries, and none at all for a page whose sources are
   * all of one kind — or for an empty page, which `summary` hands it routinely.
   */
  async resolve(notes: readonly NoteSourceFields[], userId: string): Promise<NoteSourceNames> {
    const transcriptIds = new Set<string>();
    const noteIds = new Set<string>();
    const objectIds = new Set<string>();

    for (const note of notes) {
      const id = noteSourceId(note);
      if (!id) continue;
      if (note.sourceType === 'transcript') transcriptIds.add(id);
      else if (note.sourceType === 'note') noteIds.add(id);
      else if (note.sourceType === 'document') objectIds.add(id);
    }

    const names: NoteSourceNames = new Map();

    const [transcripts, sourceNotes, objects] = await Promise.all([
      transcriptIds.size === 0
        ? []
        : this.prisma.transcript.findMany({
            where: {
              id: { in: [...transcriptIds] },
              deletedAt: null,
              // OWNED OR SHARED — the same reach `TranscriptAccessService`
              // grants, expressed as a predicate because this is a set read
              // rather than a per-row authorisation. A transcript the caller
              // was shown and later unshared from falls out here and resolves
              // to `null`, which is the correct answer and the one the client
              // used to get from a 404.
              OR: [{ ownerId: userId }, { shares: { some: { userId } } }],
            },
            select: { id: true, title: true },
          }),
      noteIds.size === 0
        ? []
        : this.prisma.note.findMany({
            // Notes are owner-only in this epic; there is no share table to
            // consult and deliberately no `notes:read_any` anywhere in the
            // design, for any role.
            where: { id: { in: [...noteIds] }, ownerId: userId, deletedAt: null },
            select: { id: true, title: true },
          }),
      objectIds.size === 0
        ? []
        : this.prisma.storageObject.findMany({
            // `managed_by: 'notes'` hides these from the generic storage list,
            // not from a read by id — but the uploader is still the only person
            // entitled to the filename.
            where: { id: { in: [...objectIds] }, uploadedById: userId },
            select: { id: true, name: true },
          }),
    ]);

    for (const row of transcripts) names.set(noteSourceNameKey('transcript', row.id), row.title);
    for (const row of sourceNotes) names.set(noteSourceNameKey('note', row.id), row.title);
    for (const row of objects) names.set(noteSourceNameKey('document', row.id), row.name);

    return names;
  }

  /** The name for ONE note's source, or `null`. What the detail route needs. */
  async resolveOne(note: NoteSourceFields, userId: string): Promise<string | null> {
    const id = noteSourceId(note);
    if (!id) return null;

    const names = await this.resolve([note], userId);

    return names.get(noteSourceNameKey(note.sourceType, id)) ?? null;
  }
}

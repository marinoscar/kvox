// =============================================================================
// EvidenceValidator (#355, epic #344; docs/specs/ontology.md §5.3, §12)
// =============================================================================
//
// A CITATION MUST NEVER BECOME A SIDE CHANNEL. Evidence is authored by the
// graph's owner, and it may anchor only to sources that owner can read:
//
//   - a NOTE the owner owns, not being deleted, at a VERSION that exists;
//   - a TRANSCRIPT the owner can VIEW — owned, or shared with them at either
//     role — not soft-deleted, and a SEGMENT that belongs to that transcript;
//   - an IMPORT OBJECT the owner uploaded.
//
// The transcript rule mirrors `TranscriptAccessService` exactly (owner, or a
// platform grant to the owner; `deleted_at IS NULL`), but as ONE `findMany` and ONE
// batched decision (`rolesFor`) over the whole batch rather than N `require`
// calls: a proposal commit can carry hundreds of citations.
//
// BOUNDED QUERIES: at most one query per source table (notes, note_versions,
// transcripts, transcript_segments, storage_objects), whatever the batch size,
// and none for a table the batch does not cite.
//
// A failure is a 400 naming the indexes of every invalid row
// (`details.invalidEvidence`) — never a 404: the caller is the owner authoring
// evidence, not a stranger probing for ids, and the answer is the same whether
// the cited row is missing or somebody else's, so nothing leaks.
//
// Runs on the CALLER'S transaction client: a note or transcript read here is
// read in the same snapshot the write commits against.
//
// THE PORTS RUN BEFORE THE TRANSACTION (#615). Two answers do not come from
// `tx`: whether an import object is the owner's (`KVOX_OBJECT_STORE.describe`)
// and whether a transcript somebody else owns is shared with them
// (`TranscriptSharing.rolesFor`). On the desktop and web hosts both ports read
// the database through the ROOT client, and on a one-connection pool (PGlite:
// KVox Desktop, the bare host's pglite leg) a root-client read inside an
// interactive transaction waits forever for the connection the transaction
// holds. So a caller that opens a transaction calls `prefetch` first and hands
// the resulting `EvidenceAccess` in: the transaction then reads only `tx` for
// every id the access covers. An OWNED transcript never needs a port (the
// owner check reads the `tx` row). An id the access does not cover still goes
// to the port, so a caller that passes no access works exactly as before.
// =============================================================================

import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { KVOX_OBJECT_STORE, KVOX_PRISMA, type KvoxObjectStorePort } from '../../ports/index.js';
import { TranscriptAccessService } from '../../transcripts/index.js';
import { evidenceInputSchema, type EvidenceInput } from '../dto/graph-evidence.dto.js';
import type { KvoxGraphDb, KvoxGraphTx } from '../data/graph-db.js';

export const INVALID_EVIDENCE_MESSAGE =
  'Some evidence cites a source you cannot read, or a segment or version that does not exist.';

/**
 * The port answers `EvidenceValidator.prefetch` resolved BEFORE a transaction opens
 * (#615), for one owner. `assertReadable` and `viewableTranscriptIds` use it for every
 * id it covers and ask the port only for the rest.
 *
 * @stability experimental
 */
export interface EvidenceAccess {
  /** Import object id → whether it is the owner's own module-managed upload. */
  readonly importObjects: ReadonlyMap<string, boolean>;
  /**
   * Transcript id → whether a transcript the owner does NOT own is shared with them
   * (either role). A transcript missing or soft-deleted when prefetched is `false`.
   * Owned transcripts are absent: the owner check needs no port.
   */
  readonly sharedTranscripts: ReadonlyMap<string, boolean>;
}

/** A transcript row as the access decision needs it. */
interface TranscriptAccessRow {
  id: string;
  ownerId: string;
  orgId: string;
}

@Injectable()
export class EvidenceValidator {
  constructor(
    @Inject(KVOX_OBJECT_STORE) private readonly store: KvoxObjectStorePort,
    private readonly transcriptAccess: TranscriptAccessService,
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
  ) {}

  /**
   * Resolve, through the root client and the ports, the answers `assertReadable` would
   * otherwise ask a port for: every cited import object, and every cited transcript
   * `ownerId` does not own. Read-only. Call it BEFORE opening the transaction the
   * write runs on, never inside it: on a one-connection pool those reads would wait for
   * the connection the transaction holds (#615). The transaction still re-reads the
   * transcript rows on `tx`, so ownership and soft-deletion are decided in the write's
   * own snapshot.
   */
  async prefetch(ownerId: string, evidence: readonly EvidenceInput[]): Promise<EvidenceAccess> {
    const ids = (pick: (row: EvidenceInput) => string | null | undefined) => [
      ...new Set(evidence.flatMap((row) => {
        const value = pick(row);
        return typeof value === 'string' && value !== '' ? [value] : [];
      })),
    ];
    const importObjectIds = ids((r) => r.importObjectId);
    const transcriptIds = ids((r) => r.transcriptId);

    const [objects, rows] = await Promise.all([
      importObjectIds.length === 0 ? Promise.resolve(new Map()) : this.store.describe(importObjectIds),
      transcriptIds.length === 0
        ? Promise.resolve([] as TranscriptAccessRow[])
        : this.prisma.transcript.findMany({
            where: { id: { in: transcriptIds }, deletedAt: null },
            select: { id: true, ownerId: true, orgId: true },
          }),
    ]);

    const importObjects = new Map<string, boolean>(
      importObjectIds.map((id) => {
        const object = objects.get(id);
        return [id, object !== undefined && object.ownerId === ownerId && object.managedBy != null];
      }),
    );

    const notOwned = rows.filter((row) => row.ownerId !== ownerId);
    const roles = notOwned.length === 0 ? new Map() : await this.transcriptAccess.rolesFor(ownerId, notOwned);
    const found = new Set(rows.map((row) => row.id));
    const sharedTranscripts = new Map<string, boolean>();
    for (const id of transcriptIds) {
      if (!found.has(id)) sharedTranscripts.set(id, false);
    }
    for (const row of notOwned) sharedTranscripts.set(row.id, roles.has(row.id));

    return { importObjects, sharedTranscripts };
  }

  /**
   * The ids among `transcriptIds` that `ownerId` may VIEW: live (not soft-deleted),
   * and owned by them or shared with them at either role. One query for the rows (on
   * `tx`), and one batched decision for the shares the `access` from `prefetch` does
   * not already cover; none at all when every row is owned.
   */
  async viewableTranscriptIds(
    ownerId: string,
    transcriptIds: readonly string[],
    tx: KvoxGraphTx,
    access?: EvidenceAccess,
  ): Promise<Set<string>> {
    if (transcriptIds.length === 0) return new Set();

    const rows: TranscriptAccessRow[] = await tx.transcript.findMany({
      where: { id: { in: [...transcriptIds] }, deletedAt: null },
      select: { id: true, ownerId: true, orgId: true },
    });

    const viewable = new Set<string>();
    const undecided: TranscriptAccessRow[] = [];
    for (const row of rows) {
      if (row.ownerId === ownerId) {
        viewable.add(row.id);
        continue;
      }
      const shared = access?.sharedTranscripts.get(row.id);
      if (shared === undefined) undecided.push(row);
      else if (shared) viewable.add(row.id);
    }
    if (undecided.length > 0) {
      const roles = await this.transcriptAccess.rolesFor(ownerId, undecided);
      for (const row of undecided) if (roles.has(row.id)) viewable.add(row.id);
    }
    return viewable;
  }

  /**
   * The ids among `importObjectIds` that are `ownerId`'s own module-managed uploads:
   * from `access` where it covers an id, from the object store for the rest.
   */
  private async ownedImportObjects(
    ownerId: string,
    importObjectIds: readonly string[],
    access?: EvidenceAccess,
  ): Promise<Set<string>> {
    const owned = new Set<string>();
    const undecided: string[] = [];
    for (const id of importObjectIds) {
      const known = access?.importObjects.get(id);
      if (known === undefined) undecided.push(id);
      else if (known) owned.add(id);
    }
    if (undecided.length > 0) {
      const found = await this.store.describe(undecided);
      for (const object of found.values()) {
        if (object.ownerId === ownerId && object.managedBy != null) owned.add(object.id);
      }
    }
    return owned;
  }

  /**
   * Parse every row (applying the DTO's defaults) and prove each anchor is
   * readable by `ownerId`. Returns the parsed rows, in order. A caller inside a
   * transaction passes the `access` it prefetched before opening it (#615).
   */
  async assertReadable(
    ownerId: string,
    evidence: readonly EvidenceInput[],
    tx: KvoxGraphTx,
    access?: EvidenceAccess,
  ): Promise<EvidenceInput[]> {
    const invalid = new Set<number>();
    const parsed: EvidenceInput[] = evidence.map((row, index) => {
      const result = evidenceInputSchema.safeParse(row);
      if (!result.success) {
        invalid.add(index);
        return row;
      }
      return result.data;
    });

    // Anchor-shape rules the schema's refine does not force: an anchor that is
    // half present is invalid, whichever branch the row otherwise satisfied.
    parsed.forEach((row, index) => {
      if (invalid.has(index)) return;
      if (row.segmentId && !row.transcriptId) invalid.add(index);
      if (row.noteId && row.noteVersion === null) invalid.add(index);
      if (!row.noteId && row.noteVersion !== null) invalid.add(index);
    });

    const live = (index: number) => !invalid.has(index);
    const collect = (pick: (row: EvidenceInput) => string | null) => [
      ...new Set(
        parsed.flatMap((row, i) => {
          const value = live(i) ? pick(row) : null;
          return value ? [value] : [];
        }),
      ),
    ];

    const noteIds = collect((r) => r.noteId);
    const transcriptIds = collect((r) => r.transcriptId);
    const segmentIds = collect((r) => r.segmentId);
    const importObjectIds = collect((r) => r.importObjectId);

    const [notes, versions, transcripts, segments, objects] = await Promise.all([
      noteIds.length === 0
        ? Promise.resolve([] as { id: string }[])
        : tx.note.findMany({
            where: { id: { in: noteIds }, ownerId, status: { not: 'deleting' }, deletedAt: null },
            select: { id: true },
          }),
      noteIds.length === 0
        ? Promise.resolve([] as { noteId: string; version: number }[])
        : tx.noteVersion.findMany({
            where: {
              OR: parsed.flatMap((r, i) =>
                live(i) && r.noteId && r.noteVersion !== null
                  ? [{ noteId: r.noteId, version: r.noteVersion }]
                  : [],
              ),
            },
            select: { noteId: true, version: true },
          }),
      this.viewableTranscriptIds(ownerId, transcriptIds, tx, access),
      segmentIds.length === 0
        ? Promise.resolve([] as { id: string; transcriptId: string }[])
        : tx.transcriptSegment.findMany({
            where: { id: { in: segmentIds } },
            select: { id: true, transcriptId: true },
          }),
      importObjectIds.length === 0 ? Promise.resolve(new Set<string>()) : this.ownedImportObjects(ownerId, importObjectIds, access),
    ]);

    const readableNotes = new Set(notes.map((n) => n.id));
    const existingVersions = new Set(versions.map((v) => `${v.noteId}:${v.version}`));
    const viewableTranscripts = transcripts;
    const segmentTranscript = new Map(segments.map((s) => [s.id, s.transcriptId]));
    const ownedObjects = objects;

    parsed.forEach((row, index) => {
      if (!live(index)) return;
      if (row.noteId) {
        if (!readableNotes.has(row.noteId) || !existingVersions.has(`${row.noteId}:${row.noteVersion}`)) {
          invalid.add(index);
        }
      }
      if (row.transcriptId && !viewableTranscripts.has(row.transcriptId)) invalid.add(index);
      if (row.segmentId && segmentTranscript.get(row.segmentId) !== row.transcriptId) invalid.add(index);
      if (row.importObjectId && !ownedObjects.has(row.importObjectId)) invalid.add(index);
    });

    if (invalid.size > 0) {
      throw new BadRequestException({
        message: INVALID_EVIDENCE_MESSAGE,
        details: { invalidEvidence: [...invalid].sort((a, b) => a - b) },
      });
    }

    return parsed;
  }
}

// =============================================================================
// Citation validation and mapping (issue #378; docs/specs/ontology.md §21.3)
// =============================================================================
//
// "Citations are validated, not merely requested." The answer's `[^…]` markers
// are parsed from the FINAL `content` and each distinct one is checked against
// the turn's own `HandleRegistry` (#377) — a map lookup, so `valid` means
// exactly "a tool returned this in THIS turn":
//
//   ev  → kind `evidence`, the evidence row
//   ent → kind `entity`
//   doc → kind `document` (a transcript or note passage, with `startMs`)
//   itm / rel → the subject's FIRST evidence row (owner-scoped, newest meeting
//         first — the `evidence` tool's order), as kind `evidence` with
//         `via: { kind, id }`; no evidence row → `valid: false`
//
// An unissued (invented, stale, malformed) marker is `valid: false, id: null`.
// Invalid markers STAY in `content` — it is append-only under a connected
// reader — and the UI drops them from the rendered answer and shows the count.
//
// PURE except `loadCitationSources`, the one owner-scoped read.
// =============================================================================

import { Prisma } from '@prisma/client';

import type { AskCitation } from './dto/ask.dto';
import type { HandleRegistry } from './tools/handle-registry';

/** The five marker prefixes; the digits as written (a malformed `ev0` parses, and is invalid). */
export const CITATION_MARKER_RE = /\[\^(ev|ent|doc|itm|rel)(\d+)\]/g;

/** Distinct markers (`ev7`, `ent2`, …) in order of first appearance. */
export function parseCitationMarkers(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(CITATION_MARKER_RE)) seen.add(`${match[1]}${match[2]}`);
  return [...seen];
}

/** Where one evidence row points, as a citation chip renders it. */
export interface EvidenceSource {
  evidenceId: string;
  label: string | null;
  documentKind: 'transcript' | 'note' | null;
  startMs: number | null;
}

export interface CitationSources {
  /** By evidence id. */
  evidence: ReadonlyMap<string, EvidenceSource>;
  /** By `item:<id>` / `relation:<id>`: that subject's first evidence. */
  firstEvidence: ReadonlyMap<string, EvidenceSource>;
}

export interface CitationSourceRequest {
  evidenceIds: string[];
  itemIds: string[];
  relationIds: string[];
}

/** Which rows `loadCitationSources` must read for these markers. Pure. */
export function citationSourceRequest(markers: readonly string[], registry: HandleRegistry): CitationSourceRequest {
  const request: CitationSourceRequest = { evidenceIds: [], itemIds: [], relationIds: [] };
  for (const marker of markers) {
    const target = registry.resolve(marker);
    if (!target) continue;
    if (target.kind === 'ev') request.evidenceIds.push(target.id);
    else if (target.kind === 'itm') request.itemIds.push(target.id);
    else if (target.kind === 'rel') request.relationIds.push(target.id);
  }
  return request;
}

const invalid = (marker: string, kind: AskCitation['kind']): AskCitation => ({
  marker,
  kind,
  id: null,
  via: null,
  valid: false,
  label: null,
  documentKind: null,
  startMs: null,
});

const KIND_OF_PREFIX: Record<string, AskCitation['kind']> = {
  ev: 'evidence',
  itm: 'evidence',
  rel: 'evidence',
  ent: 'entity',
  doc: 'document',
};

/** One `AskCitation` per distinct marker, in first-appearance order. Pure. */
export function mapCitations(
  markers: readonly string[],
  registry: HandleRegistry,
  sources: CitationSources,
): AskCitation[] {
  return markers.map((marker) => {
    const prefix = /^[a-z]+/.exec(marker)?.[0] ?? '';
    const kind = KIND_OF_PREFIX[prefix] ?? 'evidence';
    const target = registry.resolve(marker);
    if (!target) return invalid(marker, kind);

    switch (target.kind) {
      case 'ent':
        return {
          marker,
          kind: 'entity',
          id: target.id,
          via: null,
          valid: true,
          label: target.label ?? null,
          documentKind: null,
          startMs: null,
        };
      case 'doc':
        return {
          marker,
          kind: 'document',
          id: target.id,
          via: null,
          valid: true,
          label: target.label ?? null,
          documentKind: target.documentKind ?? null,
          startMs: target.startMs ?? null,
        };
      case 'ev': {
        const source = sources.evidence.get(target.id);
        // Issued, but the row is gone (forgotten mid-turn): nothing left to open.
        if (!source) return invalid(marker, 'evidence');
        return fromEvidence(marker, source, null);
      }
      case 'itm':
      case 'rel': {
        const viaKind = target.kind === 'itm' ? 'item' : 'relation';
        const source = sources.firstEvidence.get(`${viaKind}:${target.id}`);
        if (!source) return invalid(marker, 'evidence');
        return fromEvidence(marker, source, { kind: viaKind, id: target.id });
      }
    }
  });
}

function fromEvidence(marker: string, source: EvidenceSource, via: AskCitation['via']): AskCitation {
  return {
    marker,
    kind: 'evidence',
    id: source.evidenceId,
    via,
    valid: true,
    label: source.label,
    documentKind: source.documentKind,
    startMs: source.startMs,
  };
}

/** The Prisma surface `loadCitationSources` needs. */
export interface CitationQueryClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

interface SourceRow {
  key: string;
  evidenceId: string;
  transcriptId: string | null;
  noteId: string | null;
  startMs: number | null;
  transcriptTitle: string | null;
  noteTitle: string | null;
}

/**
 * The ONE owner-scoped read: the cited evidence rows, and each cited
 * item's/relation's first evidence row (newest meeting first — a transcript's
 * `recorded_at`, a note's `created_at` — then the citation's own `created_at`).
 * A source title is returned only while the owner can still see the document
 * (theirs, or shared with them, and not deleted).
 */
export async function loadCitationSources(
  prisma: CitationQueryClient,
  ownerId: string,
  request: CitationSourceRequest,
): Promise<CitationSources> {
  const evidence = new Map<string, EvidenceSource>();
  const firstEvidence = new Map<string, EvidenceSource>();
  if (request.evidenceIds.length + request.itemIds.length + request.relationIds.length === 0) {
    return { evidence, firstEvidence };
  }
  const uuids = (ids: string[]) => Prisma.sql`ARRAY[${Prisma.join(ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])}]::uuid[]`;

  const rows = await prisma.$queryRaw<SourceRow[]>(Prisma.sql`
    SELECT DISTINCT ON (c.key)
           c.key,
           c.id::text          AS "evidenceId",
           c.transcript_id::text AS "transcriptId",
           c.note_id::text     AS "noteId",
           c.start_ms          AS "startMs",
           CASE WHEN t.id IS NOT NULL AND t.deleted_at IS NULL
                 AND (t.owner_id = ${ownerId}::uuid OR EXISTS (
                      SELECT 1 FROM transcript_shares s
                       WHERE s.transcript_id = t.id AND s.user_id = ${ownerId}::uuid))
                THEN t.title END AS "transcriptTitle",
           CASE WHEN n.id IS NOT NULL AND n.deleted_at IS NULL AND n.owner_id = ${ownerId}::uuid
                THEN n.title END AS "noteTitle"
      FROM (
        SELECT ev.id::text AS key, ev.id, ev.transcript_id, ev.note_id, ev.start_ms, ev.created_at
          FROM kg_evidence ev
         WHERE ev.owner_id = ${ownerId}::uuid AND ev.id = ANY(${uuids(request.evidenceIds)})
        UNION ALL
        SELECT ev.subject_kind::text || ':' || ev.subject_id::text AS key,
               ev.id, ev.transcript_id, ev.note_id, ev.start_ms, ev.created_at
          FROM kg_evidence ev
         WHERE ev.owner_id = ${ownerId}::uuid
           AND ((ev.subject_kind = 'item' AND ev.subject_id = ANY(${uuids(request.itemIds)}))
             OR (ev.subject_kind = 'relation' AND ev.subject_id = ANY(${uuids(request.relationIds)})))
      ) c
      LEFT JOIN transcripts t ON t.id = c.transcript_id
      LEFT JOIN notes n ON n.id = c.note_id
     ORDER BY c.key, coalesce(t.recorded_at, n.created_at) DESC NULLS LAST, c.created_at DESC, c.id DESC`);

  for (const row of rows) {
    const source: EvidenceSource = {
      evidenceId: row.evidenceId,
      label: row.transcriptTitle ?? row.noteTitle ?? null,
      documentKind: row.transcriptId ? 'transcript' : row.noteId ? 'note' : null,
      startMs: row.startMs ?? null,
    };
    if (row.key.includes(':')) firstEvidence.set(row.key, source);
    else evidence.set(row.key, source);
  }
  return { evidence, firstEvidence };
}

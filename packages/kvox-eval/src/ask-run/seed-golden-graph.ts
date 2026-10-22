// =============================================================================
// The headless Ask evaluation's golden-graph seeder (issue #608; port of the web
// app's `apps/api/scripts/ask-eval/seed-graph.ts`, #382)
// =============================================================================
//
// Loads EVERY meeting of the golden set and writes it as the evaluation user's
// data: a `transcripts`/`transcript_speakers`/`transcript_segments` row per
// meeting with a transcript, a `notes`/`note_versions` row for every meeting,
// and the meeting's HAND LABELS (never a model's extraction) as `accepted`
// entities, relations and items with evidence pointing at the segments and the
// note it just created. That is what makes the evaluation ISOLATE the agent:
// extraction quality is `kvox-eval kg`'s question, not this one's.
//
// EVERY GRAPH ROW GOES THROUGH `GraphWriteService` (the one sanctioned write
// path): entities, their aliases, relations, items, evidence and supersession,
// inside one `prisma.$transaction` per fixture with the user's effective
// schema. So the type, endpoint, temporal, status and evidence-readability
// checks run, and the deferred `kg_assert_has_evidence` trigger checks every
// accepted row at COMMIT. Transcripts, segments, speakers, notes, note versions
// and storage objects are not graph rows; they are plain inserts.
//
// AN ENTITY THAT RECURS ACROSS MEETINGS BECOMES ONE ROW. A fixture's
// `knownEntities[].id` (`"g-person-sarah-chen"`) is the stable cross-fixture
// identity a later meeting's `existingId` links back to. Fixtures are seeded in
// id order, so a person's first mention creates the row; a later `existingId`,
// or a label/alias that matches what any fixture declares for that global id,
// resolves to it (and adds its evidence with `addEvidence`). A label no
// `knownEntities` list mentions stays a one-off row of its own meeting.
//
// A REFERENCE-ONLY ENTITY (a `knownEntities` id a relation or item names, with
// no label of its own anywhere yet) still needs evidence to be `accepted`. The
// web app's seeder wrote a quote-only filler row (no anchor); the write service
// refuses an unanchored citation, so the filler cites the referring meeting's
// note with the label as its quote, the shape of a note-Context citation. It is
// left OUT of `evidenceSource`, exactly as the unanchored filler was.
//
// WHAT THE WRITE SERVICE REFUSES IS REPORTED, NEVER DROPPED SILENTLY: each
// refusal lands in `refusals` (fixture, row, the service's message; type keys
// and paths only, never a label, statement or quote) and the row is skipped.
// The refusals the service raises happen before its insert, so the
// transaction stays usable.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { EffectiveSchema, KgItemKind } from '@marinoscar/kvox-contract/ontology';
import type { EvidenceInput } from '@marinoscar/kvox-contract/graph';
import { GraphOntologyService, GraphWriteService } from '@marinoscar/kvox-api/graph';

import {
  fixtureDomains,
  goldenFixtureSchema,
  itemAddress,
  type EvidenceLabel,
  type GoldenEntityLabel,
  type GoldenFixture,
  type ItemLabelKind,
} from '../fixtures/index.js';
import type { AskEvalHost } from './host/app.js';
import type { AskEvalPrismaClient } from './host/db.js';

/** The interactive transaction of the evaluation's client. */
type Tx = Parameters<Parameters<AskEvalPrismaClient['$transaction']>[0]>[0];
/** What `GraphWriteService` takes as its transaction (the slice's narrowed client type). */
type WriterTx = Parameters<GraphWriteService['createEntity']>[0];

/**
 * Fixture ids and labels ↔ the database rows the seeder wrote for them.
 *
 * @stability experimental
 */
export interface AskEvalIdMap {
  /** `"m01-s009"` → the real `transcript_segments.id`. */
  segments: Map<string, string>;
  /** Fixture id → that meeting's `notes.id`. */
  notes: Map<string, string>;
  /** A global (`knownEntities`) id → `kg_entities.id`. Mostly for debugging. */
  entities: Map<string, string>;
  /** `kg_evidence.id` → `"m01-s009"` or `"m01#note"`: what the scorer's `citeFrom` checks resolve against. */
  evidenceSource: Map<string, string>;
}

/**
 * One row the write service refused: which fixture and row, and why (the
 * service's message and issue paths; never a label, statement or quote).
 *
 * @stability experimental
 */
export interface AskEvalSeedRefusal {
  /** The fixture id (`"m07"`). */
  fixtureId: string;
  /** The row, by kind, position and type key (`"relation #2 (WORKS_AT)"`). */
  row: string;
  /** The service's reason. */
  reason: string;
}

/**
 * What {@link seedGoldenGraph} wrote.
 *
 * @stability experimental
 */
export interface SeededGoldenGraph {
  /** The owner of every row (the host's evaluation user). */
  userId: string;
  /** Fixture ids ↔ row ids. */
  idMap: AskEvalIdMap;
  /** Rows the write service refused (skipped, reported). */
  refusals: AskEvalSeedRefusal[];
  /** Fixture data that could not be resolved (an unknown segment or entity reference). */
  warnings: string[];
  /** Row counts, for the log. */
  counts: { entities: number; relations: number; items: number; evidence: number };
}

/** One segment row as an evidence anchor needs it. */
interface SegmentRow {
  id: string;
  transcriptId: string;
  startMs: number;
  endMs: number;
}

interface Ctx {
  tx: Tx;
  writer: GraphWriteService;
  schema: EffectiveSchema;
  ownerId: string;
  orgId: string;
  fixture: GoldenFixture;
  idMap: AskEvalIdMap;
  /** `transcript_segments.id` → `"m01-s009"`, across the run. */
  segmentSource: Map<string, string>;
  /** `notes.id` → fixture id, across the run. */
  noteSource: Map<string, string>;
  /** This fixture's segment rows by fixture segment id, reset per fixture (the evidence anchors). */
  segmentRows: Map<string, SegmentRow>;
  /** Global cross-fixture identity → its `kg_entities.id`, once created. */
  globalEntityId: Map<string, string>;
  /** Global identity → its declared type/label/aliases, gathered from every fixture's `knownEntities`. */
  globalCatalog: Map<string, { type: string; label: string; aliases: Set<string> }>;
  /** `type + "\u0000" + normalized(label-or-alias)` → the global id it belongs to. */
  labelToGlobalId: Map<string, string>;
  /** This fixture's local entity key → `kg_entities.id`, reset per fixture. */
  localEntityId: Map<string, string>;
  /** Cross-fixture item address (`"m03#claim-1"`) → `kg_items.id`, across the run. */
  itemByAddress: Map<string, string>;
  refusals: AskEvalSeedRefusal[];
  warnings: string[];
  counts: SeededGoldenGraph['counts'];
}

const normalize = (s: string): string => s.trim().toLowerCase();

function buildGlobalCatalog(fixtures: GoldenFixture[]): Ctx['globalCatalog'] {
  const catalog: Ctx['globalCatalog'] = new Map();
  for (const fixture of fixtures) {
    for (const known of fixture.knownEntities) {
      const existing = catalog.get(known.id);
      if (existing) {
        for (const alias of known.aliases) existing.aliases.add(alias);
      } else {
        catalog.set(known.id, { type: known.type, label: known.label, aliases: new Set(known.aliases) });
      }
    }
  }
  return catalog;
}

function buildLabelIndex(catalog: Ctx['globalCatalog']): Ctx['labelToGlobalId'] {
  const index: Ctx['labelToGlobalId'] = new Map();
  for (const [globalId, entry] of catalog) {
    for (const name of [entry.label, ...entry.aliases]) {
      index.set(`${entry.type}\u0000${normalize(name)}`, globalId);
    }
  }
  return index;
}

/** The global identity this label resolves to, if any: `existingId`, else a label/alias match against the catalog. */
function globalIdFor(ctx: Ctx, entity: GoldenEntityLabel): string | null {
  if (entity.existingId) return entity.existingId;
  const byLabel = ctx.labelToGlobalId.get(`${entity.type}\u0000${normalize(entity.label)}`);
  if (byLabel) return byLabel;
  for (const alias of entity.aliases) {
    const hit = ctx.labelToGlobalId.get(`${entity.type}\u0000${normalize(alias)}`);
    if (hit) return hit;
  }
  return null;
}

/** The refusal's message: the error's own text plus its issue paths (the service never puts data in either). */
function reasonOf(error: unknown): string {
  const e = error as { message?: unknown; details?: { issues?: { path?: unknown; message?: unknown }[] }; response?: unknown };
  const issues = e.details?.issues?.map((i) => `${String(i.path)}: ${String(i.message)}`) ?? [];
  const response = e.response as { details?: { invalidEvidence?: number[] } } | undefined;
  const invalidEvidence = response?.details?.invalidEvidence;
  const extra = [...issues, ...(invalidEvidence ? [`invalid evidence at ${invalidEvidence.join(', ')}`] : [])];
  return `${typeof e.message === 'string' ? e.message : String(error)}${extra.length ? ` [${extra.join('; ')}]` : ''}`;
}

/** Runs one write; a refusal is recorded and answers `null`. */
async function attempt<T>(ctx: Ctx, row: string, write: () => Promise<T>): Promise<T | null> {
  try {
    return await write();
  } catch (error) {
    const name = (error as { name?: unknown }).name;
    const status = (error as { getStatus?: () => number }).getStatus?.();
    const refusal =
      name === 'GraphValidationError' ||
      name === 'GraphInvariantError' ||
      name === 'GraphDuplicateError' ||
      status === 400 ||
      status === 404;
    if (!refusal) throw error;
    ctx.refusals.push({ fixtureId: ctx.fixture.id, row, reason: reasonOf(error) });
    return null;
  }
}

/** A label's evidence as write-service input, anchored to the rows this run created. */
function toEvidence(ctx: Ctx, labels: readonly EvidenceLabel[]): EvidenceInput[] {
  const out: EvidenceInput[] = [];
  for (const ev of labels) {
    const quote = ev.quote.slice(0, 400);
    if (ev.source === 'segment') {
      const segment = ctx.segmentRows.get(ev.segmentId);
      if (!segment) {
        ctx.warnings.push(`${ctx.fixture.id}: evidence cites unknown segment "${ev.segmentId}"`);
        continue;
      }
      out.push(evidenceInput({ transcriptId: segment.transcriptId, segmentId: segment.id, startMs: segment.startMs, endMs: segment.endMs, quote }));
    } else {
      const noteId = ctx.idMap.notes.get(ctx.fixture.id);
      if (!noteId) {
        ctx.warnings.push(`${ctx.fixture.id}: evidence cites the meeting's note, which it has none of`);
        continue;
      }
      out.push(evidenceInput({ noteId, noteVersion: ctx.fixture.note.version, quote }));
    }
  }
  return out;
}

/** A full {@link EvidenceInput} (every anchor field `null` unless given). */
function evidenceInput(fields: Partial<EvidenceInput> & { quote: string }): EvidenceInput {
  return {
    transcriptId: null,
    segmentId: null,
    segmentRev: null,
    startMs: null,
    endMs: null,
    noteId: null,
    noteVersion: null,
    charStart: null,
    charEnd: null,
    importObjectId: null,
    sourceIri: null,
    ...fields,
  };
}

/**
 * Maps the subject's evidence rows that are not mapped yet to their fixture
 * source (`"m01-s009"`, `"m01#note"`). The write service's creates return the
 * row, not its evidence, so the ids are read back by subject.
 */
async function mapEvidence(ctx: Ctx, subjectKind: 'entity' | 'relation' | 'item', subjectId: string): Promise<void> {
  const rows = await ctx.tx.kgEvidence.findMany({
    where: { subjectKind, subjectId },
    select: { id: true, segmentId: true, noteId: true },
  });
  for (const row of rows) {
    if (ctx.idMap.evidenceSource.has(row.id)) continue;
    const source = row.segmentId
      ? ctx.segmentSource.get(row.segmentId)
      : row.noteId
        ? `${ctx.noteSource.get(row.noteId)}#note`
        : undefined;
    if (source) ctx.idMap.evidenceSource.set(row.id, source);
  }
}

/** Creates one accepted entity with its aliases and evidence; maps the evidence. */
async function createEntity(
  ctx: Ctx,
  row: string,
  entity: { type: string; label: string; aliases: Iterable<string> },
  evidence: EvidenceInput[],
  mapIt = true,
): Promise<string | null> {
  const created = await attempt(ctx, row, () =>
    ctx.writer.createEntity(
      ctx.tx as unknown as WriterTx,
      {
        ownerId: ctx.ownerId,
        type: entity.type,
        label: entity.label,
        props: {},
        reviewStatus: 'accepted',
        labelSource: 'extraction',
        aliases: [...entity.aliases].map((alias) => ({ alias, source: 'extraction' as const })),
        evidence,
      },
      ctx.schema,
    ),
  );
  if (!created) return null;
  ctx.counts.entities += 1;
  ctx.counts.evidence += evidence.length;
  if (mapIt) await mapEvidence(ctx, 'entity', created.id);
  return created.id;
}

/** Adds evidence to an entity an earlier label already created; maps the new rows. */
async function addEntityEvidence(ctx: Ctx, row: string, entityId: string, evidence: EvidenceInput[]): Promise<void> {
  if (evidence.length === 0) return;
  const added = await attempt(ctx, row, () =>
    ctx.writer.addEvidence(ctx.tx as unknown as WriterTx, ctx.ownerId, 'entity', entityId, evidence),
  );
  if (!added) return;
  ctx.counts.evidence += added.length;
  await mapEvidence(ctx, 'entity', entityId);
}

/** One entity label of one fixture → its `kg_entities.id`, creating it (or its global row) exactly once. */
async function resolveEntity(ctx: Ctx, entity: GoldenEntityLabel, row: string): Promise<void> {
  const evidence = toEvidence(ctx, entity.evidence);
  const globalId = globalIdFor(ctx, entity);
  if (globalId) {
    const already = ctx.globalEntityId.get(globalId);
    if (already) {
      ctx.localEntityId.set(entity.key, already);
      await addEntityEvidence(ctx, row, already, evidence);
      return;
    }
    const catalogEntry = ctx.globalCatalog.get(globalId);
    const id = await createEntity(
      ctx,
      row,
      {
        type: catalogEntry?.type ?? entity.type,
        label: catalogEntry?.label ?? entity.label,
        aliases: catalogEntry ? catalogEntry.aliases : entity.aliases,
      },
      evidence,
    );
    if (!id) return;
    ctx.globalEntityId.set(globalId, id);
    ctx.idMap.entities.set(globalId, id);
    ctx.localEntityId.set(entity.key, id);
    return;
  }
  const id = await createEntity(ctx, row, entity, evidence);
  if (id) ctx.localEntityId.set(entity.key, id);
}

/** A `knownEntities` id this fixture names without restating it as one of its labels: created once, from the catalog. */
async function resolveKnownEntityRef(ctx: Ctx, globalId: string): Promise<string | null> {
  const already = ctx.globalEntityId.get(globalId);
  if (already) return already;
  const entry = ctx.globalCatalog.get(globalId);
  if (!entry) return null;
  const noteId = ctx.idMap.notes.get(ctx.fixture.id);
  if (!noteId) {
    ctx.warnings.push(`${ctx.fixture.id}: reference-only entity "${globalId}" has no note to cite`);
    return null;
  }
  // The filler citation (see the header): the referring meeting's note, the label as the quote.
  const filler = [evidenceInput({ noteId, noteVersion: ctx.fixture.note.version, quote: entry.label.slice(0, 400) })];
  const id = await createEntity(ctx, `reference-only entity ${globalId} (${entry.type})`, entry, filler, false);
  if (!id) return null;
  ctx.globalEntityId.set(globalId, id);
  ctx.idMap.entities.set(globalId, id);
  return id;
}

/** A relation's `from`/`to`, an item's `subject`/`owner`/`counterparty`: a local key, or a global (`knownEntities`) id. */
async function resolveRef(ctx: Ctx, ref: string | null): Promise<string | null> {
  if (ref === null) return null;
  const local = ctx.localEntityId.get(ref);
  if (local) return local;
  if (ctx.globalCatalog.has(ref)) return resolveKnownEntityRef(ctx, ref);
  ctx.warnings.push(`${ctx.fixture.id}: unresolved entity reference "${ref}"`);
  return null;
}

/** `YYYY-MM-DD` bounds → a range, or `null` when both are open. */
function toValidRange(validFrom: string | null, validTo: string | null): { from: Date | null; to: Date | null } | null {
  if (validFrom === null && validTo === null) return null;
  return { from: validFrom ? new Date(`${validFrom}T00:00:00Z`) : null, to: validTo ? new Date(`${validTo}T00:00:00Z`) : null };
}

async function seedTranscriptAndNote(ctx: Ctx): Promise<void> {
  const { tx, fixture } = ctx;
  let transcriptId: string | null = null;
  if (fixture.hasTranscript) {
    const source = await tx.storageObject.create({
      data: {
        name: `${fixture.id}.m4a`,
        size: BigInt(1),
        mimeType: 'audio/mp4',
        storageKey: `ask-eval/${randomUUID()}`,
        orgId: ctx.orgId,
        uploadedById: ctx.ownerId,
      },
    });
    const transcript = await tx.transcript.create({
      data: {
        ownerId: ctx.ownerId,
        orgId: ctx.orgId,
        title: fixture.title,
        sourceObjectId: source.id,
        provider: 'assemblyai',
        status: 'ready',
        transcriptionStatus: 'completed',
        playbackStatus: 'ready',
        recordedAt: new Date(fixture.recordedAt),
      },
    });
    transcriptId = transcript.id;
    const speakerId = new Map<string, string>();
    for (const [i, speaker] of fixture.speakers.entries()) {
      const row = await tx.transcriptSpeaker.create({
        data: { transcriptId: transcript.id, label: speaker.label, displayName: speaker.displayName ?? speaker.label, colorIndex: i % 8 },
      });
      speakerId.set(speaker.id, row.id);
    }
    for (const segment of fixture.segments) {
      const row = await tx.transcriptSegment.create({
        data: {
          transcriptId: transcript.id,
          speakerId: speakerId.get(segment.speakerId) ?? [...speakerId.values()][0],
          startMs: segment.startMs,
          endMs: segment.endMs,
          ordinal: segment.startMs,
          text: segment.text,
          words: [],
        },
      });
      ctx.idMap.segments.set(segment.id, row.id);
      ctx.segmentSource.set(row.id, segment.id);
      ctx.segmentRows.set(segment.id, { id: row.id, transcriptId: transcript.id, startMs: segment.startMs, endMs: segment.endMs });
    }
  }

  let sourceObjectId: string | null = null;
  if (!fixture.hasTranscript) {
    const doc = await tx.storageObject.create({
      data: {
        name: `${fixture.id}.md`,
        size: BigInt(fixture.note.body.length),
        mimeType: 'text/markdown',
        storageKey: `ask-eval/${randomUUID()}`,
        orgId: ctx.orgId,
        uploadedById: ctx.ownerId,
      },
    });
    sourceObjectId = doc.id;
  }

  const note = await tx.note.create({
    data: {
      ownerId: ctx.ownerId,
      title: fixture.title,
      body: fixture.note.body,
      status: 'ready',
      currentVersion: fixture.note.version,
      sourceType: transcriptId ? 'transcript' : 'document',
      sourceTranscriptId: transcriptId,
      sourceObjectId,
      createdAt: new Date(fixture.recordedAt),
    },
  });
  await tx.noteVersion.create({ data: { noteId: note.id, version: fixture.note.version, kind: 'ai_generated', body: fixture.note.body } });
  ctx.idMap.notes.set(fixture.id, note.id);
  ctx.noteSource.set(note.id, fixture.id);
}

async function seedRelations(ctx: Ctx): Promise<void> {
  for (const [index, relation] of ctx.fixture.labels.relations.entries()) {
    const row = `relation #${index + 1} (${relation.type})`;
    const fromId = await resolveRef(ctx, relation.from);
    const toId = await resolveRef(ctx, relation.to);
    if (!fromId || !toId) {
      ctx.refusals.push({ fixtureId: ctx.fixture.id, row, reason: `an endpoint did not resolve (${!fromId ? 'from' : 'to'})` });
      continue;
    }
    const temporal = ctx.schema.relationType(relation.type)?.temporal ?? false;
    const valid = toValidRange(relation.validFrom, relation.validTo);
    // The label's precision travels with its range; a temporal relation with
    // no range keeps `unknown` (the write service's "no range" spelling).
    const validPrecision = valid ? relation.precision : temporal && relation.precision === 'unknown' ? 'unknown' : null;
    const evidence = toEvidence(ctx, relation.evidence);
    const created = await attempt(ctx, row, () =>
      ctx.writer.createRelation(
        ctx.tx as unknown as WriterTx,
        { ownerId: ctx.ownerId, type: relation.type, fromId, toId, props: {}, valid, validPrecision, reviewStatus: 'accepted', evidence },
        ctx.schema,
      ),
    );
    if (!created) continue;
    ctx.counts.relations += 1;
    ctx.counts.evidence += evidence.length;
    await mapEvidence(ctx, 'relation', created.id);
  }
}

/** The ontology type that stores items of `kind`. */
function itemTypeKey(schema: EffectiveSchema, kind: ItemLabelKind): string | null {
  return schema.entityTypes.find((t) => t.storage === 'item' && t.itemKind === kind)?.key ?? null;
}

async function seedItems(ctx: Ctx, meetingId: string | null): Promise<void> {
  const countByKind = new Map<ItemLabelKind, number>();
  for (const item of ctx.fixture.labels.items) {
    const n = countByKind.get(item.kind) ?? 0;
    countByKind.set(item.kind, n + 1);
    const address = itemAddress(ctx.fixture.id, item.kind, n);
    const row = `item ${address}`;

    const typeKey = itemTypeKey(ctx.schema, item.kind);
    if (!typeKey) {
      ctx.refusals.push({ fixtureId: ctx.fixture.id, row, reason: `no item type stores '${item.kind}'` });
      continue;
    }
    const subjectId = await resolveRef(ctx, item.subject);
    const ownerPersonId = await resolveRef(ctx, item.owner);
    const counterpartyId = await resolveRef(ctx, item.counterparty);

    let supersedesId: string | null = null;
    if (item.supersedesLabel) {
      supersedesId = ctx.itemByAddress.get(item.supersedesLabel) ?? null;
      if (!supersedesId) ctx.warnings.push(`${ctx.fixture.id}: ${address} supersedes unknown item address "${item.supersedesLabel}"`);
    }

    // The meeting column only where the ontology has one for this item type (a
    // Commitment or Decision has `meeting_id`; a Claim or PersonFact does not):
    // the web app's seeder stamped it on every item, which the write service refuses.
    const meetingAllowed = ctx.schema.relationTypes.some(
      (r) => r.representation.kind === 'item_column' && r.representation.column === 'meeting_id' && r.from.includes(typeKey),
    );

    const evidence = toEvidence(ctx, item.evidence);
    const created = await attempt(ctx, row, () =>
      ctx.writer.createItem(
        ctx.tx as unknown as WriterTx,
        {
          ownerId: ctx.ownerId,
          kind: item.kind as KgItemKind,
          typeKey,
          subjectId,
          meetingId: meetingAllowed ? meetingId : null,
          ownerPersonId,
          counterpartyId,
          title: item.title,
          statement: item.statement,
          status: item.status ?? (item.kind === 'commitment' || item.kind === 'risk' ? 'open' : 'active'),
          props: item.props,
          occurredAt: item.occurredAt ? new Date(item.occurredAt) : null,
          dueAt: item.dueAt ? new Date(item.dueAt) : null,
          // The web app's seeder default (`business`), kept so the two seed the same graph;
          // the write service's own default for an unlabelled person fact is `personal`.
          sensitivity: item.kind === 'person_fact' ? (item.sensitivity ?? 'business') : null,
          reviewStatus: 'accepted',
          supersedesId,
          evidence,
        },
        ctx.schema,
      ),
    );
    if (!created) continue;
    ctx.counts.items += 1;
    ctx.counts.evidence += evidence.length;
    ctx.itemByAddress.set(address, created.id);
    await mapEvidence(ctx, 'item', created.id);
  }
}

/**
 * Seeds the evaluation user's entire gold graph from EVERY fixture in
 * `fixtures` (pass the full loaded set: `loadGoldenSet()`), one transaction per
 * fixture, in fixture id order, through `GraphWriteService`.
 *
 * @param host - the running host (its client, user and organization, and the write service).
 * @param fixtures - the golden meetings.
 * @returns the id map the scorer needs, the refusals and the warnings.
 * @stability experimental
 */
export async function seedGoldenGraph(host: AskEvalHost, fixtures: readonly GoldenFixture[]): Promise<SeededGoldenGraph> {
  for (const f of fixtures) goldenFixtureSchema.parse(f); // fail loudly on a malformed fixture before writing anything
  const sorted = [...fixtures].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  // The personal domain (Trip, Milestone, SPOUSE_OF, ...) is off by default; the
  // golden set's personal meetings need it on, as `kvox-eval kg` extracts them
  // (`fixtureDomains`). The Ask tools hide personal types whatever this says.
  if (sorted.some((f) => fixtureDomains(f).includes('personal'))) {
    await host.settings.patchUser(host.userId, 'graph', { domains: { work: true, personal: true } });
  }

  const writer = host.resolve(GraphWriteService);
  const schema = await host.resolve(GraphOntologyService).effectiveSchemaFor(host.userId);

  const idMap: AskEvalIdMap = { segments: new Map(), notes: new Map(), entities: new Map(), evidenceSource: new Map() };
  const globalCatalog = buildGlobalCatalog(sorted);
  const shared = {
    writer,
    schema,
    ownerId: host.userId,
    orgId: host.orgId,
    idMap,
    segmentSource: new Map<string, string>(),
    noteSource: new Map<string, string>(),
    globalEntityId: new Map<string, string>(),
    globalCatalog,
    labelToGlobalId: buildLabelIndex(globalCatalog),
    itemByAddress: new Map<string, string>(),
    refusals: [] as AskEvalSeedRefusal[],
    warnings: [] as string[],
    counts: { entities: 0, relations: 0, items: 0, evidence: 0 },
  };

  for (const fixture of sorted) {
    await host.prisma.$transaction(
      async (tx) => {
        const ctx = { ...shared, tx, fixture, localEntityId: new Map<string, string>(), segmentRows: new Map<string, SegmentRow>() };
        await seedTranscriptAndNote(ctx);
        for (const [index, entity] of fixture.labels.entities.entries()) {
          await resolveEntity(ctx, entity, `entity #${index + 1} (${entity.type})`);
        }
        const meetingEntityId = ctx.localEntityId.get('meeting') ?? null;
        await seedRelations(ctx);
        await seedItems(ctx, meetingEntityId);
      },
      { timeout: 120_000, maxWait: 120_000 },
    );
  }

  return { userId: host.userId, idMap, refusals: shared.refusals, warnings: shared.warnings, counts: shared.counts };
}

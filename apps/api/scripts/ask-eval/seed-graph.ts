// =============================================================================
// The Ask evaluation's gold graph seeder (issue #382, epic #348)
// =============================================================================
//
// Loads EVERY meeting of #362's golden set and writes it as one throwaway
// user's data: a `transcripts`/`transcript_speakers`/`transcript_segments`
// row per meeting with a transcript, a `notes`/`note_versions` row for every
// meeting, and the meeting's HAND LABELS (never a model's extraction) as
// `accepted` `kg_entities`/`kg_relations`/`kg_items` rows with `kg_evidence`
// pointing at the segments/note it just created. This is what makes the
// evaluation ISOLATE the agent: extraction quality is #362's `kg:eval`, not
// this harness's problem.
//
// AN ENTITY THAT RECURS ACROSS MEETINGS BECOMES ONE ROW, not one per meeting.
// A fixture's `knownEntities[].id` (e.g. `"g-person-sarah-chen"`) is the
// stable, cross-fixture identity a later meeting's `existingId` links back
// to; fixtures are seeded in id order so a person's first mention (which
// never carries `existingId`) creates the row, and a later fixture's
// `existingId` — or, for a person the SAME meeting introduces without one
// yet appearing as `existingId` (the meeting that makes them first known) —
// resolves to it by matching type + normalized label/alias against every
// `knownEntities` entry any fixture ever declares for that global id. A
// label that never appears in any `knownEntities` list stays a one-off row
// local to its own meeting, which is correct: most of this corpus's people
// are seen exactly once.
//
// Every accepted row's evidence is written in the SAME transaction as the
// row (§ the deferred `kg_assert_has_evidence` trigger, `docs/specs
// /ontology.md` — see the `Database Tables` entry for `kg_evidence` in
// CLAUDE.md), and `supersedesLabel` is resolved against items already
// created by an EARLIER fixture (fixtures are processed in id order, and no
// fixture supersedes a later one in this corpus) via `itemsByAddress` (#362).
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';

import {
  goldenFixtureSchema,
  itemAddress,
  type GoldenFixture,
  type GoldenEntityLabel,
  type GoldenItemLabel,
  type GoldenRelationLabel,
  type ItemLabelKind,
} from '../kg-eval/fixture-schema';

/** Every email this seeder's throwaway user gets starts with this. */
export const ASK_EVAL_EMAIL_PREFIX = 'ask-eval';

export class UnsafeDatabaseError extends Error {}

/**
 * Refuses to run against a database that is not obviously a scratch one.
 * `--allow-db <name>` (checked by the caller against the ACTUAL configured
 * name) is the only override — see `apps/api/scripts/ask-eval.ts`.
 */
export function assertSafeDatabase(databaseName: string, allowDb: string | null): void {
  if (databaseName === allowDb) return;
  if (/_test$/.test(databaseName) || /_eval$/.test(databaseName)) return;
  throw new UnsafeDatabaseError(
    `refusing to seed the gold graph into database "${databaseName}" — its name doesn't end in ` +
      `"_test" or "_eval". Point POSTGRES_DB at a scratch database, or pass --allow-db "${databaseName}" ` +
      `if you are certain (it will be filled with synthetic data and then have a user deleted from it).`,
  );
}

/** Fixture ids / labels ↔ the database rows the seeder wrote for them. */
export interface AskEvalIdMap {
  /** `"m01-s009"` → the real `transcript_segments.id`. */
  segments: Map<string, string>;
  /** Fixture id → that meeting's `notes.id`. */
  notes: Map<string, string>;
  /** `"m01#meeting"`/a fixture's own local entity key, or a global id → `kg_entities.id`. Mostly for debugging. */
  entities: Map<string, string>;
  /** `kg_evidence.id` → `"m01-s009"` or `"m01#note"` — what `citeFrom` checks resolve against. */
  evidenceSource: Map<string, string>;
}

export interface SeededGraph {
  userId: string;
  email: string;
  idMap: AskEvalIdMap;
}

interface Ctx {
  tx: Prisma.TransactionClient;
  ownerId: string;
  idMap: AskEvalIdMap;
  /** Global cross-fixture identity → its `kg_entities.id`, once created. */
  globalEntityId: Map<string, string>;
  /** Global identity → its declared type/label/aliases, gathered from every fixture's `knownEntities`. */
  globalCatalog: Map<string, { type: string; label: string; aliases: Set<string> }>;
  /** `type + "\u0000" + normalized(label-or-alias)` → the global id it belongs to, once any fixture declares it known. */
  labelToGlobalId: Map<string, string>;
  /** This fixture's local entity key → `kg_entities.id`, reset per fixture. */
  localEntityId: Map<string, string>;
  /** Cross-fixture item address (`"m03#claim-1"`) → `kg_items.id`, accumulated across the whole run. */
  itemByAddress: Map<string, string>;
  warnings: string[];
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

/** The global identity this label resolves to, if any — `existingId`, else a label/alias match against the catalog. */
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

async function upsertEntity(ctx: Ctx, type: string, label: string, aliases: string[]): Promise<string> {
  const id = randomUUID();
  await ctx.tx.kgEntity.create({
    data: { id, ownerId: ctx.ownerId, type, label, props: {}, reviewStatus: 'accepted', ontologyVersion: '1.0.0' },
  });
  for (const alias of [label, ...aliases]) {
    await ctx.tx.kgEntityAlias.create({
      data: { entityId: id, ownerId: ctx.ownerId, alias, normalized: normalize(alias), source: 'extraction' },
    });
  }
  return id;
}

/** One entity label of one fixture → its `kg_entities.id`, creating it (or its global row) exactly once. */
async function resolveEntity(ctx: Ctx, entity: GoldenEntityLabel): Promise<string> {
  const globalId = globalIdFor(ctx, entity);
  if (globalId) {
    const already = ctx.globalEntityId.get(globalId);
    if (already) {
      ctx.localEntityId.set(entity.key, already);
      return already;
    }
    const catalogEntry = ctx.globalCatalog.get(globalId);
    const id = await upsertEntity(
      ctx,
      catalogEntry?.type ?? entity.type,
      catalogEntry?.label ?? entity.label,
      [...(catalogEntry ? catalogEntry.aliases : new Set(entity.aliases))],
    );
    ctx.globalEntityId.set(globalId, id);
    ctx.idMap.entities.set(globalId, id);
    ctx.localEntityId.set(entity.key, id);
    return id;
  }
  const id = await upsertEntity(ctx, entity.type, entity.label, entity.aliases);
  ctx.localEntityId.set(entity.key, id);
  return id;
}

/** `knownEntities` this fixture names but never restates as one of its own labels — created once, from the catalog. */
async function resolveKnownEntityRef(ctx: Ctx, globalId: string): Promise<string> {
  const already = ctx.globalEntityId.get(globalId);
  if (already) return already;
  const entry = ctx.globalCatalog.get(globalId);
  if (!entry) throw new Error(`reference to unknown global entity "${globalId}" with no knownEntities declaration anywhere`);
  const id = await upsertEntity(ctx, entry.type, entry.label, [...entry.aliases]);
  ctx.globalEntityId.set(globalId, id);
  ctx.idMap.entities.set(globalId, id);
  // This entity is created purely from a `knownEntities` catalog entry —
  // never its own `labels.entities` row anywhere with a real evidence array
  // — so nothing else in this seeder will ever evidence it. `accepted`
  // requires at least one row (the deferred `kg_assert_has_evidence`
  // trigger), so it gets the same "quote is the label" filler
  // `graph-read.fixtures.ts`'s `GraphFixture.entity()` uses for the same
  // reason: satisfying the invariant honestly beats leaving a row this
  // transaction cannot commit.
  await ctx.tx.kgEvidence.create({
    data: { ownerId: ctx.ownerId, subjectKind: 'entity', subjectId: id, quote: entry.label.slice(0, 400) },
  });
  return id;
}

/** A relation's `from`/`to`, an item's `subject`/`owner`/`counterparty`: a local key, or a global (`knownEntities`) id. */
async function resolveRef(ctx: Ctx, ref: string | null): Promise<string | null> {
  if (ref === null) return null;
  const local = ctx.localEntityId.get(ref);
  if (local) return local;
  if (ctx.globalCatalog.has(ref)) return resolveKnownEntityRef(ctx, ref);
  ctx.warnings.push(`unresolved entity reference "${ref}"`);
  return null;
}

function toValidRangeLiteral(validFrom: string | null, validTo: string | null): string | null {
  if (validFrom === null && validTo === null) return null;
  return `[${validFrom ?? ''},${validTo ?? ''})`;
}

async function writeEvidence(
  ctx: Ctx,
  fixture: GoldenFixture,
  subjectKind: 'entity' | 'relation' | 'item',
  subjectId: string,
  evidence: GoldenEntityLabel['evidence'],
): Promise<void> {
  for (const ev of evidence) {
    if (ev.source === 'segment') {
      const segmentId = ctx.idMap.segments.get(ev.segmentId);
      if (!segmentId) {
        ctx.warnings.push(`evidence cites unknown segment "${ev.segmentId}"`);
        continue;
      }
      // The evidence anchors a real segment, so its transcript id and
      // timing come straight off that row rather than being threaded
      // through every caller.
      const segRow = await ctx.tx.transcriptSegment.findUniqueOrThrow({
        where: { id: segmentId },
        select: { transcriptId: true, startMs: true, endMs: true },
      });
      const row = await ctx.tx.kgEvidence.create({
        data: {
          ownerId: ctx.ownerId,
          subjectKind,
          subjectId,
          segmentId,
          transcriptId: segRow.transcriptId,
          startMs: segRow.startMs,
          endMs: segRow.endMs,
          quote: ev.quote.slice(0, 400),
        },
      });
      ctx.idMap.evidenceSource.set(row.id, ev.segmentId);
    } else {
      const noteId = ctx.idMap.notes.get(fixture.id);
      if (!noteId) {
        ctx.warnings.push(`evidence cites the note of fixture "${fixture.id}", which has none`);
        continue;
      }
      const row = await ctx.tx.kgEvidence.create({
        data: { ownerId: ctx.ownerId, subjectKind, subjectId, noteId, noteVersion: 1, quote: ev.quote.slice(0, 400) },
      });
      ctx.idMap.evidenceSource.set(row.id, `${fixture.id}#note`);
    }
  }
}

async function seedTranscriptAndNote(ctx: Ctx, fixture: GoldenFixture): Promise<{ transcriptId: string | null }> {
  let transcriptId: string | null = null;
  if (fixture.hasTranscript) {
    const source = await ctx.tx.storageObject.create({
      data: {
        name: `${fixture.id}.m4a`,
        size: BigInt(1),
        mimeType: 'audio/mp4',
        storageKey: `${ASK_EVAL_EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: ctx.ownerId,
      },
    });
    const transcript = await ctx.tx.transcript.create({
      data: {
        ownerId: ctx.ownerId,
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
      const row = await ctx.tx.transcriptSpeaker.create({
        data: {
          transcriptId: transcript.id,
          label: speaker.label,
          displayName: speaker.displayName ?? speaker.label,
          colorIndex: i % 8,
        },
      });
      speakerId.set(speaker.id, row.id);
    }
    for (const segment of fixture.segments) {
      const row = await ctx.tx.transcriptSegment.create({
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
    }
  }

  let sourceObjectId: string | null = null;
  if (!fixture.hasTranscript) {
    const doc = await ctx.tx.storageObject.create({
      data: {
        name: `${fixture.id}.md`,
        size: BigInt(fixture.note.body.length),
        mimeType: 'text/markdown',
        storageKey: `${ASK_EVAL_EMAIL_PREFIX}/${randomUUID()}`,
        managedBy: 'notes',
        uploadedById: ctx.ownerId,
      },
    });
    sourceObjectId = doc.id;
  }

  const note = await ctx.tx.note.create({
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
  await ctx.tx.noteVersion.create({
    data: { noteId: note.id, version: fixture.note.version, kind: 'ai_generated', body: fixture.note.body },
  });
  ctx.idMap.notes.set(fixture.id, note.id);
  return { transcriptId };
}

async function seedEntities(ctx: Ctx, fixture: GoldenFixture): Promise<void> {
  for (const entity of fixture.labels.entities) {
    const id = await resolveEntity(ctx, entity);
    await writeEvidence(ctx, fixture, 'entity', id, entity.evidence);
  }
}

async function seedRelations(ctx: Ctx, fixture: GoldenFixture): Promise<void> {
  for (const relation of fixture.labels.relations as GoldenRelationLabel[]) {
    const fromId = await resolveRef(ctx, relation.from);
    const toId = await resolveRef(ctx, relation.to);
    if (!toId) continue; // `to` is never null in this ontology; a miss means an unresolved reference.
    const id = randomUUID();
    await ctx.tx.kgRelation.create({
      data: { id, ownerId: ctx.ownerId, type: relation.type, fromId, toId, reviewStatus: 'accepted', ontologyVersion: '1.0.0' },
    });
    const range = toValidRangeLiteral(relation.validFrom, relation.validTo);
    if (range !== null) {
      await ctx.tx.$executeRaw`UPDATE kg_relations SET valid = ${range}::tstzrange, valid_precision = ${relation.precision}::"kg_valid_precision" WHERE id = ${id}::uuid`;
    }
    await writeEvidence(ctx, fixture, 'relation', id, relation.evidence);
  }
}

async function seedItems(ctx: Ctx, fixture: GoldenFixture, meetingId: string | null): Promise<void> {
  const countByKind = new Map<ItemLabelKind, number>();
  for (const item of fixture.labels.items as GoldenItemLabel[]) {
    const n = countByKind.get(item.kind) ?? 0;
    countByKind.set(item.kind, n + 1);

    const subjectId = await resolveRef(ctx, item.subject);
    const ownerPersonId = await resolveRef(ctx, item.owner);
    const counterpartyId = await resolveRef(ctx, item.counterparty);
    const id = randomUUID();
    await ctx.tx.kgItem.create({
      data: {
        id,
        ownerId: ctx.ownerId,
        kind: item.kind,
        subjectId,
        ownerPersonId,
        counterpartyId,
        meetingId,
        title: item.title,
        statement: item.statement,
        status: item.status ?? (item.kind === 'commitment' ? 'open' : 'active'),
        occurredAt: item.occurredAt ? new Date(item.occurredAt) : null,
        dueAt: item.dueAt ? new Date(item.dueAt) : null,
        sensitivity: item.kind === 'person_fact' ? (item.sensitivity ?? 'business') : null,
        statementHash: randomUUID(),
        reviewStatus: 'accepted',
        ontologyVersion: '1.0.0',
      },
    });
    ctx.itemByAddress.set(itemAddress(fixture.id, item.kind, n), id);
    await writeEvidence(ctx, fixture, 'item', id, item.evidence);

    if (item.supersedesLabel) {
      const oldId = ctx.itemByAddress.get(item.supersedesLabel);
      if (oldId) {
        await ctx.tx.kgItem.update({ where: { id: oldId }, data: { status: 'superseded', supersededById: id } });
      } else {
        ctx.warnings.push(`"${item.title}" (${fixture.id}) supersedes unknown item address "${item.supersedesLabel}"`);
      }
    }
  }
}

/**
 * Seeds one throwaway user's entire gold graph from EVERY fixture in
 * `fixtures` (the caller passes #362's full loaded set — see
 * `loadGoldenSet()`). One transaction per fixture, in fixture id order.
 */
export async function seedGraph(prisma: PrismaClient, fixtures: GoldenFixture[]): Promise<SeededGraph> {
  for (const f of fixtures) goldenFixtureSchema.parse(f); // fail loudly on a malformed fixture before writing anything
  const sorted = [...fixtures].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));

  const email = `${ASK_EVAL_EMAIL_PREFIX}+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const user = await prisma.user.create({ data: { email, isActive: true } });

  const idMap: AskEvalIdMap = {
    segments: new Map(),
    notes: new Map(),
    entities: new Map(),
    evidenceSource: new Map(),
  };
  const globalCatalog = buildGlobalCatalog(sorted);
  const labelToGlobalId = buildLabelIndex(globalCatalog);
  const globalEntityId = new Map<string, string>();
  const itemByAddress = new Map<string, string>();
  const warnings: string[] = [];

  for (const fixture of sorted) {
    await prisma.$transaction(
      async (tx) => {
        const ctx: Ctx = {
          tx,
          ownerId: user.id,
          idMap,
          globalEntityId,
          globalCatalog,
          labelToGlobalId,
          localEntityId: new Map(),
          itemByAddress,
          warnings,
        };
        await seedTranscriptAndNote(ctx, fixture);
        await seedEntities(ctx, fixture);
        const meetingEntityId = ctx.localEntityId.get('meeting') ?? null;
        await seedRelations(ctx, fixture);
        await seedItems(ctx, fixture, meetingEntityId);
      },
      { timeout: 60_000 },
    );
  }

  if (warnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`ask-eval seeder: ${warnings.length} warning(s) while seeding:\n  ${warnings.join('\n  ')}`);
  }

  return { userId: user.id, email, idMap };
}

/** Deletes the throwaway user and everything owned by it. Mirrors `cleanupGraphFixtures`'s technique. */
export async function teardownSeededGraph(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.kgEntityView.deleteMany({ where: { userId } });
      await tx.kgMention.deleteMany({ where: { ownerId: userId } });
      await tx.kgEvidence.deleteMany({ where: { ownerId: userId } });
      await tx.kgRelation.deleteMany({ where: { ownerId: userId } });
      await tx.kgItem.deleteMany({ where: { ownerId: userId } });
      await tx.kgEntityAlias.deleteMany({ where: { ownerId: userId } });
      await tx.kgEntity.deleteMany({ where: { ownerId: userId } });
      await tx.askMessage.deleteMany({ where: { conversation: { ownerId: userId } } });
      await tx.askConversation.deleteMany({ where: { ownerId: userId } });
      await tx.transcriptSegment.deleteMany({ where: { transcript: { ownerId: userId } } });
      await tx.transcriptSpeaker.deleteMany({ where: { transcript: { ownerId: userId } } });
      await tx.transcript.deleteMany({ where: { ownerId: userId } });
      await tx.noteVersion.deleteMany({ where: { note: { ownerId: userId } } });
      await tx.note.deleteMany({ where: { ownerId: userId } });
      await tx.storageObject.deleteMany({ where: { uploadedById: userId } });
      await tx.userAiCredential.deleteMany({ where: { userId } });
      await tx.job.deleteMany({ where: { payload: { path: ['userId'], equals: userId } } });
      await tx.userRole.deleteMany({ where: { userId } });
      await tx.user.deleteMany({ where: { id: userId } });
    },
    { timeout: 120_000 },
  );
}

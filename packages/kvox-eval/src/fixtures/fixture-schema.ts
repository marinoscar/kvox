// =============================================================================
// The knowledge-graph golden set: fixture schema (issue #362, epic #346)
// =============================================================================
//
// One JSON file per synthetic meeting under
// `packages/kvox-eval/fixtures/kg-golden/meetings/mNN-<slug>.json`. The file carries
// the raw material an extraction run reads (segments, the note body, Context,
// the prior graph state as `knownEntities`) AND the hand labels a run is
// scored against (`labels`). See the README beside the fixtures for the
// authoring rules; `docs/specs/ontology.md` §6 for why the set exists.
//
// This file lives in `@marinoscar/kvox-eval` (issue #580), never in an app's
// `src/`: no production build of the API or the web app compiles it. The app
// reaches it only from its `scripts/` and its specs.
//
// Reference conventions used by the labels:
//   - an entity label's `key` is local to its fixture ("sarah", "meeting");
//   - a relation's `from`/`to` and an item's `subject`/`owner`/`counterparty`
//     name either such a key or a `knownEntities` id ("g-person-sarah-chen");
//   - an item is addressed from another fixture as `<fixtureId>#<kind>-<n>`,
//     `n` being its 1-based position among that fixture's items of that kind
//     ("m03#claim-1") — that is what `supersedesLabel` holds.
// =============================================================================

import { z } from 'zod';

/**
 * One citation of a gold label: a transcript segment and a verbatim quote from it,
 * or a verbatim quote from the note body.
 *
 * @stability experimental
 */
export const evidenceLabelSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('segment'), segmentId: z.string(), quote: z.string().min(1).max(400) }),
  z.object({ source: z.literal('note'), quote: z.string().min(1).max(400) }),
]);
/**
 * A parsed {@link evidenceLabelSchema}.
 *
 * @stability experimental
 */
export type EvidenceLabel = z.infer<typeof evidenceLabelSchema>;

/**
 * The precision of a temporal label (docs/specs/ontology.md §5.4): `unknown` means both bounds are `null`.
 *
 * @stability experimental
 */
export const validPrecisionSchema = z.enum(['day', 'month', 'year', 'unknown']);
/**
 * A parsed {@link validPrecisionSchema}.
 *
 * @stability experimental
 */
export type ValidPrecisionLabel = z.infer<typeof validPrecisionSchema>;

/**
 * A calendar date, `YYYY-MM-DD`.
 *
 * @stability experimental
 */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The item kinds a fixture labels.
 *
 * @stability experimental
 */
export const ITEM_LABEL_KINDS = ['commitment', 'decision', 'claim', 'person_fact', 'risk'] as const;
/**
 * One of {@link ITEM_LABEL_KINDS}.
 *
 * @stability experimental
 */
export type ItemLabelKind = (typeof ITEM_LABEL_KINDS)[number];

const propsSchema = z.record(z.string(), z.unknown()).default({});

/**
 * A gold entity row: `key` is local to its fixture, `existingId` names the known entity a resolver must link it to.
 *
 * @stability experimental
 */
export const goldenEntityLabelSchema = z.object({
  key: z.string().min(1),
  type: z.string(),
  label: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** When set, a resolver must link this mention to that `knownEntities` id. */
  existingId: z.string().nullable().default(null),
  props: propsSchema,
  evidence: z.array(evidenceLabelSchema).min(1),
});
/**
 * A parsed {@link goldenEntityLabelSchema}.
 *
 * @stability experimental
 */
export type GoldenEntityLabel = z.infer<typeof goldenEntityLabelSchema>;

/**
 * A gold edge: `from`/`to` name a label key or a known entity id; temporal bounds per §5.4.
 *
 * @stability experimental
 */
export const goldenRelationLabelSchema = z.object({
  type: z.string(),
  from: z.string(),
  to: z.string(),
  validFrom: isoDateSchema.nullable(),
  validTo: isoDateSchema.nullable(),
  precision: validPrecisionSchema,
  props: propsSchema,
  evidence: z.array(evidenceLabelSchema).min(1),
});
/**
 * A parsed {@link goldenRelationLabelSchema}.
 *
 * @stability experimental
 */
export type GoldenRelationLabel = z.infer<typeof goldenRelationLabelSchema>;

/**
 * A gold commitment, decision, risk, claim or person fact, with its owner and counterparty columns.
 *
 * @stability experimental
 */
export const goldenItemLabelSchema = z.object({
  kind: z.enum(ITEM_LABEL_KINDS),
  subject: z.string(),
  owner: z.string().nullable().default(null),
  counterparty: z.string().nullable().default(null),
  title: z.string().min(1),
  statement: z.string().min(1),
  /** Commitment: `open | done | dropped`. Risk: `open | mitigated | closed`. Null for every other kind. */
  status: z.enum(['open', 'done', 'dropped', 'mitigated', 'closed']).nullable().default(null),
  occurredAt: isoDateSchema.nullable(),
  dueAt: isoDateSchema.nullable(),
  sensitivity: z.enum(['business', 'personal', 'sensitive']).nullable().default(null),
  /** The item type's own attributes (a Risk's `severity`, `riskKind`, `mitigation`); validated against the ontology. */
  props: propsSchema,
  /** `<fixtureId>#<kind>-<n>`: the earlier item this one replaces. */
  supersedesLabel: z.string().nullable().default(null),
  evidence: z.array(evidenceLabelSchema).min(1),
});
/**
 * A parsed {@link goldenItemLabelSchema}.
 *
 * @stability experimental
 */
export type GoldenItemLabel = z.infer<typeof goldenItemLabelSchema>;

/**
 * One synthetic meeting of the golden set: the raw material an extraction run reads
 * (segments, note, Context, the prior graph) and the hand labels it is scored against.
 *
 * @stability experimental
 */
export const goldenFixtureSchema = z.object({
  id: z.string().regex(/^m\d{2,3}$/),
  title: z.string().min(1),
  tags: z.array(z.string()),
  /** The meeting date — the anchor every relative date resolves against (§5.4). */
  recordedAt: z.string().datetime(),
  /** The note's Context field, as the user typed it. */
  contextText: z.string().nullable(),
  /** false = a note-only meeting: no speakers, no segments, note evidence only. */
  hasTranscript: z.boolean(),
  speakers: z.array(z.object({ id: z.string(), label: z.string(), displayName: z.string().nullable() })),
  segments: z.array(
    z.object({
      id: z.string(),
      speakerId: z.string(),
      startMs: z.number().int(),
      endMs: z.number().int(),
      rev: z.number().int().default(1),
      text: z.string().min(1),
    }),
  ),
  note: z.object({ version: z.number().int().default(1), body: z.string().min(1) }),
  /** The graph as it stood before this meeting: what resolution may link to. */
  knownEntities: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        label: z.string(),
        aliases: z.array(z.string()),
        props: propsSchema,
        attendedFixtureIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /**
   * #365: the prior graph's accepted temporal/other edges between known
   * entities, so the in-memory `work-item-dedup`/`temporal-closing` pass has
   * something to find `known` and to close. Optional; absent = none.
   */
  knownRelations: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        from: z.string(),
        to: z.string(),
        props: propsSchema,
        validFrom: isoDateSchema.nullable().default(null),
        validTo: isoDateSchema.nullable().default(null),
        precision: validPrecisionSchema.default('unknown'),
      }),
    )
    .default([]),
  labels: z.object({
    entities: z.array(goldenEntityLabelSchema),
    relations: z.array(goldenRelationLabelSchema),
    items: z.array(goldenItemLabelSchema),
    /** §5.1 negative examples: text a correct extractor must NOT turn into a row. */
    negatives: z.array(z.object({ quote: z.string(), why: z.string() })).default([]),
  }),
});

/**
 * A parsed golden fixture (defaults applied).
 *
 * @stability experimental
 */
export type GoldenFixture = z.infer<typeof goldenFixtureSchema>;
/**
 * A golden fixture as written on disk (before defaults), the shape an exported skeleton takes.
 *
 * @stability experimental
 */
export type GoldenFixtureInput = z.input<typeof goldenFixtureSchema>;

/**
 * `m03#claim-1`: the address an item is known by across the set.
 *
 * @param fixtureId - the fixture the item is labelled in.
 * @param kind - the item's kind.
 * @param indexWithinKind - its 0-based position among that fixture's items of that kind.
 * @returns the address.
 * @stability experimental
 */
export function itemAddress(fixtureId: string, kind: ItemLabelKind, indexWithinKind: number): string {
  return `${fixtureId}#${kind}-${indexWithinKind + 1}`;
}

/**
 * Every item in a fixture keyed by its cross-fixture address.
 *
 * @param fixture - the fixture.
 * @returns the items by {@link itemAddress}.
 * @stability experimental
 */
export function itemsByAddress(fixture: GoldenFixture): Map<string, GoldenItemLabel> {
  const counters = new Map<ItemLabelKind, number>();
  const out = new Map<string, GoldenItemLabel>();
  for (const item of fixture.labels.items) {
    const n = counters.get(item.kind) ?? 0;
    counters.set(item.kind, n + 1);
    out.set(itemAddress(fixture.id, item.kind, n), item);
  }
  return out;
}

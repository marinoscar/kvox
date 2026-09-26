// =============================================================================
// The item adjudication prompt (issue #365; docs/specs/ontology.md §7, §15, §20)
// =============================================================================
//
// PURE. The `graph.adjudicate` task model compares a newly stated
// Commitment/Decision/Claim/PersonFact with existing live items about the
// same subject and answers, per pair, `same | supersedes | new`:
//
//   same        the same fact restated — report a changed status or due date
//   supersedes  the new statement replaces or reverses the old one
//   new         unrelated
//
// Bounded and verification-shaped, like #364's entity adjudication: ≤ 20
// pairs per call, ≤ 2 quotes per new item, every quote ≤ 200 characters.
//
// ⚠ A `sensitive` PersonFact never reaches this prompt on either side (§5.6,
// §15): a proposed one skips adjudication entirely, and existing sensitive
// rows are never candidates (`ItemCandidateService`).
// =============================================================================

import { z } from 'zod';

import type { JsonSchema } from '../../ai/providers/ai-provider.interface';
import type { ItemAdjudication } from './dedup-core';

export const ITEM_ADJUDICATION_SCHEMA_NAME = 'kg_item_adjudication';
export const ITEM_ADJUDICATION_BATCH_SIZE = 20;
export const ITEM_ADJUDICATION_MAX_QUOTES = 2;
export const ITEM_ADJUDICATION_QUOTE_CHARS = 200;

export const ITEM_ADJUDICATION_HEADINGS = Object.freeze({
  pair: '## Pair',
  proposed: 'New:',
  existing: 'Existing:',
  quotes: 'Quotes:',
});

export interface ItemSide {
  title: string | null;
  statement: string;
  occurredAt: string | null;
  dueAt: string | null;
  ownerLabel: string | null;
}

export interface ItemAdjudicationPair {
  /** `p1`, `p2`, … — unique within one call. */
  pairId: string;
  /** `commitment` | `decision` | `claim` | `person_fact`. */
  kind: string;
  /** The subject's type (Person, Project, …), for the system prompt's wording. */
  subjectType: string | null;
  proposed: ItemSide & { quotes: readonly string[] };
  existing: ItemSide & { status: string };
}

const KIND_LABEL: Record<string, string> = {
  commitment: 'commitment',
  decision: 'decision',
  claim: 'claim',
  person_fact: 'fact about a person',
};

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function buildItemAdjudicationSystemPrompt(pairs: readonly ItemAdjudicationPair[]): string {
  const kinds = [...new Set(pairs.map((p) => KIND_LABEL[p.kind] ?? p.kind))].sort();
  const subjects = [...new Set(pairs.map((p) => p.subjectType).filter((s): s is string => !!s))].sort();
  return [
    `You compare a newly stated ${kinds.join(' / ')} with existing ones about the same ` +
      `${subjects.length > 0 ? subjects.join(' / ') : 'subject'}. For each pair answer exactly one verdict:`,
    '- `same` — the same fact restated. If the new statement says something about it changed, report ' +
      'the changed `status` (open, done or dropped) and/or the changed due date (`dueAt`, YYYY-MM-DD); ' +
      'otherwise leave both null.',
    '- `supersedes` — the new statement replaces, corrects or reverses the existing one (a date moved, a ' +
      'decision reversed, a claim corrected).',
    '- `new` — they are about different things.',
    'Decisions are never `same` when the choice differs. Only report changes the new text actually states. ' +
      'Give a short rationale (at most 500 characters). Answer every pair exactly once, by its pair id.',
  ].join('\n\n');
}

function sideLines(side: ItemSide & { status?: string }): string[] {
  const lines: string[] = [];
  if (side.title) lines.push(`  Title: ${clip(side.title, 200)}`);
  lines.push(`  Statement: ${clip(side.statement, 600)}`);
  const facts = [
    side.occurredAt ? `stated ${side.occurredAt}` : null,
    side.dueAt ? `due ${side.dueAt}` : null,
    side.status ? `status ${side.status}` : null,
    side.ownerLabel ? `owner ${side.ownerLabel}` : null,
  ].filter((f): f is string => f !== null);
  if (facts.length > 0) lines.push(`  ${facts.join('; ')}`);
  return lines;
}

export function buildItemAdjudicationUserContent(pairs: readonly ItemAdjudicationPair[]): string {
  const h = ITEM_ADJUDICATION_HEADINGS;
  const out: string[] = [];
  for (const pair of pairs) {
    out.push(`${h.pair} ${pair.pairId} (${KIND_LABEL[pair.kind] ?? pair.kind})`);
    out.push(h.proposed);
    out.push(...sideLines(pair.proposed));
    const quotes = pair.proposed.quotes.slice(0, ITEM_ADJUDICATION_MAX_QUOTES).map((q) => clip(q, ITEM_ADJUDICATION_QUOTE_CHARS));
    if (quotes.length > 0) {
      out.push(`  ${h.quotes}`);
      for (const q of quotes) out.push(`  - "${q}"`);
    }
    out.push(h.existing);
    out.push(...sideLines(pair.existing));
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** Strict JSON Schema for `generateStructured` — every field required, nullables typed. */
export function buildItemAdjudicationOutputSchema(): JsonSchema {
  return {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        description: 'One verdict per pair.',
        items: {
          type: 'object',
          properties: {
            pairId: { type: 'string', description: 'The pair id, e.g. `p1`.' },
            verdict: { type: 'string', enum: ['same', 'new', 'supersedes'] },
            changes: {
              type: 'object',
              properties: {
                status: { type: ['string', 'null'], enum: ['open', 'done', 'dropped', null] },
                dueAt: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null.' },
              },
              required: ['status', 'dueAt'],
              additionalProperties: false,
            },
            rationale: { type: 'string', description: 'Why, in at most 500 characters.' },
          },
          required: ['pairId', 'verdict', 'changes', 'rationale'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  };
}

const verdictSchema = z.object({
  pairId: z.string(),
  verdict: z.enum(['same', 'new', 'supersedes']),
  changes: z
    .object({
      status: z.enum(['open', 'done', 'dropped']).nullable().catch(null),
      dueAt: z.iso.date().nullable().catch(null),
    })
    .nullable()
    .catch(null),
  rationale: z.string(),
});

/**
 * Read the answer leniently: an invalid entry contributes nothing, an unknown
 * or repeated pair id is ignored, a malformed change is dropped (never the
 * verdict), the rationale is clipped to 500. A pair with no answer is simply
 * absent — the caller treats it as `new`.
 */
export function readItemVerdicts(value: unknown, pairIds: ReadonlySet<string>): Map<string, ItemAdjudication> {
  const out = new Map<string, ItemAdjudication>();
  const verdicts = (value as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(verdicts)) return out;
  for (const raw of verdicts) {
    const parsed = verdictSchema.safeParse(raw);
    if (!parsed.success || !pairIds.has(parsed.data.pairId) || out.has(parsed.data.pairId)) continue;
    out.set(parsed.data.pairId, {
      verdict: parsed.data.verdict,
      changes: { status: parsed.data.changes?.status ?? null, dueAt: parsed.data.changes?.dueAt ?? null },
      rationale: parsed.data.rationale.slice(0, 500),
    });
  }
  return out;
}

// =============================================================================
// The `graph.adjudicate` prompt and output schema (#364; ontology.md §7, §15, §20)
// =============================================================================
//
// PURE. One bounded, verification-shaped request per batch of ≤ 20 pairs:
// "is this mention the same real-world thing as this candidate?" — never a
// generation-shaped one. Each pair carries a small dossier on both sides.
//
//   system  the rule ("`uncertain` is a good answer", never a first name
//           alone) + the type's description and disambiguation rules from
//           the caller's effective schema
//   user    `## Pair p{n}` → `Mention:` label, aliases, props, ≤ 3 quotes;
//           `Candidate {id8}:` label, aliases, props, ≤ 15 neighbourhood
//           lines, ≤ 3 quotes. Every quote ≤ 200 characters.
//
// ⚠ Dossiers are built from the OWNER's rows only, and never carry a
// `sensitive` PersonFact statement (§5.6/§15) — the caller builds them from
// entity/relation rows and entity evidence, never from `kg_items`.
// =============================================================================

import { z } from 'zod';

import type { JsonSchema } from '../../ai/providers/ai-provider.interface';

export const ADJUDICATION_SCHEMA_NAME = 'kg_adjudication';
export const ADJUDICATION_BATCH_SIZE = 20;
export const ADJUDICATION_QUOTE_CHARS = 200;
export const ADJUDICATION_MAX_QUOTES = 3;
export const ADJUDICATION_MAX_NEIGHBOURHOOD_LINES = 15;

/** The headings the user content is built from — exported so tests pin them. */
export const ADJUDICATION_PROMPT_HEADINGS = Object.freeze({
  pair: '## Pair',
  mention: 'Mention:',
  candidate: 'Candidate',
  aliases: 'Also known as:',
  props: 'Attributes:',
  neighbourhood: 'Connections:',
  quotes: 'Quotes:',
  typeRules: '## How to tell them apart',
});

export interface DossierSide {
  label: string;
  aliases: readonly string[];
  props: Record<string, unknown>;
  quotes: readonly string[];
}

export interface CandidateDossier extends DossierSide {
  entityId: string;
  /** Lines like `WORKS_FOR → Northwind Robotics (2019–)`. */
  neighbourhood: readonly string[];
}

export interface AdjudicationPair {
  /** `p1`, `p2`, … — unique within one call. */
  pairId: string;
  type: string;
  mention: DossierSide;
  candidate: CandidateDossier;
}

export interface AdjudicationTypeInfo {
  key: string;
  label?: string;
  description: string;
  disambiguation: readonly string[];
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function propsLine(props: Record<string, unknown>): string | null {
  const entries = Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ');
}

function sideLines(side: DossierSide, includeQuotes = true): string[] {
  const h = ADJUDICATION_PROMPT_HEADINGS;
  const lines: string[] = [];
  const aliases = side.aliases.filter((a) => a.trim() && a.trim() !== side.label.trim());
  if (aliases.length > 0) lines.push(`  ${h.aliases} ${aliases.join(', ')}`);
  const props = propsLine(side.props);
  if (props) lines.push(`  ${h.props} ${props}`);
  if (includeQuotes) lines.push(...quoteLines(side.quotes));
  return lines;
}

function quoteLines(raw: readonly string[]): string[] {
  const quotes = raw.slice(0, ADJUDICATION_MAX_QUOTES).map((q) => clip(q, ADJUDICATION_QUOTE_CHARS));
  if (quotes.length === 0) return [];
  return [`  ${ADJUDICATION_PROMPT_HEADINGS.quotes}`, ...quotes.map((q) => `  - "${q}"`)];
}

/** The first eight characters of an entity id: enough to tell candidates apart in one call. */
export function shortId(entityId: string): string {
  return entityId.slice(0, 8);
}

export function buildAdjudicationSystemPrompt(types: readonly AdjudicationTypeInfo[]): string {
  const h = ADJUDICATION_PROMPT_HEADINGS;
  const parts = [
    'You decide whether two records describe the same real-world thing. For each pair, compare the ' +
      'mention (from a new meeting) with the candidate (already in the user\'s knowledge graph).',
    'Answer `same` only when the evidence supports it; `uncertain` is a good answer. Never guess from a ' +
      'shared first name alone. Answer `different` when the evidence shows two distinct things.',
    'Give a short rationale (at most 500 characters) naming the evidence you relied on. Answer every pair ' +
      'exactly once, by its pair id.',
  ];
  for (const t of types) {
    parts.push(`${h.typeRules} — ${t.label ?? t.key}`);
    parts.push(`You decide whether two records describe the same real-world ${t.key}. ${t.description}`);
    for (const rule of t.disambiguation) parts.push(`- ${rule}`);
  }
  return parts.join('\n\n');
}

export function buildAdjudicationUserContent(pairs: readonly AdjudicationPair[]): string {
  const h = ADJUDICATION_PROMPT_HEADINGS;
  const out: string[] = [];
  for (const pair of pairs) {
    out.push(`${h.pair} ${pair.pairId} (${pair.type})`);
    out.push(`${h.mention} ${pair.mention.label}`);
    out.push(...sideLines(pair.mention));
    out.push(`${h.candidate} ${shortId(pair.candidate.entityId)}: ${pair.candidate.label}`);
    out.push(...sideLines(pair.candidate, false));
    const hood = pair.candidate.neighbourhood.slice(0, ADJUDICATION_MAX_NEIGHBOURHOOD_LINES);
    if (hood.length > 0) {
      out.push(`  ${h.neighbourhood}`);
      for (const line of hood) out.push(`  - ${line}`);
    }
    out.push(...quoteLines(pair.candidate.quotes));
    out.push('');
  }
  return out.join('\n').trimEnd();
}

/** The strict JSON Schema handed to `generateStructured`. */
export function buildAdjudicationOutputSchema(): JsonSchema {
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
            verdict: { type: 'string', enum: ['same', 'different', 'uncertain'] },
            rationale: { type: 'string', description: 'Why, in at most 500 characters.' },
          },
          required: ['pairId', 'verdict', 'rationale'],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  };
}

/** The contract's Zod shape for one verdict (after the rationale is clipped to 500). */
export const adjudicationOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      pairId: z.string(),
      verdict: z.enum(['same', 'different', 'uncertain']),
      rationale: z.string().max(500),
    }),
  ),
});

export type AdjudicationVerdict = 'same' | 'different' | 'uncertain';

export interface ParsedVerdict {
  verdict: AdjudicationVerdict;
  rationale: string;
}

/**
 * Read the model's answer leniently: an unparseable envelope or an invalid
 * entry contributes nothing; a verdict for an unknown pair id is ignored; a
 * rationale longer than 500 characters is clipped rather than failing the
 * batch. The caller turns every pair without an answer into `uncertain`.
 */
export function readVerdicts(value: unknown, pairIds: ReadonlySet<string>): Map<string, ParsedVerdict> {
  const out = new Map<string, ParsedVerdict>();
  const verdicts = (value as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(verdicts)) return out;
  for (const raw of verdicts) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as Record<string, unknown>;
    const clipped = {
      ...candidate,
      rationale: typeof candidate.rationale === 'string' ? candidate.rationale.slice(0, 500) : '',
    };
    const parsed = adjudicationOutputSchema.shape.verdicts.element.safeParse(clipped);
    if (!parsed.success || !pairIds.has(parsed.data.pairId) || out.has(parsed.data.pairId)) continue;
    out.set(parsed.data.pairId, { verdict: parsed.data.verdict, rationale: parsed.data.rationale });
  }
  return out;
}

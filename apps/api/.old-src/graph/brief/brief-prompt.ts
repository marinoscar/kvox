// =============================================================================
// The `kg.entity_digest` prompt (#372; spec §9.2)
// =============================================================================
//
// PURE. The model sees the entity's label and type, its previous statements
// and the numbered facts — `F<n>` handles only, never a uuid (the evidence ids
// behind each handle stay server-side, see `brief-facts.ts`). The answer is a
// schema-constrained object (`generateStructured`, #358) whose every statement
// names the handles it relies on.
// =============================================================================

import type { JsonSchema } from '../../ai/providers/ai-provider.interface';
import type { DigestFact } from './brief-facts';

/** At most this many statements survive into a digest. */
export const DIGEST_MAX_STATEMENTS = 12;
export const DIGEST_SCHEMA_NAME = 'entity_digest';
export const DIGEST_MAX_OUTPUT_TOKENS = 1200;
export const DIGEST_TIMEOUT_MS = 60_000;

export const DIGEST_SYSTEM_PROMPT =
  'Update the running summary of this entity for the account holder. Use ONLY the numbered facts. ' +
  'Every statement MUST list the fact handles it relies on in `factRefs`. Keep ≤ 12 statements; ' +
  'remove statements superseded by newer facts; prefer the order: what changed, decisions, open ' +
  "commitments, risks/claims, people changes. Dates are meeting dates, not today's.";

/** The strict JSON schema the answer must match (root object, strict subset only). */
export const DIGEST_RESPONSE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    statements: {
      type: 'array',
      description: `At most ${DIGEST_MAX_STATEMENTS} statements.`,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One statement about the entity.' },
          factRefs: {
            type: 'array',
            description: 'The handles (F1, F2, …) of the facts this statement relies on.',
            items: { type: 'string' },
          },
        },
        required: ['text', 'factRefs'],
        additionalProperties: false,
      },
    },
  },
  required: ['statements'],
  additionalProperties: false,
};

export interface DigestPromptInput {
  entity: { label: string; type: string };
  facts: readonly DigestFact[];
  previousHandles: readonly string[];
}

export interface DigestPrompt {
  systemPrompt: string;
  userContent: string;
}

export function buildDigestPrompt(input: DigestPromptInput): DigestPrompt {
  const previous = new Set(input.previousHandles);
  const prior = input.facts.filter((f) => previous.has(f.handle));
  const fresh = input.facts.filter((f) => !previous.has(f.handle));

  const lines: string[] = [`Entity: ${oneLine(input.entity.label)} (${input.entity.type})`, ''];
  lines.push('Previous summary statements:');
  if (prior.length === 0) lines.push('(none — this is the first summary)');
  for (const f of prior) lines.push(`${f.handle}: ${f.text}`);
  lines.push('', 'Facts:');
  if (fresh.length === 0) lines.push('(no new facts)');
  for (const f of fresh) lines.push(`${f.handle}: [${f.date ?? 'undated'}, ${f.kind}] ${f.text}`);

  return { systemPrompt: DIGEST_SYSTEM_PROMPT, userContent: lines.join('\n') };
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

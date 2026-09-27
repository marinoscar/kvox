// =============================================================================
// Extraction row caps (#435, epic #346; docs/specs/ontology.md §6)
// =============================================================================
//
// PURE. How many rows one extraction answer may carry, sized from the output
// ceiling the call will actually be given, so a note that holds more than one
// answer can carry is told to keep the most significant rows rather than being
// cut off mid-object and failing terminally.
//
//   usable     = max(0, maxOutputTokens − REASONING_HEADROOM_TOKENS[effort]) × 0.8
//   total rows = floor(usable / EXTRACTION_TOKENS_PER_ROW), clamped to [15, 400]
//   split      = entities 35% / relations 35% / items 30%, each at least 5
//
// ⚠ THE CAPS REACH THE MODEL AS PROMPT COPY AND SCHEMA `description`s ONLY —
// NEVER AS `maxItems`. Strict decoding on some OpenAI-compatible gateways
// rejects the keyword outright, and a refused request is worse than a cap the
// model occasionally overshoots (which the truncation retry then catches).
// =============================================================================

import type { AiReasoningEffort } from '../../ai/ai-settings.schema';
import { REASONING_HEADROOM_TOKENS } from '../../notes/generation/token-budget';

/** A generous estimate of what one cited extraction row costs in output tokens. */
export const EXTRACTION_TOKENS_PER_ROW = 160;

/** The share of the thinking-free output ceiling planned for rows. */
const USABLE_SHARE = 0.8;
const MIN_TOTAL_ROWS = 15;
const MAX_TOTAL_ROWS = 400;
const MIN_PER_SECTION = 5;

/** The most rows one answer may carry, per section. */
export interface ExtractionRowCaps {
  entities: number;
  relations: number;
  items: number;
}

/** Row caps for an answer given `maxOutputTokens` at reasoning `effort`. */
export function extractionRowCaps(
  maxOutputTokens: number,
  effort: AiReasoningEffort | null | undefined,
): ExtractionRowCaps {
  const thinking = REASONING_HEADROOM_TOKENS[effort ?? 'none'];
  const usable = Math.max(0, maxOutputTokens - thinking) * USABLE_SHARE;
  const total = Math.min(
    MAX_TOTAL_ROWS,
    Math.max(MIN_TOTAL_ROWS, Math.floor(usable / EXTRACTION_TOKENS_PER_ROW)),
  );
  return {
    entities: Math.max(MIN_PER_SECTION, Math.floor(total * 0.35)),
    relations: Math.max(MIN_PER_SECTION, Math.floor(total * 0.35)),
    items: Math.max(MIN_PER_SECTION, Math.floor(total * 0.3)),
  };
}

/** Every cap halved (never below one) — the one re-ask after a truncation. */
export function halveRowCaps(caps: ExtractionRowCaps): ExtractionRowCaps {
  return {
    entities: Math.max(1, Math.floor(caps.entities / 2)),
    relations: Math.max(1, Math.floor(caps.relations / 2)),
    items: Math.max(1, Math.floor(caps.items / 2)),
  };
}

// =============================================================================
// Tool-result compaction (#377; docs/specs/ontology.md §21.3)
// =============================================================================
//
// A tool message is part of the next model request, so it is held to a token
// budget counted with the RESOLVED model's own `countTokens` (#360). Over
// budget, the longest array in the result is halved, repeatedly, until it fits
// — the head of every list is kept, since every tool orders by relevance or
// recency — and `"truncated": true` is set.
//
// Compaction mutates a parsed copy and re-serialises it, so its output is
// ALWAYS valid JSON; it never cuts a string mid-token.
// =============================================================================

export const ASK_TOOL_RESULT_MAX_TOKENS = 3000;

/** A conservative fallback when no model tokenizer is available (≈ 3 characters per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** The tool message body: an object result spread, an array one as `items`. */
export function toolMessageBody(data: unknown, truncated: boolean): Record<string, unknown> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), truncated };
  }
  return { items: data ?? [], truncated };
}

interface ArrayRef {
  array: unknown[];
  weight: number;
}

function collectArrays(value: unknown, out: ArrayRef[]): void {
  if (Array.isArray(value)) {
    if (value.length > 0) out.push({ array: value, weight: JSON.stringify(value).length });
    for (const v of value) collectArrays(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectArrays(v, out);
  }
}

/**
 * Serialise `body` within `maxTokens`. Returns the JSON and whether anything
 * was dropped. When even every array emptied does not fit (a pathological
 * scalar payload), the emptied body is returned — still valid JSON, flagged.
 */
export function compactToBudget(
  body: Record<string, unknown>,
  countTokens: (text: string) => number,
  maxTokens: number = ASK_TOOL_RESULT_MAX_TOKENS,
): { json: string; truncated: boolean } {
  let json = JSON.stringify(body);
  if (countTokens(json) <= maxTokens) return { json, truncated: body.truncated === true };

  const copy = JSON.parse(json) as Record<string, unknown>;
  copy.truncated = true;
  for (;;) {
    const arrays: ArrayRef[] = [];
    collectArrays(copy, arrays);
    if (arrays.length === 0) break;
    arrays.sort((a, b) => b.weight - a.weight || b.array.length - a.array.length);
    const longest = arrays[0].array;
    longest.length = Math.floor(longest.length / 2);
    json = JSON.stringify(copy);
    if (countTokens(json) <= maxTokens) return { json, truncated: true };
  }
  return { json: JSON.stringify(copy), truncated: true };
}

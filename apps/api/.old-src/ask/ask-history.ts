// =============================================================================
// Ask history and the input budget (issue #378; docs/specs/ontology.md §21.3)
// =============================================================================
//
// PURE. Which earlier messages a turn replays, how they are cleaned, and how
// they are trimmed to the model's input budget:
//
//   - only `complete` messages; a FAILED TURN is skipped whole — its assistant
//     row and the question it failed to answer — so the model never reads a
//     question as if it had been answered, or a fragment as if it were one;
//   - assistant text is replayed with its `[^…]` markers STRIPPED: a handle is
//     per turn (#377), so last turn's `ev3` means nothing now, and replaying it
//     would invite the model to cite it again (which `citations.ts` would then
//     mark invalid);
//   - at most `limit` messages, then the OLDEST are dropped until the prompt
//     fits. The system prompt and the current question are never dropped: if
//     they alone do not fit, the turn is refused (`budget`), never truncated —
//     CLAUDE.md Notes rule 4.
// =============================================================================

import type { AiChatMessage } from '../ai/providers/ai-provider.interface';
import { stripCitationMarkers } from './ask-message.mapper';

export interface AskHistoryRow {
  role: 'user' | 'assistant';
  status: 'pending' | 'streaming' | 'complete' | 'failed';
  content: string;
}

/** A per-message allowance for role/framing tokens on top of the content. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * The replayable history, oldest first, from the conversation's earlier rows
 * (oldest first, the current turn excluded), at most `limit` messages.
 */
export function selectHistory(rows: readonly AskHistoryRow[], limit: number): AiChatMessage[] {
  const kept: AiChatMessage[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.role === 'user') {
      const next = rows[i + 1];
      // The question of a failed (or never-finished) turn goes with it.
      if (next && next.role === 'assistant' && next.status !== 'complete') continue;
      if (row.status !== 'complete') continue;
      const content = row.content.trim();
      if (content) kept.push({ role: 'user', content });
      continue;
    }
    if (row.status !== 'complete') continue;
    const content = stripCitationMarkers(row.content).replace(/[ \t]+\n/g, '\n').trim();
    if (content) kept.push({ role: 'assistant', content });
  }
  return limit > 0 ? kept.slice(-limit) : [];
}

/** Tokens a message list costs, counted with the resolved model's tokenizer. */
export function messageTokens(messages: readonly AiChatMessage[], countTokens: (text: string) => number): number {
  let total = 0;
  for (const m of messages) {
    total += MESSAGE_OVERHEAD_TOKENS;
    if (m.role === 'assistant') {
      if (m.content) total += countTokens(m.content);
      for (const call of m.toolCalls ?? []) total += countTokens(`${call.name}${call.argumentsJson}`) + MESSAGE_OVERHEAD_TOKENS;
    } else {
      total += countTokens(m.content);
    }
  }
  return total;
}

export type FitResult =
  | { ok: true; messages: AiChatMessage[]; droppedHistory: number; inputTokens: number }
  | { ok: false; requiredTokens: number };

/**
 * `[system, ...history, current]`, dropping the oldest history until it fits
 * `availableTokens` (which already excludes `reservedTokens` — the tool
 * definitions). `ok: false` when the system prompt and the question alone do
 * not fit.
 */
export function fitToBudget(input: {
  system: string;
  history: readonly AiChatMessage[];
  question: string;
  availableTokens: number;
  reservedTokens: number;
  countTokens: (text: string) => number;
}): FitResult {
  const head: AiChatMessage = { role: 'system', content: input.system };
  const tail: AiChatMessage = { role: 'user', content: input.question };
  const base = messageTokens([head, tail], input.countTokens) + input.reservedTokens;
  if (base > input.availableTokens) return { ok: false, requiredTokens: base };

  const history = [...input.history];
  const costs = history.map((m) => messageTokens([m], input.countTokens));
  let total = base + costs.reduce((a, b) => a + b, 0);
  let dropped = 0;
  while (total > input.availableTokens && history.length > 0) {
    history.shift();
    total -= costs.shift()!;
    dropped += 1;
  }
  // A replay that now starts mid-exchange with an answer reads oddly; drop it too.
  while (history.length > 0 && history[0].role === 'assistant') {
    history.shift();
    total -= costs.shift()!;
    dropped += 1;
  }
  return { ok: true, messages: [head, ...history, tail], droppedHistory: dropped, inputTokens: total };
}

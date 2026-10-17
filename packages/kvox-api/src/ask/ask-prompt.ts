// =============================================================================
// The Ask agent's system prompt (issue #378, epic #348; docs/specs/ontology.md §21)
// =============================================================================
//
// PURE and snapshot-tested (`ask-prompt.spec.ts`): the prompt is part of the
// product's behaviour, so a change to it is a reviewed diff of the snapshot,
// never an accident.
//
// The rules here are GUIDANCE, not the security boundary. Read-only is
// structural (no tool can write, §21.1), owner scoping and the sensitivity
// filter live in every tool (#377), and citations are checked against the
// turn's own handle registry after the answer (`citations.ts`) — so a model
// that ignores rule 2 produces `valid: false` citations, never a fabricated one.
// =============================================================================

export interface AskPromptScope {
  /** Always `ent1` — pre-registered by the handler before the first call. */
  handle: string;
  label: string;
  type: string;
}

export interface AskPromptInput {
  now: Date;
  scope: AskPromptScope | null;
}

/** The line appended when the next call must answer without tools. */
export const ASK_FORCED_ANSWER_LINE =
  'Tool budget used. Answer now from what you already have, with citations, or say what you could not find.';

/** One line; newlines and brackets in a label must not reshape the prompt. */
function inline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export function buildAskSystemPrompt(input: AskPromptInput): string {
  const today = input.now.toISOString().slice(0, 10);
  const lines = [
    `You answer questions about the account holder's own knowledge graph, built from their reviewed meeting notes and transcripts. Today is ${today}.`,
    'Rules:',
    '1. Use ONLY information returned by the tools in this turn. If the tools find nothing relevant, say so plainly — never guess or use outside knowledge about these people or companies.',
    '2. Cite every factual sentence with the markers the tools give you: [^evN] for a source quote (preferred), [^docN] for a transcript or note passage, [^entN] for an entity itself. Never invent a marker. Never print ids.',
    '3. Start with `search` unless you already hold a reference. For "when"/"as of" questions pass asOf; dates in the graph are meeting dates.',
    "4. You are read-only. If asked to change something, explain that the user can edit it on the entity page or in a note's review panel.",
    '5. Be concise. Use short paragraphs or bullet lists. Do not repeat the question.',
  ];
  if (input.scope) {
    lines.push(
      `This conversation is about ${inline(input.scope.label)} (${inline(input.scope.type)}), reference ${input.scope.handle}. Assume questions are about it unless clearly not.`,
    );
  }
  return lines.join('\n');
}

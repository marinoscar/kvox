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

/** One handle the user selected in the explorer before asking (GIC-17, #678). */
export interface AskPromptSelectionItem {
  /** The handle the turn registered for it: `entN`, `itmN` or `relN`. */
  handle: string;
  label: string;
  type: string;
}

export interface AskPromptInput {
  now: Date;
  scope: AskPromptScope | null;
  /** What the user selected on the graph canvas, as starting handles. Absent or empty: no line is added. */
  selection?: readonly AskPromptSelectionItem[];
}

/** At most this many selected handles are named in the prompt. */
export const ASK_PROMPT_SELECTION_MAX = 20;

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
  const selection = (input.selection ?? []).slice(0, ASK_PROMPT_SELECTION_MAX);
  if (selection.length > 0) {
    const named = selection.map((item) => `${item.handle} (${inline(item.label)}, ${inline(item.type)})`).join('; ');
    lines.push(
      `The user selected these on the graph before asking: ${named}. They are starting points only, not evidence: look them up with your tools and read their source quotes with \`evidence\` before you state a fact about them.`,
    );
  }
  return lines.join('\n');
}

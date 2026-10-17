import { createFakeKvoxAi, type FakeKvoxAi } from '@marinoscar/kvox-api/testing';
import type {
  KvoxAiContext,
  KvoxAiTarget,
  KvoxChatEvent,
  KvoxChatMessage,
  KvoxStructuredResult,
  KvoxToolDef,
} from '@marinoscar/kvox-api/ports';
import type { z } from 'zod';

import { GRAPH_SCENARIO, type ScenarioRecording } from './graph-scenario.js';

// =============================================================================
// The language model of the bare host
// =============================================================================
//
// `createFakeKvoxAi` from `@marinoscar/kvox-api/testing` is the base: it records
// every call, streams `FAKE_NOTE_TEXT` for a note (`generateText`) and reports
// the capabilities the host scripts (`embeddings: null`, so search stays on full
// text and the graph resolves by name only). Two members are replaced, and they
// READ THE REQUEST rather than replaying a fixed list, so the answer follows the
// data the slices put in front of the model:
//
//   generateStructured   keyed on `schemaName`:
//     kg_extraction        the scenario recording whose title is the prompt's
//                          `Title:` line (`graph-scenario.ts`), cited by the
//                          prompt's own `s#` line ids; any other title extracts
//                          nothing. People the prompt lists under "Known
//                          entities" are answered with their `k#`.
//     kg_adjudication      `same` when the mention's label equals the
//                          candidate's (case and spacing aside), else `different`.
//     kg_item_adjudication no verdicts (every proposed work item is new).
//     entity_digest        one statement per new fact, citing that fact's `F#`.
//     anything else        the base fake (its `script.structured`).
//
//   chat                 the Ask tool loop, driven by the conversation: the last
//                        user message picks a plan, the tool results already in
//                        `req.messages` say how far it got, and every handle it
//                        passes on (`entN`) or cites (`[^evN]`, `[^entN]`) is one a
//                        previous tool result in THIS turn returned. Nothing is
//                        hard-coded but the shape of the two plans:
//
//     "action items from <name>"         search {query: name}
//                                        -> list_commitments {entity, owned_by, open}
//                                        -> answer citing each commitment's evidence
//     "meetings ... with <name>'s boss"  search {query: name}
//                                        -> neighbors {entity, relationTypes: [REPORTS_TO]}
//                                        -> timeline {entity: the boss, kinds: [meeting]}
//                                        -> answer citing each meeting's evidence
//
//     A question it has no plan for, or a forced answer (`toolChoice: 'none'`),
//     gets a plain "could not find" sentence from what it already holds.
//
// The fake is no stand-in for a model's judgement: it is the smallest thing that
// makes the slices' real loops, validators and citation checks do their work on
// a real database. Its answers are deterministic for a given database.
// =============================================================================

/** What {@link createBareHostAi} takes. */
export interface BareHostAiOptions {
  /** The text every note "is written" as. */
  noteText: string[];
  /** The recordings `kg_extraction` answers for; default the scenario. */
  recordings?: readonly ScenarioRecording[];
}

type StructuredRequest<T> = {
  target: KvoxAiTarget;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  schemaName: string;
};

type ChatRequest = { target: KvoxAiTarget; messages: KvoxChatMessage[]; tools: KvoxToolDef[]; toolChoice: 'auto' | 'none' };

const USAGE = { inputTokens: 1, outputTokens: 1 };

/** Lower case, single spaces: how two labels are compared. */
function norm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// kg_extraction
// -----------------------------------------------------------------------------

/** What the extraction prompt (`assembleExtractionPrompt`) hands the model, as far as the fake reads it. */
interface ExtractionPromptView {
  title: string;
  /** Known entity label (normalised) -> its `k#`. */
  known: Map<string, string>;
  /** `s#` -> the line's text. */
  lines: Array<{ alias: string; text: string }>;
}

function readExtractionPrompt(user: string): ExtractionPromptView {
  const rows = user.split('\n');
  const title = rows.find((row) => row.startsWith('Title: '))?.slice('Title: '.length).trim() ?? '';
  const known = new Map<string, string>();
  const knownAt = rows.indexOf('# Known entities');
  if (knownAt >= 0) {
    for (const row of rows.slice(knownAt + 1)) {
      if (row.trim() === '' || row.startsWith('#')) break;
      // `k1 | Person | Joe Park | aka: Joe | Org`
      const [alias, , label] = row.split(' | ');
      if (alias && label && /^k\d+$/.test(alias.trim())) known.set(norm(label), alias.trim());
    }
  }
  const lines: ExtractionPromptView['lines'] = [];
  for (const row of rows) {
    // `s3 [00:00:08] Speaker C: Yes, I will send ...`
    const match = /^(s\d+) \[[0-9:]+\] [^:]*: (.*)$/.exec(row);
    if (match) lines.push({ alias: match[1], text: match[2] });
  }
  return { title, known, lines };
}

/** The `s#` line that holds `quote`; a quote the transcript does not hold is a scenario bug. */
function citeLine(view: ExtractionPromptView, quote: string): { source: string; quote: string } {
  const line = view.lines.find((l) => l.text.includes(quote));
  if (!line) throw new Error(`fake-ai: the quote "${quote}" is in no line of "${view.title}"`);
  return { source: line.alias, quote };
}

/** The structured answer for one recording, in the raw shape `rawExtractionSchema` parses. */
export function extractionAnswer(user: string, recordings: readonly ScenarioRecording[]): Record<string, unknown> {
  const view = readExtractionPrompt(user);
  const recording = recordings.find((r) => r.title === view.title);
  if (!recording) return { meeting: { topics: [] }, entities: [], relations: [], items: [] };

  const refOf = new Map<string, string>();
  const entities: Array<Record<string, unknown>> = [];
  for (const person of recording.people) {
    const knownRef = view.known.get(norm(person.label));
    if (knownRef) {
      refOf.set(person.label, knownRef);
      continue;
    }
    const ref = `e${entities.length + 1}`;
    refOf.set(person.label, ref);
    entities.push({ ref, type: 'Person', label: person.label, aliases: [], props: {}, evidence: [citeLine(view, person.quote)] });
  }
  const ref = (label: string): string => {
    const found = refOf.get(label);
    if (!found) throw new Error(`fake-ai: "${label}" is not a person of "${recording.title}"`);
    return found;
  };

  const relation = (type: string, from: string, to: string, quote: string) => ({
    type,
    from,
    to,
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    evidence: [citeLine(view, quote)],
  });
  const relations = [
    ...recording.relations.map((r) => relation(r.type, ref(r.from), ref(r.to), r.quote)),
    ...recording.people.filter((p) => p.attended).map((p) => relation('ATTENDED', ref(p.label), 'meeting', p.quote)),
  ];

  const items = recording.commitments.map((c) => ({
    kind: 'commitment',
    title: c.title,
    statement: c.statement,
    subject: null,
    owner: ref(c.owner),
    counterparty: c.counterparty ? ref(c.counterparty) : null,
    status: c.status,
    occurredAt: null,
    dueAt: null,
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    sensitivity: null,
    props: {},
    evidence: [citeLine(view, c.quote)],
  }));

  return { meeting: { topics: [] }, entities, relations, items };
}

// -----------------------------------------------------------------------------
// kg_adjudication, kg_item_adjudication, entity_digest
// -----------------------------------------------------------------------------

/** `## Pair p1 (Person)` / `Mention: Joe Park` / `Candidate 0f000000: Joe Park`. */
export function adjudicationAnswer(user: string): Record<string, unknown> {
  const verdicts: Array<Record<string, unknown>> = [];
  let pairId: string | null = null;
  let mention: string | null = null;
  for (const row of user.split('\n')) {
    const pair = /^## Pair (\S+) /.exec(row);
    if (pair) {
      pairId = pair[1];
      mention = null;
      continue;
    }
    if (row.startsWith('Mention: ')) mention = row.slice('Mention: '.length);
    const candidate = /^Candidate [^:]+: (.*)$/.exec(row);
    if (candidate && pairId && mention !== null) {
      const same = norm(candidate[1]) === norm(mention);
      verdicts.push({ pairId, verdict: same ? 'same' : 'different', rationale: same ? 'The names are identical.' : 'The names differ.' });
      pairId = null;
    }
  }
  return { verdicts };
}

/** One statement per new fact (`F3: [2026-10-17, commitment] ...`), citing it. */
export function digestAnswer(user: string): Record<string, unknown> {
  const statements: Array<{ text: string; factRefs: string[] }> = [];
  const factsAt = user.indexOf('\nFacts:\n');
  const facts = factsAt >= 0 ? user.slice(factsAt + '\nFacts:\n'.length) : '';
  for (const row of facts.split('\n')) {
    const match = /^(F\d+): (?:\[[^\]]*\] )?(.*)$/.exec(row);
    if (match && statements.length < 12) statements.push({ text: match[2], factRefs: [match[1]] });
  }
  return { statements };
}

// -----------------------------------------------------------------------------
// chat: the Ask tool loop
// -----------------------------------------------------------------------------

/** One tool call of this turn and what it returned. */
interface ToolStep {
  name: string;
  args: Record<string, unknown>;
  result: any;
}

/** The question (the last user message) and the tool calls answered since. */
function readTurn(messages: KvoxChatMessage[]): { question: string; steps: ToolStep[] } {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      start = i;
      break;
    }
  }
  const question = messages[start]?.role === 'user' ? (messages[start].content as string) : '';
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  const steps: ToolStep[] = [];
  for (const message of messages.slice(start + 1)) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) calls.set(call.id, { name: call.name, args: (call.arguments ?? {}) as Record<string, unknown> });
    } else if (message.role === 'tool') {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      let result: unknown;
      try {
        result = JSON.parse(message.content);
      } catch {
        result = { error: message.content };
      }
      steps.push({ ...call, result });
    }
  }
  return { question, steps };
}

/** What the model does next: call one tool, or answer. */
type Move = { tool: string; args: Record<string, unknown> } | { answer: string };

const cite = (ref: string | null | undefined): string => (ref ? `[^${ref}]` : '');

/** The entity a `search` result holds for `name` (a Person whose label contains it). */
function personFrom(step: ToolStep | undefined, name: string): { ref: string; label: string } | null {
  const entities: Array<{ ref: string; type: string; label: string }> = step?.result?.entities ?? [];
  return entities.find((e) => e.type === 'Person' && norm(e.label).includes(norm(name))) ?? null;
}

function actionItemsPlan(name: string, steps: ToolStep[]): Move {
  const search = steps.find((s) => s.name === 'search');
  if (!search) return { tool: 'search', args: { query: name } };
  const person = personFrom(search, name);
  if (!person) return { answer: `I could not find anyone called ${name} in your graph.` };
  const listed = steps.find((s) => s.name === 'list_commitments');
  if (!listed) return { tool: 'list_commitments', args: { entity: person.ref, direction: 'owned_by', status: 'open' } };

  const items: Array<{ ref: string; statement: string; evidence: string[] }> = listed.result?.items ?? [];
  if (items.length === 0) return { answer: `${person.label}${cite(person.ref)} has no open action items.` };
  const lines = items.map((item) => `- ${item.statement} ${cite(item.evidence?.[0] ?? item.ref)}`);
  return { answer: [`Open action items from ${person.label}${cite(person.ref)}:`, ...lines].join('\n') };
}

function bossMeetingsPlan(name: string, steps: ToolStep[]): Move {
  const search = steps.find((s) => s.name === 'search');
  if (!search) return { tool: 'search', args: { query: name } };
  const person = personFrom(search, name);
  if (!person) return { answer: `I could not find anyone called ${name} in your graph.` };
  const hood = steps.find((s) => s.name === 'neighbors');
  if (!hood) return { tool: 'neighbors', args: { entity: person.ref, relationTypes: ['REPORTS_TO'] } };

  const edges: Array<{ ref: string | null; type: string; from: string; to: string }> = hood.result?.edges ?? [];
  const nodes: Array<{ ref: string; label: string }> = hood.result?.nodes ?? [];
  const edge = edges.find((e) => e.type === 'REPORTS_TO' && e.from === person.ref);
  const boss = edge ? nodes.find((n) => n.ref === edge.to) : undefined;
  if (!edge || !boss) return { answer: `I could not find who ${person.label}${cite(person.ref)} reports to.` };
  const timeline = steps.find((s) => s.name === 'timeline');
  if (!timeline) return { tool: 'timeline', args: { entity: boss.ref, kinds: ['meeting'] } };

  const events: Array<{ ref: string; text: string; at: string | null; evidence?: Array<{ ref: string }> }> =
    timeline.result?.items ?? [];
  const head = `${person.label}${cite(person.ref)} reports to ${boss.label}${cite(edge.ref ?? boss.ref)}.`;
  if (events.length === 0) return { answer: `${head} I found no meetings with ${boss.label}.` };
  const lines = events.map((e) => `- ${e.text}${e.at ? ` (${e.at.slice(0, 10)})` : ''} ${cite(e.evidence?.[0]?.ref ?? e.ref)}`);
  return { answer: [head, `Meetings with ${boss.label}:`, ...lines].join('\n') };
}

/** The next move for the conversation so far. */
export function nextAskMove(messages: KvoxChatMessage[], toolChoice: 'auto' | 'none'): Move {
  const { question, steps } = readTurn(messages);
  const actionItems = /action items (?:from|of|for) ([A-Za-z][\w-]*)/i.exec(question);
  const boss = /meetings\b.*\bwith ([A-Za-z][\w-]*)['’]s (?:boss|manager)/i.exec(question);
  const move = actionItems
    ? actionItemsPlan(actionItems[1], steps)
    : boss
      ? bossMeetingsPlan(boss[1], steps)
      : { answer: 'I could not find anything in your graph that answers that.' };
  if ('tool' in move && toolChoice === 'none') return { answer: 'I could not finish looking that up.' };
  return move;
}

// -----------------------------------------------------------------------------
// The port
// -----------------------------------------------------------------------------

/**
 * The host's `KVOX_AI`: the package fake with a structured-output router and a
 * conversation-driven chat (see the file header).
 *
 * @param options - the note text and the scenario recordings.
 * @returns the fake; `calls` records every call, including the replaced members'.
 */
export function createBareHostAi(options: BareHostAiOptions): FakeKvoxAi {
  const recordings = options.recordings ?? GRAPH_SCENARIO;
  const ai = createFakeKvoxAi({ script: { text: options.noteText, capabilities: { embeddings: null } } });
  const baseStructured = ai.generateStructured.bind(ai);
  let chatCalls = 0;

  ai.generateStructured = async function generateStructured<T>(
    ctx: KvoxAiContext,
    req: StructuredRequest<T>,
  ): Promise<KvoxStructuredResult<T>> {
    let value: unknown;
    switch (req.schemaName) {
      case 'kg_extraction':
        value = extractionAnswer(req.user, recordings);
        break;
      case 'kg_adjudication':
        value = adjudicationAnswer(req.user);
        break;
      case 'kg_item_adjudication':
        value = { verdicts: [] };
        break;
      case 'entity_digest':
        value = digestAnswer(req.user);
        break;
      default:
        return baseStructured(ctx, req);
    }
    ai.calls.push({ method: 'generateStructured', ctx, req });
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) throw new Error(`fake-ai: the "${req.schemaName}" answer does not match the call's schema`);
    return { value: parsed.data, usage: USAGE };
  } as FakeKvoxAi['generateStructured'];

  ai.chat = async function* chat(ctx: KvoxAiContext, req: ChatRequest): AsyncIterable<KvoxChatEvent> {
    ai.calls.push({ method: 'chat', ctx, req });
    chatCalls += 1;
    const move = nextAskMove(req.messages, req.toolChoice);
    if ('tool' in move) {
      yield { type: 'tool_call', id: `call_${chatCalls}`, name: move.tool, arguments: move.args };
    } else {
      yield { type: 'delta', text: move.answer };
    }
    yield { type: 'step_end' };
    yield { type: 'done', usage: USAGE, finishReason: 'stop' };
  };

  return ai;
}

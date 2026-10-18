import type { z } from 'zod';

import type {
  KvoxAiContext,
  KvoxAiTarget,
  KvoxChatEvent,
  KvoxChatMessage,
  KvoxStructuredResult,
  KvoxToolDef,
} from '../ports/index.js';
import { createFakeKvoxAi, type FakeKvoxAi } from './fake-ai.js';

// =============================================================================
// A scenario-driven model for a host's end-to-end tests (moved from the bare
// host, examples/bare-host/src/fake-ai.ts, for #586 / KVox Desktop)
// =============================================================================
//
// `createFakeKvoxAi` replays a fixed script. A host's end-to-end test needs a
// model that READS THE REQUEST, so the answer follows the data the slices put
// in front of it, on a real database. This module is that model, written once
// here so no host copies prompt-reading code (ADR-0001). A host supplies only
// its scenario data (`KvoxScenarioMeeting[]`) and wiring.
//
//   structured output, keyed on `schemaName` (`scenarioStructuredAnswer`):
//     kg_extraction        the meeting whose title is the prompt's `Title:`
//                          line, cited by the prompt's own `s#` line ids (any
//                          speaker label: "Speaker C" or a real name); any
//                          other title extracts nothing. A person the prompt
//                          lists under "Known entities" is answered with its
//                          `k#`. ATTENDED is proposed only for `attended: true`
//                          — with a person `attended: false`, a test sees the
//                          slice's own deterministic ATTENDED row for an
//                          identified speaker, never a duplicate.
//     kg_adjudication      `same` when the mention's label equals the
//                          candidate's (case and spacing aside), else `different`.
//     kg_item_adjudication no verdicts (every proposed work item is new).
//     entity_digest        one statement per new fact, citing that fact's `F#`.
//
//   chat, the Ask tool loop (`nextAskMove`), driven by the conversation: the
//   last user message picks a plan, the tool results already in the messages
//   say how far it got, and every handle it passes on or cites is one a tool
//   returned in THIS turn:
//
//     "action items from <name>"         search {query: name}
//                                        -> list_commitments {entity, owned_by, open}
//                                        -> answer citing each commitment's evidence
//     "meetings ... with <name>'s boss"  search {query: name}
//                                        -> neighbors {entity, relationTypes: [REPORTS_TO]}
//                                        -> timeline {entity: the boss, kinds: [meeting]}
//                                        -> answer citing the REPORTS_TO relation
//                                           ([^relN] — a meeting's quote, or the
//                                           owner's "Set by hand" citation of a
//                                           manual edit, #586) and each meeting
//
//   A question it has no plan for, or a forced answer (`toolChoice: 'none'`),
//   gets a plain "could not find" sentence.
//
// The fake is no stand-in for a model's judgement: it is the smallest thing
// that makes the slices' real loops, validators and citation checks run.
// Deterministic for a given database.
// =============================================================================

/**
 * A person a scenario meeting mentions, and the words that prove it.
 *
 * @stability experimental
 */
export interface KvoxScenarioPerson {
  /** The full name, as the graph labels the entity. */
  label: string;
  /** An exact quote from one of the meeting's transcript lines. */
  quote: string;
  /** Whether the model proposes an ATTENDED row for them. */
  attended: boolean;
}

/**
 * A relation between two of a scenario meeting's people.
 *
 * @stability experimental
 */
export interface KvoxScenarioRelation {
  /** The relation type key, e.g. `REPORTS_TO`. */
  type: string;
  /** The source person's label. */
  from: string;
  /** The target person's label. */
  to: string;
  /** An exact quote from one of the meeting's transcript lines. */
  quote: string;
}

/**
 * A commitment a scenario person owns.
 *
 * @stability experimental
 */
export interface KvoxScenarioCommitment {
  /** The owner's label. */
  owner: string;
  /** The counterparty's label, or `null`. */
  counterparty: string | null;
  /** The short title. */
  title: string;
  /** The full statement. */
  statement: string;
  /** `open` or `done`. */
  status: 'open' | 'done';
  /** An exact quote from one of the meeting's transcript lines. */
  quote: string;
}

/**
 * What the scenario model extracts from one meeting. A host's recording type
 * may extend it with what its speech provider hears.
 *
 * @stability experimental
 */
export interface KvoxScenarioMeeting {
  /** The transcript title, which `kg.extract` uses as the meeting title (the model keys on it). */
  title: string;
  /** The people the model proposes. */
  people: KvoxScenarioPerson[];
  /** The relations the model proposes. */
  relations: KvoxScenarioRelation[];
  /** The commitments the model proposes. */
  commitments: KvoxScenarioCommitment[];
}

/**
 * An Ask move that calls one tool.
 *
 * @stability experimental
 */
export interface KvoxScenarioToolMove {
  /** The tool name (`search`, `neighbors`, `timeline`, `list_commitments`). */
  tool: string;
  /** Its arguments. */
  args: Record<string, unknown>;
}

/**
 * An Ask move that answers.
 *
 * @stability experimental
 */
export interface KvoxScenarioAnswerMove {
  /** The answer text, with citation markers. */
  answer: string;
}

/**
 * The scenario model's next Ask move: call one tool, or answer.
 *
 * @stability experimental
 */
export type KvoxScenarioAskMove = KvoxScenarioToolMove | KvoxScenarioAnswerMove;

/**
 * What {@link createScenarioKvoxAi} takes.
 *
 * @stability experimental
 */
export interface ScenarioKvoxAiOptions {
  /** The text every note "is written" as (`generateText`). */
  noteText: string | string[];
  /** The meetings `kg_extraction` answers for. */
  meetings: readonly KvoxScenarioMeeting[];
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

interface ExtractionPromptView {
  title: string;
  /** Known entity label (normalised) to its `k#`. */
  known: Map<string, string>;
  /** `s#` to the line text. */
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
    // `s3 [00:00:08] Speaker C: Yes, I will ...` or `s3 [00:00:08] Joe Park: Yes, ...`
    const match = /^(s\d+) \[[0-9:]+\] ([^:]*): (.*)$/.exec(row);
    if (match) lines.push({ alias: match[1], text: match[3] });
  }
  return { title, known, lines };
}

/** The `s#` line that holds `quote`; a quote the transcript does not hold is a scenario bug. */
function citeLine(view: ExtractionPromptView, quote: string): { source: string; quote: string } {
  const line = view.lines.find((l) => l.text.includes(quote));
  if (!line) throw new Error(`scenario-ai: the quote "${quote}" is in no line of "${view.title}"`);
  return { source: line.alias, quote };
}

function extractionAnswer(user: string, meetings: readonly KvoxScenarioMeeting[]): Record<string, unknown> {
  const view = readExtractionPrompt(user);
  const meeting = meetings.find((m) => m.title === view.title);
  if (!meeting) return { meeting: { topics: [] }, entities: [], relations: [], items: [] };

  const refOf = new Map<string, string>();
  const entities: Array<Record<string, unknown>> = [];
  for (const person of meeting.people) {
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
    if (!found) throw new Error(`scenario-ai: "${label}" is not a person of "${meeting.title}"`);
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
    ...meeting.relations.map((r) => relation(r.type, ref(r.from), ref(r.to), r.quote)),
    ...meeting.people.filter((p) => p.attended).map((p) => relation('ATTENDED', ref(p.label), 'meeting', p.quote)),
  ];

  const items = meeting.commitments.map((c) => ({
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
// kg_adjudication, entity_digest
// -----------------------------------------------------------------------------

/** `## Pair p1 (Person)` / `Mention: Joe Park` / `Candidate 0f000000: Joe Park`. */
function adjudicationAnswer(user: string): Record<string, unknown> {
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
function digestAnswer(user: string): Record<string, unknown> {
  const statements: Array<{ text: string; factRefs: string[] }> = [];
  const factsAt = user.indexOf('\nFacts:\n');
  const facts = factsAt >= 0 ? user.slice(factsAt + '\nFacts:\n'.length) : '';
  for (const row of facts.split('\n')) {
    const match = /^(F\d+): (?:\[[^\]]*\] )?(.*)$/.exec(row);
    if (match && statements.length < 12) statements.push({ text: match[2], factRefs: [match[1]] });
  }
  return { statements };
}

/**
 * The scenario model's structured answer for one call, in the raw shape the
 * slice's schema parses: `kg_extraction`, `kg_adjudication`,
 * `kg_item_adjudication` and `entity_digest`. Pure; a host's HTTP-level mock
 * can call it with the request's schema name and user content.
 *
 * @param schemaName - The call's `schemaName`.
 * @param user - The call's user content (the prompt the slice assembled).
 * @param meetings - The scenario meetings `kg_extraction` answers for.
 * @returns The answer, or `undefined` for a schema the scenario does not answer.
 *
 * @stability experimental
 */
export function scenarioStructuredAnswer(
  schemaName: string,
  user: string,
  meetings: readonly KvoxScenarioMeeting[],
): unknown | undefined {
  switch (schemaName) {
    case 'kg_extraction':
      return extractionAnswer(user, meetings);
    case 'kg_adjudication':
      return adjudicationAnswer(user);
    case 'kg_item_adjudication':
      return { verdicts: [] };
    case 'entity_digest':
      return digestAnswer(user);
    default:
      return undefined;
  }
}

// -----------------------------------------------------------------------------
// chat: the Ask tool loop
// -----------------------------------------------------------------------------

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

const cite = (ref: string | null | undefined): string => (ref ? `[^${ref}]` : '');

/** The entity a `search` result holds for `name` (a Person whose label contains it). */
function personFrom(step: ToolStep | undefined, name: string): { ref: string; label: string } | null {
  const entities: Array<{ ref: string; type: string; label: string }> = step?.result?.entities ?? [];
  return entities.find((e) => e.type === 'Person' && norm(e.label).includes(norm(name))) ?? null;
}

function actionItemsPlan(name: string, steps: ToolStep[]): KvoxScenarioAskMove {
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

function bossMeetingsPlan(name: string, steps: ToolStep[]): KvoxScenarioAskMove {
  const search = steps.find((s) => s.name === 'search');
  if (!search) return { tool: 'search', args: { query: name } };
  const person = personFrom(search, name);
  if (!person) return { answer: `I could not find anyone called ${name} in your graph.` };
  const hood = steps.find((s) => s.name === 'neighbors');
  if (!hood) return { tool: 'neighbors', args: { entity: person.ref, relationTypes: ['REPORTS_TO'] } };

  const edges: Array<{ ref: string | null; type: string; from: string; to: string }> = hood.result?.edges ?? [];
  const nodes: Array<{ ref: string; label: string }> = hood.result?.nodes ?? [];
  // The CURRENT manager: `neighbors` evaluates as of today, so a REPORTS_TO a
  // later one closed is not among its edges. A relation set by hand (#586) is
  // an ordinary stored edge with a `rel` handle, cited like any other.
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

/**
 * The scenario model's next Ask move for the conversation so far: one of the
 * two reference-question plans ("What are the action items from Joe?", "What
 * meetings have we had with Jenny's boss?"), or a "could not find" answer.
 * Pure; a host's HTTP-level mock can call it with the request's messages.
 *
 * @param messages - The chat request's messages.
 * @param toolChoice - The chat request's tool choice; `none` forces an answer.
 * @returns The tool to call with its arguments, or the answer text.
 *
 * @stability experimental
 */
export function nextAskMove(messages: KvoxChatMessage[], toolChoice: 'auto' | 'none'): KvoxScenarioAskMove {
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
 * A `KVOX_AI` for a host's end-to-end test: {@link createFakeKvoxAi} with a
 * structured-output router ({@link scenarioStructuredAnswer}) and a
 * conversation-driven chat ({@link nextAskMove}). It reports no embeddings
 * model, so search stays on full text and the graph resolves by name only.
 * Every other structured call falls through to the base fake.
 *
 * @param options - The note text and the scenario meetings.
 * @returns The fake; `calls` records every call, including the routed ones.
 *
 * @stability experimental
 */
export function createScenarioKvoxAi(options: ScenarioKvoxAiOptions): FakeKvoxAi {
  const ai = createFakeKvoxAi({ script: { text: options.noteText, capabilities: { embeddings: null } } });
  const baseStructured = ai.generateStructured.bind(ai);
  let chatCalls = 0;

  ai.generateStructured = async function generateStructured<T>(
    ctx: KvoxAiContext,
    req: StructuredRequest<T>,
  ): Promise<KvoxStructuredResult<T>> {
    const value = scenarioStructuredAnswer(req.schemaName, req.user, options.meetings);
    if (value === undefined) return baseStructured(ctx, req);
    ai.calls.push({ method: 'generateStructured', ctx, req });
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) throw new Error(`scenario-ai: the "${req.schemaName}" answer does not match the call's schema`);
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

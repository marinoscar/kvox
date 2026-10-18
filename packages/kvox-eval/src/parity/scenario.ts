import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';
import { Prisma, outputTokensForPrompt } from '@marinoscar/kvox-api/core';
import { GraphAiRunResolver } from '@marinoscar/kvox-api/graph';
import { AdjudicationService } from '@marinoscar/kvox-api/graph-extraction';
import { ASK_RESPOND_JOB_TYPE, resolveAskOptions, type AskRespondPayload } from '@marinoscar/kvox-api/ask';
import { createInMemoryAskDb } from '@marinoscar/kvox-api/ask/testing';
import { NOTE_BUILTIN_TEMPLATES } from '@marinoscar/kvox-api/notes/templates';
import { NOTE_GENERATE_AI_FEATURE, assemblePrompt, budgetFromTarget } from '@marinoscar/kvox-api/notes';
import type { KvoxAiPort, KvoxJob, KvoxJobsPort, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';

import { loadGoldenAskQuestions, fixtureDomains, loadGoldenMeetings, type GoldenFixture } from '../fixtures/index.js';
import { runExtraction } from '../kg/index.js';
import { PARITY_DEFAULT_EFFORT, PARITY_USER_ID } from './constants.js';
import { AskRespondHandler, AskToolset, EntityBriefTool, EvidenceTool, GetEntityTool, HandleRegistryClass, ListCommitmentsTool, NeighborsTool, SearchTool, TimelineTool } from './internals.js';
import type { ParityScript } from './script.js';

// =============================================================================
// The parity scenario: the real harness, driven through the model port (issue #580, part 2)
// =============================================================================
//
// `runParityScenario(ai)` makes, through whatever `KvoxAiPort` it is handed, the
// calls the product makes for ten golden meetings and three Ask questions:
//
//   notes.generate    the notes slice's own prompt builder (`assemblePrompt`) over a
//                     built-in template and the meeting's transcript, sized with the
//                     slice's own budget (`budgetFromTarget`), then `generateText`.
//   graph.extract     the evaluation's own extraction call (`runExtraction`: the
//                     graph-extraction slice's prompt, output schema and validator).
//   graph.adjudicate  the graph-extraction slice's own `AdjudicationService`, over
//                     pairs built from the extracted entities and the known ones.
//   ask.respond       the Ask slice's own `AskRespondHandler`, with its real toolset
//                     definitions, over the in-memory Ask tables and a stub tool run.
//
// Nothing here copies a prompt, a schema or a parser (ADR-0001): every one of them is
// the package's. What differs between hosts is only the port, and that is the point.
// =============================================================================

/**
 * The golden meetings the scenario covers by default.
 *
 * @stability experimental
 */
export const PARITY_FIXTURES: readonly string[] = Object.freeze(['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10']);

/**
 * The Ask questions (ids in `ask-questions.json`) the scenario asks by default.
 *
 * @stability experimental
 */
export const PARITY_QUESTIONS: readonly string[] = Object.freeze(['q01', 'q02', 'q03']);

/**
 * What {@link runParityScenario} covers.
 *
 * @stability experimental
 */
export interface ParityScenarioOptions {
  /** Golden meeting ids to run notes, extraction and adjudication for. Default {@link PARITY_FIXTURES}; `[]` runs none. */
  fixtures?: string[];
  /** Ask question ids to ask. Default {@link PARITY_QUESTIONS}; `[]` asks none. */
  questions?: string[];
  /** The scripted provider to tell which meeting is current (it answers extraction from that meeting's labels). */
  script?: Pick<ParityScript, 'focus'>;
}

/** The text of a transcript as a note source: one line per merged speaker turn, with its start time. */
function transcriptText(fixture: GoldenFixture): string {
  const speakerName = new Map(fixture.speakers.map((s) => [s.id, s.displayName ?? s.label]));
  const lines: string[] = [];
  let last: string | null = null;
  for (const segment of fixture.segments) {
    const seconds = Math.floor(segment.startMs / 1000);
    const stamp = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (segment.speakerId === last && lines.length > 0) {
      lines[lines.length - 1] += ` ${segment.text}`;
    } else {
      lines.push(`[${stamp}] ${speakerName.get(segment.speakerId) ?? 'Unknown speaker'}: ${segment.text}`);
      last = segment.speakerId;
    }
  }
  return lines.join('\n');
}

/** `notes.generate`: assemble, size, stream. */
async function runNotes(ai: KvoxAiPort, fixture: GoldenFixture): Promise<void> {
  const ctx = { userId: PARITY_USER_ID, orgId: null, feature: NOTE_GENERATE_AI_FEATURE };
  const target = await ai.resolveTask(ctx, NOTE_GENERATE_AI_FEATURE);
  const template = NOTE_BUILTIN_TEMPLATES[0];
  const prompt = assemblePrompt({
    templateInstructions: template.instructions,
    templateOutputFormat: template.outputFormat,
    templateBodyFormat: template.bodyFormat,
    templateStructure: [...template.structure],
    templateTone: template.tone,
    templateLength: template.length,
    contextText: fixture.contextText,
    sourceText: transcriptText(fixture),
  });
  const budget = budgetFromTarget(target, { maxInputTokens: null, maxOutputTokens: null });
  if (budget === null) throw new Error('The parity model reports no context window.');
  const promptTokens = ai.countTokens(target, `${prompt.systemPrompt}\n${prompt.userContent}`);
  let text = '';
  for await (const event of ai.generateText(ctx, {
    target,
    system: prompt.systemPrompt,
    user: prompt.userContent,
    maxOutputTokens: outputTokensForPrompt(budget, promptTokens),
  })) {
    if (event.type === 'delta') text += event.text;
  }
  if (text.length === 0) throw new Error(`The scripted note for ${fixture.id} came back empty.`);
}

/** `graph.extract`: the evaluation's extraction call, on the model the task resolves to. */
async function runExtract(ai: KvoxAiPort, fixture: GoldenFixture) {
  const target = await ai.resolveTask({ userId: PARITY_USER_ID, orgId: null, feature: 'graph.extract' }, 'graph.extract');
  const extracted = await runExtraction(ai, fixture, { model: target.model, provider: target.provider });
  if (extracted === null) throw new Error(`The scripted extraction for ${fixture.id} failed validation.`);
  return extracted;
}

/** `graph.adjudicate`: the real service, over pairs of one extracted mention and one known entity of its type. */
async function runAdjudicate(ai: KvoxAiPort, fixture: GoldenFixture, rows: Awaited<ReturnType<typeof runExtract>>['rows']): Promise<void> {
  const known = fixture.knownEntities;
  const pairs: Array<Parameters<AdjudicationService['adjudicate']>[1][number]> = [];
  for (const row of rows) {
    if (row.kind !== 'entity' || row.payload.ref === 'meeting') continue;
    const candidate = known.find((k) => k.type === row.payload.type && k.label !== row.payload.label);
    if (candidate === undefined) continue;
    pairs.push({
      pairId: `p${pairs.length + 1}`,
      type: row.payload.type,
      mention: {
        label: row.payload.label,
        aliases: row.payload.aliases,
        props: {},
        quotes: row.evidence.map((e) => e.quote),
      },
      candidate: {
        entityId: candidate.id,
        label: candidate.label,
        aliases: candidate.aliases,
        props: candidate.props as Record<string, unknown>,
        quotes: [],
        neighbourhood: fixture.knownRelations
          .filter((r) => r.from === candidate.id || r.to === candidate.id)
          .map((r) => `${r.type} ${r.from === candidate.id ? '→' : '←'} ${known.find((k) => k.id === (r.from === candidate.id ? r.to : r.from))?.label ?? 'unknown'}`),
      },
    });
    if (pairs.length === 4) break;
  }
  if (pairs.length === 0) throw new Error(`${fixture.id} has no extracted entity with a same-type known entity to adjudicate.`);

  const settings = {
    readSystem: async () => ({ value: { graphEnabled: true, maxInputTokens: null, maxOutputTokens: null, reasoningEffort: PARITY_DEFAULT_EFFORT }, version: 1 }),
  } as unknown as KvoxSettingsPort;
  const ontology = { effectiveSchemaFor: async () => computeEffectiveSchema({ enabledDomains: fixtureDomains(fixture), userAttributes: [] }) };
  const service = new AdjudicationService(undefined as never, new GraphAiRunResolver(ai, settings), ai, ontology as never);
  const verdicts = await service.adjudicate(PARITY_USER_ID, pairs, { jobType: 'kg.resolve', jobId: 'parity-job' });
  if (verdicts.size !== pairs.length) throw new Error(`Expected ${pairs.length} adjudication verdicts, got ${verdicts.size}.`);
}

/** A dependency the tool never reaches: only a tool's definition is read, never its `run`. */
const NONE = undefined as never;

/** The real tool definitions, with a tool run that finds one entity. */
function parityToolset(): InstanceType<typeof AskToolset> {
  const real = new AskToolset(
    new SearchTool(NONE, NONE, NONE, NONE),
    new GetEntityTool(NONE, NONE, NONE),
    new NeighborsTool(NONE, NONE),
    new TimelineTool(NONE, NONE),
    new EvidenceTool(NONE, NONE),
    new EntityBriefTool(NONE, NONE),
    new ListCommitmentsTool(NONE),
    NONE,
  );
  return {
    definitions: () => real.definitions(),
    createContext: async (user: { id: string }, opts: { now?: Date; scopeEntityId?: string | null } = {}) => ({
      user,
      handles: new HandleRegistryClass(),
      personalFactsAllowed: false,
      scopeEntityId: opts.scopeEntityId ?? null,
      now: opts.now ?? new Date(0),
    }),
    execute: async (ctx: { handles: InstanceType<typeof HandleRegistryClass> }) => {
      ctx.handles.register({ kind: 'ent', id: '55555555-5555-4555-8555-555555555555', label: 'Parity Entity' });
      return {
        ok: true as const,
        result: { data: { entities: [] }, resultCount: 1, summary: 'Found 1 thing', truncated: false },
        json: '{"entities":[{"ref":"ent1","label":"Parity Entity"}],"truncated":false}',
      };
    },
  } as unknown as InstanceType<typeof AskToolset>;
}

/** `ask.respond`: the real handler over the in-memory tables, for one question. */
async function runAsk(ai: KvoxAiPort, question: string): Promise<void> {
  const mem = createInMemoryAskDb();
  const conversation = mem.addConversation({ ownerId: PARITY_USER_ID });
  mem.addMessage({ conversationId: conversation.id, role: 'user', content: question });
  const assistant = mem.addMessage({ conversationId: conversation.id, role: 'assistant' });

  const settings = {
    readSystem: async () => ({ value: { graphEnabled: true, maxInputTokens: null, maxOutputTokens: null, reasoningEffort: PARITY_DEFAULT_EFFORT }, version: 1 }),
  } as unknown as KvoxSettingsPort;
  const visibility = {
    viewerFor: async (userId: string) => ({ userId }),
    transcriptVisibleSql: () => Prisma.sql`true`,
    run: (_viewer: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(mem.db),
  };
  const handler = new AskRespondHandler(
    { registerHandler: () => undefined } as unknown as KvoxJobsPort,
    mem.db,
    ai,
    { hasPermission: async () => true, authenticate: async () => null },
    new GraphAiRunResolver(ai, settings),
    parityToolset(),
    visibility as never,
    resolveAskOptions(),
  );
  // The system prompt carries today's date: a fixed clock keeps the request reproducible.
  handler.clock = () => Date.UTC(2026, 8, 26, 12, 0, 0);

  const payload: AskRespondPayload = {
    assistantMessageId: assistant.id,
    conversationId: conversation.id,
    userId: PARITY_USER_ID,
    model: 'gpt-parity-agent',
    providerId: 'openai',
    reasoningEffort: 'low',
  };
  const job: KvoxJob = { id: 'parity-job', type: ASK_RESPOND_JOB_TYPE, subjectType: 'ask_message', subjectId: assistant.id, payload, attempts: 0, orgId: null };
  await handler.process(job);

  const row = mem.messages.get(assistant.id);
  if (row?.status !== 'complete') throw new Error(`The Ask turn ended ${row?.status ?? 'missing'}: ${row?.errorClass ?? ''}`);
  if (!Array.isArray(row.toolCalls) || row.toolCalls.length === 0) throw new Error('The Ask turn called no tool.');
}

/**
 * Drives the product's own harness through `ai`: the calls notes generation, entity
 * extraction, adjudication and the Ask loop make, for the golden meetings and Ask
 * questions chosen. Call it once per binding with the SAME scripted provider under
 * the binding, record what reaches the provider, and compare.
 *
 * @example
 * ```ts
 * const script = createParityScript();
 * await runParityScenario(ai, { fixtures: ['m01'], questions: [], script });
 * ```
 *
 * @param ai - the port under test (`createKvoxAi`, or a host's wrapper of it).
 * @param opts - which meetings and questions.
 * @throws when a stage cannot complete (a scripted answer failed validation): the scenario must run end to end, or a request could be missing from the comparison.
 * @stability experimental
 */
export async function runParityScenario(ai: KvoxAiPort, opts: ParityScenarioOptions = {}): Promise<void> {
  const ids = opts.fixtures ?? [...PARITY_FIXTURES];
  const meetings = ids.length > 0 ? loadGoldenMeetings(ids) : [];
  for (const fixture of meetings) {
    opts.script?.focus(fixture.id);
    await runNotes(ai, fixture);
    const extracted = await runExtract(ai, fixture);
    await runAdjudicate(ai, fixture, extracted.rows);
  }
  opts.script?.focus(null);

  const wanted = opts.questions ?? [...PARITY_QUESTIONS];
  if (wanted.length > 0) {
    const questions = loadGoldenAskQuestions();
    for (const id of wanted) {
      const question = questions.find((q) => q.id === id);
      if (question === undefined) throw new Error(`Unknown Ask question id ${id}.`);
      await runAsk(ai, question.question);
    }
  }
}

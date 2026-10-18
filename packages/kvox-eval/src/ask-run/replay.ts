// =============================================================================
// The Ask evaluation's replay: the harness's self-test, no model, no key (#608)
// =============================================================================
//
// Seeds the ENTIRE golden graph (exactly as a live run does), then drives the
// REAL `AskRespondHandler` (real toolset, real database, real handle registry
// and citation mapper, and the real `createKvoxAi` event mapping) through six
// representative questions with a SCRIPTED runtime (`createScriptedRuntime` of
// `@marinoscar/kvox-ai/testing`): a fixed sequence of tool calls per question,
// using handles the real tools actually returned, then a canned answer that
// cites them, plus one answer that cites an unissued `[^ev99]`.
//
// It is the same role `kvox-eval kg --predictions gold` plays for extraction:
// it proves the seeder, the tools, the handler and the scorer agree end to end
// WITHOUT a real model or a paid key. The scripts are the ones of the web app's
// `apps/api/test/ask/ask-eval.replay.db.spec.ts` (same tool calls, same
// arguments, same answers), exported as DATA so a test and `kvox-eval ask
// --replay` share them.
//
// What it checks: citation validity < 1 for the planted answer (with `ev99`
// invalid) and 1.0 for the other five, every turn `complete`, and the leak
// gate: the graph's `sensitive` PersonFact (Marcus Webb's shellfish allergy)
// never reaches a captured request or an answer.
// =============================================================================

import type { AskMessageResponse } from '@marinoscar/kvox-contract/ask';
import { createKvoxAi } from '@marinoscar/kvox-ai';
import { completedEvent, createScriptedRuntime, functionCallEvent, textDeltaEvent } from '@marinoscar/kvox-ai/testing';
import type { AiStreamEvent } from '@marinoscar/platform-ai-providers';

import { scoreCitationValidity, scoreSensitiveLeak } from '../ask/index.js';
import { staticTaskModelSource } from '../live/index.js';
import { startAskEvalSession } from './run-ask-eval.js';

/**
 * The provider and model a replay names (the scripted runtime answers for them).
 *
 * @stability experimental
 */
export const ASK_REPLAY_MODEL = Object.freeze({ provider: 'openai', model: 'gpt-replay' } as const);

/**
 * The `sensitive` PersonFact text (m13) the leak gate looks for: it must never
 * appear in a captured request or an answer.
 *
 * @stability experimental
 */
export const ASK_REPLAY_SENSITIVE_TEXT = 'shellfish allergy';

/**
 * One scripted model call: tool calls (the model asking for tools) or the final answer.
 *
 * @stability experimental
 */
export type AskReplayStep =
  | {
      /** The calls, in order: id, tool name, arguments as the JSON text the provider streams. */
      toolCalls: readonly { id: string; name: string; arguments: string }[];
    }
  | {
      /** The answer text, citation markers included. */
      answer: string;
    };

/**
 * One scripted question and what its answer must show.
 *
 * @stability experimental
 */
export interface AskReplayScenario {
  /** A short id (`r1` .. `r6`). */
  id: string;
  /** What the test case proves. */
  title: string;
  /** The question. */
  question: string;
  /** The model calls, in order. */
  steps: readonly AskReplayStep[];
  /** What the finished message must show. */
  expected: {
    /** Every citation valid (citation validity 1.0), or at least one invalid (below 1). */
    allValid: boolean;
    /** Markers that must be present and invalid (with no resolved id). */
    invalidMarkers: readonly string[];
    /** The exact number of citations, when the scenario pins it. */
    citationCount?: number;
    /** A valid citation that must be present, by marker and kind. */
    validCitation?: { marker: string; kind: string };
  };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: JSON.stringify(args) });

/**
 * The six scripted questions of the replay, as data.
 *
 * @stability experimental
 */
export const ASK_REPLAY_SCENARIOS: readonly AskReplayScenario[] = Object.freeze([
  {
    id: 'r1',
    title: 'search → get_entity → cites [^ent1]: valid, citation validity 1.0',
    question: 'Who does Sarah Chen work for?',
    steps: [
      { toolCalls: [call('c1', 'search', { query: 'Sarah Chen', scope: 'entities', limit: null })] },
      { toolCalls: [call('c2', 'get_entity', { entity: 'ent1' })] },
      { answer: 'Sarah Chen works for Northwind Robotics.[^ent1]' },
    ],
    expected: { allValid: true, invalidMarkers: [] },
  },
  {
    id: 'r2',
    title: 'search → evidence(ent1) → cites [^ev1]: valid, citation validity 1.0',
    question: 'Where is the pick-path pilot?',
    steps: [
      { toolCalls: [call('c1', 'search', { query: 'pick-path pilot', scope: 'entities', limit: null })] },
      { toolCalls: [call('c2', 'evidence', { subject: 'ent1', limit: 5 })] },
      { answer: 'Here is what was said about it.[^ev1]' },
    ],
    expected: { allValid: true, invalidMarkers: [], citationCount: 1, validCitation: { marker: 'ev1', kind: 'evidence' } },
  },
  {
    id: 'r3',
    title: 'search → timeline → evidence(itm1) → cites [^ev1]: valid, citation validity 1.0',
    question: 'What has happened with Halden Freight?',
    steps: [
      { toolCalls: [call('c1', 'search', { query: 'Halden Freight', scope: 'entities', limit: null })] },
      { toolCalls: [call('c2', 'timeline', { entity: 'ent1', asOf: null, kinds: null, limit: 5 })] },
      { toolCalls: [call('c3', 'evidence', { subject: 'itm1', limit: 3 })] },
      { answer: 'Several things happened.[^ev1]' },
    ],
    expected: { allValid: true, invalidMarkers: [] },
  },
  {
    id: 'r4',
    title: 'a not-found question: search returns nothing, the answer cites nothing (citation validity vacuously 1.0)',
    question: 'What did Jamie Fontaine decide about the Meridian project?',
    steps: [
      { toolCalls: [call('c1', 'search', { query: 'Jamie Fontaine', scope: 'all', limit: null })] },
      { answer: "I couldn't find Jamie Fontaine or a Meridian project in your graph." },
    ],
    expected: { allValid: true, invalidMarkers: [], citationCount: 0 },
  },
  {
    id: 'r5',
    title: 'cites entity + evidence together, all valid: citation validity 1.0',
    question: 'Who runs the northern depots cutover, and what is the evidence?',
    steps: [
      { toolCalls: [call('c1', 'search', { query: 'Marcus Webb', scope: 'entities', limit: null })] },
      { toolCalls: [call('c2', 'get_entity', { entity: 'ent1' })] },
      { toolCalls: [call('c3', 'evidence', { subject: 'ent1', limit: 3 })] },
      { answer: 'Marcus Webb is involved.[^ent1] See here.[^ev1]' },
    ],
    expected: { allValid: true, invalidMarkers: [] },
  },
  {
    id: 'r6',
    title: 'THE PLANTED BAD ANSWER: cites an unissued [^ev99] alongside a real one: citation validity < 1',
    question: 'What is going on with the Corvid Health project?',
    steps: [
      { toolCalls: [call('c1', 'search', { query: 'Corvid Health', scope: 'entities', limit: null })] },
      { toolCalls: [call('c2', 'get_entity', { entity: 'ent1' })] },
      { answer: 'Corvid Health is a client.[^ent1] Also this, which nobody ever returned.[^ev99]' },
    ],
    expected: { allValid: false, invalidMarkers: ['ev99'] },
  },
] satisfies AskReplayScenario[]);

/**
 * The provider events of one scripted model call: the function calls (finish
 * reason `tool_calls`) or the answer's text (finish reason `stop`), then the
 * completed response with fixed usage.
 *
 * @param step - the step.
 * @returns the events, in order.
 * @stability experimental
 */
export function askReplayStepEvents(step: AskReplayStep): AiStreamEvent[] {
  const completed = (finishReason: 'stop' | 'tool_calls') =>
    completedEvent({
      id: 'resp_replay',
      provider: ASK_REPLAY_MODEL.provider,
      model: ASK_REPLAY_MODEL.model,
      usage: { inputTokens: 100, outputTokens: 20 },
      finishReason,
    });
  if ('answer' in step) return [textDeltaEvent(step.answer), completed('stop')];
  return [...step.toolCalls.map((c) => functionCallEvent(c.id, c.name, c.arguments)), completed('tool_calls')];
}

/**
 * One replayed question: the finished message and what it was checked for.
 *
 * @stability experimental
 */
export interface AskReplayResult {
  /** The scenario. */
  scenario: AskReplayScenario;
  /** The finished assistant message. */
  message: AskMessageResponse;
  /** Every `chat()` request of this turn, serialized. */
  capturedPrompts: string[];
  /** Citation validity (`scoreCitationValidity`). */
  citationValidity: number;
  /** Why the scenario failed its expectation; empty when it held. */
  failures: string[];
}

/**
 * The outcome of {@link runAskReplay}.
 *
 * @stability experimental
 */
export interface AskReplayRun {
  /** One per scenario, in order. */
  results: AskReplayResult[];
  /** The leak gate: no captured request and no answer contains {@link ASK_REPLAY_SENSITIVE_TEXT}. */
  leakFree: boolean;
  /** Every scenario held and the leak gate passed. */
  passed: boolean;
}

/** What one finished message failed of its scenario's expectation. */
function checkScenario(scenario: AskReplayScenario, message: AskMessageResponse): string[] {
  const failures: string[] = [];
  const { expected } = scenario;
  if (message.status !== 'complete') failures.push(`status is '${message.status}', not 'complete'`);
  const validity = scoreCitationValidity(message.citations);
  if (expected.allValid && validity !== 1) failures.push(`citation validity ${validity}, expected 1`);
  if (!expected.allValid && !(validity < 1)) failures.push(`citation validity ${validity}, expected < 1`);
  for (const marker of expected.invalidMarkers) {
    const citation = message.citations.find((c) => c.marker === marker);
    if (!citation || citation.valid || citation.id !== null) failures.push(`[^${marker}] is not present as an invalid citation`);
  }
  if (expected.citationCount !== undefined && message.citations.length !== expected.citationCount) {
    failures.push(`${message.citations.length} citation(s), expected ${expected.citationCount}`);
  }
  if (expected.validCitation) {
    const { marker, kind } = expected.validCitation;
    if (!message.citations.some((c) => c.marker === marker && c.kind === kind && c.valid)) {
      failures.push(`no valid ${kind} citation [^${marker}]`);
    }
  }
  return failures;
}

/**
 * Runs the replay: the whole golden graph seeded, the six scripted questions
 * through the real handler, each checked, and the leak gate over every request
 * and answer.
 *
 * @example
 * ```ts
 * const run = await runAskReplay();
 * if (!run.passed) process.exitCode = 1;
 * ```
 *
 * @param options - the scenarios (default {@link ASK_REPLAY_SCENARIOS}) and a progress sink.
 * @returns the results and the gates.
 * @stability experimental
 */
export async function runAskReplay(
  options: { scenarios?: readonly AskReplayScenario[]; log?: (line: string) => void } = {},
): Promise<AskReplayRun> {
  const scenarios = options.scenarios ?? ASK_REPLAY_SCENARIOS;
  const runtime = createScriptedRuntime();
  const ai = createKvoxAi({ runtime, taskModels: staticTaskModelSource(ASK_REPLAY_MODEL.provider, ASK_REPLAY_MODEL.model) });
  const session = await startAskEvalSession({ ai, ...(options.log ? { log: options.log } : {}) });
  try {
    const results: AskReplayResult[] = [];
    for (const scenario of scenarios) {
      for (const step of scenario.steps) runtime.queueStream({ events: askReplayStepEvents(step) });
      const { message, capturedPrompts } = await session.ask(scenario.question, ASK_REPLAY_MODEL.model);
      const failures = checkScenario(scenario, message);
      // Every scripted call played, and no more: a leftover would leak into the next question.
      const played = runtime.calls.filter((c) => c.kind === 'stream').length;
      if (played !== scenario.steps.length) failures.push(`${played} model call(s), the script has ${scenario.steps.length}`);
      runtime.reset();
      results.push({ scenario, message, capturedPrompts, citationValidity: scoreCitationValidity(message.citations), failures });
    }
    const leakFree = results.every(
      (r) =>
        !r.capturedPrompts.some((p) => p.toLowerCase().includes(ASK_REPLAY_SENSITIVE_TEXT)) &&
        !scoreSensitiveLeak([ASK_REPLAY_SENSITIVE_TEXT], r.message.content, []),
    );
    return { results, leakFree, passed: leakFree && results.every((r) => r.failures.length === 0) };
  } finally {
    await session.close();
  }
}

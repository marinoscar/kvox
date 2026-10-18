// =============================================================================
// runAskEval: the Ask evaluation, headless (issue #608; the web app's runner #382)
// =============================================================================
//
// Starts the in-memory host (`host/app.ts`), seeds the golden graph under the
// evaluation user (`seed-golden-graph.ts`), then for every selected question:
//
//   create a conversation (`AskConversationsService`) → post the question
//   through the REAL `AskMessagesService` (checks, transaction, the real
//   `ask.respond` job row) → invoke `AskRespondHandler.process(job)` DIRECTLY
//   (nothing else claims the job) → read the finished assistant message back.
//
// The turn runs on the model port the caller hands in, exactly as a production
// turn runs on the host's binding: live, `createLiveKvoxAi` (`createKvoxAi`
// over the direct runtime and the provider adapters); replay, `createKvoxAi`
// over a scripted runtime (`replay.ts`). Every request the port receives is
// captured through a thin wrapper around its own `chat()` (never a second
// implementation), so the scorer's leak check sees exactly what left the run.
//
// EVERYTHING DIES WITH THE RUN: the database is PGlite in memory and `close()`
// runs in a `finally`, so there is nothing to tear down and no deployment
// setting to restore (the web app's runner had both).
// =============================================================================

import type { AskMessageResponse } from '@marinoscar/kvox-contract/ask';
import { AskConversationsService } from '@marinoscar/kvox-api/ask';
import { internals } from '@marinoscar/kvox-api/ask/testing';
import { KvoxAiError, type KvoxAiPort } from '@marinoscar/kvox-api/ports';

import {
  buildAskEvalReport,
  scoreAnswer,
  selectAskEvalQuestions,
  type AskEvalQuestion,
  type AskEvalReport,
  type AskEvalScore,
} from '../ask/index.js';
import { loadGoldenAskQuestions, loadGoldenSet, type GoldenFixture } from '../fixtures/index.js';
import { startAskEvalHost, type AskEvalHost } from './host/app.js';
import { seedGoldenGraph, type AskEvalIdMap, type SeededGoldenGraph } from './seed-golden-graph.js';

/**
 * The model a live run uses when none is named.
 *
 * @stability experimental
 */
export const DEFAULT_ASK_EVAL_MODEL = 'gpt-4o-mini';

/**
 * One answered question.
 *
 * @stability experimental
 */
export interface AskQuestionRunResult {
  /** The question as asked. */
  question: AskEvalQuestion;
  /** The finished assistant message, as the API would return it. */
  message: AskMessageResponse;
  /** Every `chat()` request the port received while answering THIS question, serialized (signal removed). */
  capturedPrompts: string[];
  /** Wall-clock time of the turn, in milliseconds. */
  ms: number;
  /**
   * The model call that failed the turn, by the port's error class (`auth`,
   * `unavailable`, ...): the handler marked the message `failed` and the run went
   * on. Absent when the turn ran to its end.
   */
  modelError?: { errorClass: string };
}

/**
 * The scored outcome of a run.
 *
 * @stability experimental
 */
export interface AskEvalRunResult {
  /** One per question, in the order asked. */
  results: AskQuestionRunResult[];
  /** Fixture ids ↔ row ids (`evidenceSource` is what `citeFrom` resolves against). */
  idMap: AskEvalIdMap;
  /** What the seeder reported (refusals, warnings, counts). */
  seed: Pick<SeededGoldenGraph, 'refusals' | 'warnings' | 'counts'>;
  /** One score per result. */
  scores: AskEvalScore[];
  /** The aggregated report. */
  report: AskEvalReport;
}

/**
 * What {@link runAskEval} runs.
 *
 * @stability experimental
 */
export interface RunAskEvalOptions {
  /** The model port under test. */
  ai: KvoxAiPort;
  /** The model id each turn names (and the report records). */
  model: string;
  /** The questions, or ids of the committed ones. Default: every committed question. */
  questions?: readonly AskEvalQuestion[] | readonly string[];
  /** The golden meetings to seed. Default: `loadGoldenSet()`. */
  fixtures?: readonly GoldenFixture[];
  /** The answer-match gate of the report (0..1). Default 0.8. */
  minMatch?: number;
  /** Receives progress lines (steps, counts, question ids; never a question's text or an answer). */
  log?: (line: string) => void;
}

/** One `chat()` call as the port received it: the context without its signal, and the request. */
type CapturedChat = { ctx: Omit<Parameters<KvoxAiPort['chat']>[0], 'signal'>; request: Parameters<KvoxAiPort['chat']>[1] };

/**
 * Wraps the port's own `chat()` so every request is recorded. Mutates the port in
 * place (the handler holds the same object); returns the restorer.
 */
function wrapChatForCapture(port: KvoxAiPort, onRequest: (captured: CapturedChat) => void): () => void {
  const original = port.chat;
  const bound = original.bind(port);
  port.chat = (ctx, request) => {
    const { signal: _signal, ...rest } = ctx;
    onRequest({ ctx: rest, request });
    return bound(ctx, request);
  };
  return () => {
    port.chat = original;
  };
}

/**
 * A seeded host that answers one question at a time: what {@link runAskEval}
 * and the replay drive.
 *
 * @stability experimental
 */
export interface AskEvalSession {
  /** The running host. */
  readonly host: AskEvalHost;
  /** What the seeder wrote. */
  readonly seeded: SeededGoldenGraph;
  /**
   * Asks one question in a new conversation and runs its `ask.respond` job to the end.
   *
   * @param question - the question text.
   * @param model - the model id the turn names.
   * @returns the finished message and this turn's captured requests.
   */
  ask(question: string, model: string): Promise<Omit<AskQuestionRunResult, 'question'>>;
  /** Restores the port's `chat()` and closes the host. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Starts the host on `ai`, seeds the golden graph and returns a session that asks
 * questions through the real Ask services and handler.
 *
 * @param options - the port, the fixtures (default: the whole golden set) and a progress sink.
 * @returns the session; call `close()` when done (in a `finally`).
 * @stability experimental
 */
export async function startAskEvalSession(options: {
  ai: KvoxAiPort;
  fixtures?: readonly GoldenFixture[];
  log?: (line: string) => void;
}): Promise<AskEvalSession> {
  const log = options.log ?? (() => {});
  const fixtures = options.fixtures ?? loadGoldenSet();
  const host = await startAskEvalHost({ ai: options.ai, log });
  let bucket: CapturedChat[] = [];
  let unwrap: (() => void) | null = null;
  try {
    const seeded = await seedGoldenGraph(host, fixtures);
    log(
      `seed: ${fixtures.length} meetings, ${seeded.counts.entities} entities, ${seeded.counts.relations} relations, ` +
        `${seeded.counts.items} items, ${seeded.counts.evidence} citations` +
        (seeded.refusals.length ? `, ${seeded.refusals.length} refused` : '') +
        (seeded.warnings.length ? `, ${seeded.warnings.length} warning(s)` : ''),
    );
    for (const r of seeded.refusals) log(`seed refused: ${r.fixtureId} ${r.row}: ${r.reason}`);
    for (const w of seeded.warnings) log(`seed warning: ${w}`);

    const conversations = host.resolve(AskConversationsService);
    const messages = host.resolve(internals.AskMessagesService);
    const handler = host.resolve(internals.AskRespondHandler);
    unwrap = wrapChatForCapture(host.ai, (captured) => bucket.push(captured));

    let closed = false;
    return {
      host,
      seeded,
      async ask(question, model) {
        bucket = [];
        const started = Date.now();
        const conversation = await conversations.create(host.userId, {});
        const posted = await messages.post(host.userId, conversation.id, { content: question, model });
        const row = await host.prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
        const job = await host.prisma.job.findUniqueOrThrow({ where: { id: row.jobId as string } });
        let modelError: { errorClass: string } | undefined;
        try {
          await handler.process({
            id: job.id,
            type: job.type,
            subjectType: job.subjectType,
            subjectId: job.subjectId,
            payload: job.payload,
            attempts: job.attempts,
            orgId: job.orgId,
          });
        } catch (error) {
          // A failed model call: the handler has marked the turn `failed` and
          // rethrown for the queue (which would record the attempt). This run is
          // the queue; it records the class and goes on. A rate limit before any
          // text leaves the turn `pending` for a re-run, which a run cannot wait
          // for, so it (and anything else) stops the run.
          if (!(error instanceof KvoxAiError)) throw error;
          const settled = await host.prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id }, select: { status: true } });
          if (settled.status !== 'failed') throw error;
          modelError = { errorClass: error.errorClass };
        }
        const finished = await host.prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
        return {
          message: internals.toAskMessage(finished as never),
          capturedPrompts: bucket.map((r) => JSON.stringify(r)),
          ms: Date.now() - started,
          ...(modelError ? { modelError } : {}),
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        unwrap?.();
        await host.close();
      },
    };
  } catch (error) {
    unwrap?.();
    await host.close();
    throw error;
  }
}

/** The committed questions, narrowed to `ids`. */
function resolveQuestions(questions: RunAskEvalOptions['questions']): AskEvalQuestion[] {
  if (questions === undefined) return loadGoldenAskQuestions();
  if (questions.every((q): q is string => typeof q === 'string')) {
    return selectAskEvalQuestions(loadGoldenAskQuestions(), [...(questions as readonly string[])], null);
  }
  return [...(questions as readonly AskEvalQuestion[])];
}

/**
 * Runs the Ask evaluation headless: an in-memory PostgreSQL, the golden graph
 * seeded through the graph write service, every question through the real
 * `ask.respond` handler on `ai`, each answer scored.
 *
 * @example
 * ```ts
 * const key = readEvalApiKey(process.env);
 * const { ai } = createLiveKvoxAi({ provider: 'openai', model: 'gpt-4o-mini', apiKey: key?.apiKey ?? null });
 * const run = await runAskEval({ ai, model: 'gpt-4o-mini', questions: ['q01', 'q07'] });
 * console.log(formatAskEvalReport(run.report));
 * ```
 *
 * @param options - the port, the model, the questions and the gate.
 * @returns the answers, the id map, the scores and the report.
 * @throws `AskEvalQuestionLoadError` for an unknown question id; `KgEvalLoadError` for a malformed fixture.
 * @stability experimental
 */
export async function runAskEval(options: RunAskEvalOptions): Promise<AskEvalRunResult> {
  const log = options.log ?? (() => {});
  const questions = resolveQuestions(options.questions);
  const session = await startAskEvalSession({ ai: options.ai, ...(options.fixtures ? { fixtures: options.fixtures } : {}), log });
  try {
    const results: AskQuestionRunResult[] = [];
    for (const question of questions) {
      const answered = await session.ask(question.question, options.model);
      log(
        `ask: ${question.id} ${answered.message.status} in ${answered.ms} ms` +
          (answered.modelError ? ` (model call failed: ${answered.modelError.errorClass})` : ''),
      );
      results.push({ question, ...answered });
    }
    const idMap = session.seeded.idMap;
    const scores = results.map((r) => scoreAnswer(r.question, r.message, r.capturedPrompts, idMap.evidenceSource, { ms: r.ms }));
    const report = buildAskEvalReport(scores, { model: options.model, minMatch: options.minMatch ?? 0.8 });
    const { refusals, warnings, counts } = session.seeded;
    return { results, idMap, seed: { refusals, warnings, counts }, scores, report };
  } finally {
    await session.close();
  }
}

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { Prisma, aiProviderThrottleKey } from '../../core/index.js';
import { GraphAiRunResolver } from '../../graph/index.js';
import {
  KvoxAiError,
  KvoxRateLimitError,
  type KvoxAiPort,
  type KvoxJob,
  type KvoxJobsPort,
  type KvoxSettingsPort,
} from '../../ports/index.js';
import type { SearchTranscriptVisibility } from '../../search/index.js';
import { ASK_MAX_TOOL_STEPS } from '../ask-limits.js';
import { resolveAskOptions } from '../ask.options.js';
import { AskRespondHandler } from '../handlers/ask-respond.handler.js';
import { ASK_RESPOND_JOB_TYPE, type AskRespondPayload } from '../job-types.js';
import { HandleRegistry } from '../tools/handle-registry.js';
import type { AskToolset } from '../tools/ask-toolset.js';
import { createInMemoryAskDb, type InMemoryAskDb } from './in-memory-ask-db.js';
import { createScriptedChat, failWith, step, text, toolCall, type ScriptedChat, type ScriptedTurn } from './scripted-chat.js';

// =============================================================================
// The Ask conformance suite (issue #497, epic #491)
// =============================================================================
//
// `describeAskConformance` states, once, the rules of an Ask turn that a host's model binding must
// not break and a fork that changes the slice must keep. It runs the REAL `AskRespondHandler` (the
// loop, the caps, the answer hold, the citation check, every status-guarded write) over:
//
//   • the model port under test: any `KVOX_AI` implementation that passes `describeKvoxPortsConformance`
//     can be handed in, with a way to script what its next `chat` calls do (a host adapter scripts the
//     provider below it; the package's own run scripts a fake);
//   • an in-memory copy of the two Ask tables, a stub toolset and stub peers (identity, settings,
//     transcript visibility).
//
// THE RULES
//   job            `ask.respond` is server-only and takes ONE attempt (a retry bills the key twice for a
//                  different answer);
//   (a)            text before a tool call in the same step is held and discarded: it never reaches `content`;
//   (b)            nine model calls: eight tool steps, then ONE call with `toolChoice: 'none'`, ending
//                  `step_cap`;
//   (c)            a 429 before any text: the row goes back to `pending`, the job is deferred on THAT user's
//                  bucket (`aiProviderThrottleKey`), no attempt is charged;
//   (d)            a 429 after text was flushed: the turn FAILS `rate_limit` (a restart would rewrite the
//                  buffer under a connected reader), the text stays;
//   (e)            an invalid citation marker stays in `content` (append-only) and is flagged `valid: false`;
//   (f)            a conversation deleted mid-turn stops the turn with no orphan write;
//   read-only      the slice imports no graph write service, never writes a row of another slice, and every
//                  write to `ask_messages` from the handler carries `WHERE status = ...`;
//   host-neutral   no `@marinoscar/platform-*` and no `@prisma/client` in the slice's code.
// =============================================================================

/**
 * The test runner's functions, so the suite runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface AskConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * The model port under test, and how to script it.
 *
 * @stability experimental
 */
export interface AskAiUnderTest {
  /** The port (a real adapter, or a fake). Only `chat`, `resolveTask`, `capabilities` and `countTokens` are used. */
  port: Pick<KvoxAiPort, 'chat' | 'resolveTask' | 'capabilities' | 'countTokens'>;
  /**
   * Arranges what the next `chat` calls do, one {@link ScriptedTurn} per call in order: a host adapter
   * turns each event into the provider's own (`delta` into streamed text, `tool_call` into a function
   * call, a `fail` event into the provider's error: a `KvoxAiError` of class `rate_limit` into a 429).
   * A call after the script runs out answers with an empty step.
   *
   * @param turns - the steps of one test.
   */
  script(turns: ScriptedTurn[]): void | Promise<void>;
}

/**
 * Options of {@link describeAskConformance}.
 *
 * @stability experimental
 */
export interface AskConformanceOptions {
  /**
   * The folder holding the slice folders to scan for the read-only and host-neutral rules; the default
   * is the folder the package's slices sit in.
   */
  sourceRoot?: string;
}

const USER = '11111111-1111-4111-8111-111111111111';
const ENTITY = '55555555-5555-4555-8555-555555555555';
const QUESTION = 'What is going on with Acme?';
const ANSWER = 'Acme is a client of yours and signed the renewal in August. It is led by Sarah Chen.';

/** Graph services that write, which the Ask slice must never reference in code. */
const WRITE_SERVICES = [
  'GraphWriteService',
  'GraphEntitiesService',
  'GraphAttributeDefsService',
  'EvidenceValidator',
  'KgPurgeService',
  'GraphObjectsService',
  'EntityDigestEnqueuer',
  'GraphLayoutEnqueuer',
  'KgMigrateRepository',
] as const;

/** A step: text, then nothing else. */
const answer = (value: string): ScriptedTurn => step([text(value)]);

/** A step that calls the `search` tool. */
const lookup = (id: string): ScriptedTurn => step([toolCall(id, 'search', { query: 'acme' })]);

/** Source files of the Ask slice (specs, declarations and the testing folder excluded), comments stripped. */
function askSources(root: string): Array<{ path: string; code: string }> {
  const out: Array<{ path: string; code: string }> = [];
  const dir = join(root, 'ask');
  if (!existsSync(dir)) return out;

  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        if (name === 'testing' || name === 'node_modules' || name === '__fixtures__') continue;
        walk(full);
      } else if (/\.(ts|js)$/.test(name) && !/\.(spec|d)\.(ts|js)$/.test(name)) {
        const raw = readFileSync(full, 'utf8');
        const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        out.push({ path: relative(dir, full).split(sep).join('/').replace(/\.(ts|js)$/, ''), code });
      }
    }
  };
  walk(dir);

  return out;
}

/** A turn set up over the in-memory tables. */
interface Turn {
  mem: InMemoryAskDb;
  handler: AskRespondHandler;
  conversationId: string;
  assistantId: string;
  /** The `toolChoice` of every model call, in order. */
  toolChoices: Array<'auto' | 'none'>;
  /** The job the queue would hand the handler. */
  job: KvoxJob;
  /** Runs when the stub toolset executes a tool, before it answers. */
  onTool: { current: () => void };
}

function stubSettings(): KvoxSettingsPort {
  return {
    registerNamespace: () => undefined,
    readSystem: async () => ({ value: { graphEnabled: true, maxInputTokens: 100_000, maxOutputTokens: 16_000 }, version: 1 }),
  } as unknown as KvoxSettingsPort;
}

function stubVisibility(mem: InMemoryAskDb): SearchTranscriptVisibility {
  return {
    viewerFor: async (userId: string) => ({ userId }),
    transcriptVisibleSql: () => Prisma.sql`true`,
    run: (_viewer: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(mem.db),
  } as unknown as SearchTranscriptVisibility;
}

function stubToolset(onTool: { current: () => void }): AskToolset {
  return {
    definitions: () => [{ name: 'search', description: 'Search the graph', parameters: { type: 'object', properties: {} } }],
    createContext: async (user: { id: string }) => ({
      user,
      handles: new HandleRegistry(),
      personalFactsAllowed: false,
      scopeEntityId: null,
      now: new Date(),
    }),
    execute: async (ctx: { handles: HandleRegistry }) => {
      onTool.current();
      ctx.handles.register({ kind: 'ent', id: ENTITY, label: 'Acme' });

      return {
        ok: true as const,
        result: { data: { entities: [] }, resultCount: 1, summary: 'Found 1 thing', truncated: false },
        json: '{"entities":[{"ref":"ent1"}],"truncated":false}',
      };
    },
  } as unknown as AskToolset;
}

function buildTurn(ai: AskAiUnderTest): Turn {
  const mem = createInMemoryAskDb();
  const conversation = mem.addConversation({ ownerId: USER });
  mem.addMessage({ conversationId: conversation.id, role: 'user', content: QUESTION });
  const assistant = mem.addMessage({ conversationId: conversation.id, role: 'assistant' });

  const toolChoices: Array<'auto' | 'none'> = [];
  // A proxy, not a spread: a real adapter is a class instance whose methods live on its prototype.
  const port = new Proxy(ai.port, {
    get(target, property) {
      if (property === 'chat') {
        return (ctx: Parameters<KvoxAiPort['chat']>[0], req: Parameters<KvoxAiPort['chat']>[1]) => {
          toolChoices.push(req.toolChoice);

          return target.chat(ctx, req);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as KvoxAiPort;

  const onTool = { current: () => undefined as void };
  const jobs = { registerHandler: () => undefined } as unknown as KvoxJobsPort;
  const identity = { hasPermission: async () => true, authenticate: async () => null };
  const handler = new AskRespondHandler(
    jobs,
    mem.db,
    port,
    identity,
    new GraphAiRunResolver(port, stubSettings()),
    stubToolset(onTool),
    stubVisibility(mem),
    resolveAskOptions(),
  );
  const payload: AskRespondPayload = {
    assistantMessageId: assistant.id,
    conversationId: conversation.id,
    userId: USER,
    model: 'scripted-model',
    providerId: 'openai',
    reasoningEffort: 'low',
  };
  const job: KvoxJob = {
    id: 'job-1',
    type: ASK_RESPOND_JOB_TYPE,
    subjectType: 'ask_message',
    subjectId: assistant.id,
    payload,
    attempts: 0,
    orgId: null,
  };

  return { mem, handler, conversationId: conversation.id, assistantId: assistant.id, toolChoices, job, onTool };
}

/**
 * The scripted fake as the model under test, with the fake itself for a spec that wants its recorded requests.
 *
 * @stability experimental
 */
export interface ScriptedAskAi extends AskAiUnderTest {
  /** The scripted model, to read what it was asked. */
  chat: ScriptedChat;
}

/**
 * A scripted fake wrapped as the model under test, for the package's own run of the suite.
 *
 * @returns the fake, ready to be handed to {@link describeAskConformance}.
 * @stability experimental
 */
export function scriptedAiUnderTest(): ScriptedAskAi {
  const chat = createScriptedChat();

  return {
    chat,
    port: chat,
    script(turns) {
      chat.reset();
      chat.enqueue(...turns);
    },
  };
}

/**
 * Registers the Ask conformance suite.
 *
 * @param name - names the binding under test in the report.
 * @param aiFactory - builds a fresh model port under test for each test.
 * @param api - the runner's `describe`, `it` and `expect`.
 * @param options - where to scan for the read-only and host-neutral rules.
 * @stability experimental
 */
export function describeAskConformance(
  name: string,
  aiFactory: () => AskAiUnderTest | Promise<AskAiUnderTest>,
  api: AskConformanceHarness,
  options: AskConformanceOptions = {},
): void {
  const { describe, it, expect } = api;
  const sourceRoot = options.sourceRoot ?? join(__dirname, '..', '..');

  const run = async (turns: ScriptedTurn[]): Promise<Turn> => {
    const ai = await aiFactory();
    await ai.script(turns);

    return buildTurn(ai);
  };
  const row = (turn: Turn) => turn.mem.messages.get(turn.assistantId);

  describe(`ask conformance: ${name}`, () => {
    describe('the job', () => {
      it('ask.respond is server-only, spends the asker\'s key and takes one attempt', async () => {
        const { handler } = await run([]);

        expect(handler.type).toBe('ask.respond');
        expect(handler.usesAi).toBe(true);
        expect(handler.profile).toEqual({ maxRuntimeMs: 5 * 60_000, maxAttempts: 1 });
        expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
        expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
      });
    });

    describe('a turn', () => {
      it('(a) holds text that precedes a tool call in the same step and discards it', async () => {
        const turn = await run([
          step([text('Let me look that up for you now, one moment.'), toolCall('c1', 'search', { query: 'acme' })]),
          answer(ANSWER),
        ]);

        await turn.handler.process(turn.job);

        expect(row(turn)?.status).toBe('complete');
        expect(row(turn)?.content).toBe(ANSWER);
        expect(row(turn)?.content).not.toContain('Let me look');
      });

      it('(b) nine model calls: eight tool steps, then one toolChoice none call, ending step_cap', async () => {
        const turn = await run([
          ...Array.from({ length: ASK_MAX_TOOL_STEPS }, (_, i) => lookup(`c${i}`)),
          answer(ANSWER),
        ]);

        await turn.handler.process(turn.job);

        expect(turn.toolChoices).toHaveLength(ASK_MAX_TOOL_STEPS + 1);
        expect(turn.toolChoices.slice(0, ASK_MAX_TOOL_STEPS).every((choice) => choice === 'auto')).toBe(true);
        expect(turn.toolChoices.filter((choice) => choice === 'none')).toHaveLength(1);
        expect(turn.toolChoices[ASK_MAX_TOOL_STEPS]).toBe('none');
        expect(row(turn)?.status).toBe('complete');
        expect(row(turn)?.finishReason).toBe('step_cap');
      });

      it('(c) a 429 before any text defers the job on the asker\'s bucket and resets the row to pending', async () => {
        const turn = await run([step([failWith(new KvoxAiError('rate_limit', 'slow down', 1000))])]);

        const outcome = await turn.handler.process(turn.job).then(
          () => null,
          (error: unknown) => error,
        );

        expect(outcome).toBeInstanceOf(KvoxRateLimitError);
        expect((outcome as KvoxRateLimitError).throttleKey).toBe(aiProviderThrottleKey(USER));
        expect(row(turn)?.status).toBe('pending');
        expect(row(turn)?.content).toBe('');
        expect(row(turn)?.toolCalls).toEqual([]);
      });

      it('(d) a 429 after flushed text fails the turn rate_limit and keeps the text', async () => {
        const long = 'y'.repeat(600);
        const turn = await run([
          step([text(long), toolCall('c1', 'search', { query: 'acme' })]),
          step([failWith(new KvoxAiError('rate_limit', 'slow down', 1000))]),
        ]);

        await expect(turn.handler.process(turn.job)).resolves.toBeUndefined();

        expect(row(turn)?.status).toBe('failed');
        expect(row(turn)?.errorClass).toBe('rate_limit');
        expect(row(turn)?.content).toBe(long);
      });

      it('(e) an invalid citation marker stays in content and is flagged valid: false', async () => {
        const marked = `${ANSWER}[^ev9]`;
        const turn = await run([answer(marked)]);

        await turn.handler.process(turn.job);

        expect(row(turn)?.status).toBe('complete');
        expect(row(turn)?.content).toBe(marked);
        const citations = row(turn)?.citations as Array<{ marker: string; valid: boolean; id: string | null }>;

        expect(citations).toHaveLength(1);
        expect(citations[0].marker).toBe('ev9');
        expect(citations[0].valid).toBe(false);
        expect(citations[0].id).toBeNull();
      });

      it('(f) a conversation deleted mid-turn stops the turn with no orphan write', async () => {
        const turn = await run([lookup('c1'), answer(ANSWER)]);
        turn.onTool.current = () => turn.mem.deleteConversation(turn.conversationId);

        await expect(turn.handler.process(turn.job)).resolves.toBeUndefined();

        expect(turn.mem.messages.size).toBe(0);
        expect(turn.mem.conversations.size).toBe(0);
        // The loop stopped at the first write that found the row gone: no second model call.
        expect(turn.toolChoices).toHaveLength(1);
      });
    });

    describe('the slice is read-only and host-neutral', () => {
      it('imports no graph write service', () => {
        const sources = askSources(sourceRoot);

        expect(sources.length).toBeGreaterThan(20);

        const pattern = new RegExp(`\\b(${WRITE_SERVICES.join('|')})\\b`);
        const offenders = sources.filter(({ code }) => pattern.test(code)).map(({ path }) => path);

        expect(offenders).toEqual([]);
      });

      it('writes no graph table and no other slice\'s table', () => {
        const sources = askSources(sourceRoot);
        const write =
          /\.(kgEntity|kgRelation|kgItem|kgEvidence|kgMention|transcript|note)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
        const sql = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(kg_|transcripts|notes)/i;
        const offenders = sources.filter(({ code }) => write.test(code) || sql.test(code)).map(({ path }) => path);

        expect(offenders).toEqual([]);
      });

      it('every write the handler makes to ask_messages is guarded by a status', () => {
        const handler = askSources(sourceRoot).find(({ path }) => path === 'handlers/ask-respond.handler');

        expect(handler).toBeDefined();

        const code = handler?.code ?? '';

        // Nothing but `updateMany` writes the row: no create, delete or unguarded update.
        expect(code).not.toMatch(/askMessage\s*\.\s*(create|createMany|update|upsert|delete|deleteMany)\s*\(/);

        const writes = [...code.matchAll(/askMessage\s*\.\s*updateMany\s*\(\s*\{([\s\S]{0,160})/g)];

        expect(writes.length).toBeGreaterThan(3);
        for (const write of writes) expect(write[1]).toMatch(/status\s*:/);
      });

      it('imports no @marinoscar/platform-* package and no generated Prisma client', () => {
        const pattern = /['"](@marinoscar\/platform-[^'"]*|@prisma\/client)['"]/;
        const offenders = askSources(sourceRoot)
          .filter(({ code }) => pattern.test(code))
          .map(({ path }) => path);

        expect(offenders).toEqual([]);
      });
    });
  });
}

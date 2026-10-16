// =============================================================================
// The Ask evaluation's runner (issue #382, epic #348)
// =============================================================================
//
// Boots a real Nest application context (`JOBS_WORKER_MODE=off`, so nothing
// else claims the `ask.respond` jobs this run creates), seeds #362's gold
// graph under one throwaway user, temporarily points the graph agent task at the
// eval model (the graph switch on, `taskModels['graph.agent']`), stores the API
// key from `ASK_EVAL_OPENAI_API_KEY` on that user through the platform's key
// service, then for every selected question:
//
//   create a conversation → POST it through the REAL `AskMessagesService`
//   (checks, transaction, the real `ask.respond` job row) → invoke
//   `AskRespondHandler.process(job)` DIRECTLY (no queue poll — this process
//   is the only claimer) → read the finished assistant message back.
//
// The run goes through the REAL `KvoxAi` port (`PlatformKvoxAi.chat()` over the
// platform's `stream()`, on the eval user's own stored key), exactly as a
// production turn does (#476). Every request the port receives is captured through
// a thin wrapper around its own `chat()` — never a second implementation — so the
// scorer's leak check sees exactly what left this deployment.
//
// PRECONDITION (a deployment fact, not something this file creates): the `ai`
// policy has the OpenAI provider enabled and the eval model enabled in the model
// catalog, with tool calling.
//
// Everything this file changes about the deployment (the graph switch and the
// `graph.agent` task model, the eval user's stored key, the seeded graph) is
// undone by `teardown()` / `close()`, unless the caller asks to keep it for
// debugging (`--keep` skips only the graph teardown — the shared `ai` policy is
// ALWAYS restored, because leaving the eval model wired in would silently change
// what every other user's Ask conversation runs on).
// =============================================================================

// Registers the settings namespaces the DTOs are composed from. Must be the
// first import (see src/kvox.manifest.ts).
import '../../src/kvox.manifest';

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { UserAiKeysService } from '@marinoscar/platform-api/ai';

import { AppModule } from '../../src/app.module';
import { AiTasksService } from '../../src/ai-port/ai-tasks.service';
import type { UpdateAiTasksSettings } from '../../src/ai-port/dto/ai-tasks.dto';
import { KVOX_AI, type KvoxAi, type KvoxChatRequest } from '../../src/ai-port/kvox-ai';
import { AskConversationsService } from '../../src/ask/ask-conversations.service';
import { toAskMessage } from '../../src/ask/ask-message.mapper';
import { AskMessagesService } from '../../src/ask/ask-messages.service';
import type { AskMessageResponse } from '../../src/ask/dto/ask.dto';
import { AskRespondHandler } from '../../src/ask/handlers/ask-respond.handler';
import { PrismaService } from '../../src/prisma/prisma.service';
import { loadGoldenSet } from '../kg-eval/load';
import type { AskEvalQuestion } from './question-schema';
import { assertSafeDatabase, seedGraph, teardownSeededGraph, type AskEvalIdMap } from './seed-graph';

export const ASK_EVAL_API_KEY_ENV = 'ASK_EVAL_OPENAI_API_KEY';
export const ASK_EVAL_PROVIDER_ID = 'openai';
export const DEFAULT_ASK_EVAL_MODEL = 'gpt-4o-mini';

export interface QuestionRunResult {
  question: AskEvalQuestion;
  message: AskMessageResponse;
  /** Every `messages` array the provider received while answering THIS question, serialized. */
  capturedPrompts: string[];
  ms: number;
}

export interface AskEvalRunHandle {
  idMap: AskEvalIdMap;
  results: QuestionRunResult[];
  /** Restores the `ai` policy and the eval user's credential; deletes the seeded graph unless `keep`. */
  teardown(): Promise<void>;
  /** Closes the Nest application context. Call once, after `teardown()`. */
  close(): Promise<void>;
}

/** The `ai` policy patch this run applies. Exported for the CLI's own logging. */
export function askEvalAiPatch(model: string): UpdateAiTasksSettings {
  return { graphEnabled: true, taskModels: { 'graph.agent': { model } } };
}

/** The two fields this run touches, as the patch that restores them. */
function restorePatch(previous: { graphEnabled: boolean; taskModels: UpdateAiTasksSettings['taskModels'] }): UpdateAiTasksSettings {
  return { graphEnabled: previous.graphEnabled, taskModels: previous.taskModels ?? {} };
}

/** A request-capturing wrapper around the port's own `chat()`. Mutates the port in place; returns the restorer. */
function wrapChatForCapture(port: KvoxAi, onRequest: (request: KvoxChatRequest) => void): () => void {
  const original = port.chat;
  const bound = original.bind(port);
  port.chat = (request) => {
    onRequest(request);
    return bound(request);
  };
  return () => {
    port.chat = original;
  };
}

export interface RunAskEvalOptions {
  questions: AskEvalQuestion[];
  model: string;
  apiKey: string;
  /** Skip deleting the seeded graph — for `--keep` debugging. Default `false`. */
  keep?: boolean;
  /** Database name override for the safe-DB guard (`--allow-db`). */
  allowDb?: string | null;
}

/**
 * Runs every question in `options.questions` against a freshly seeded gold
 * graph, on a real Nest application context, and returns the results plus a
 * `teardown()`/`close()` that undo everything this run changed.
 */
export async function runAskEval(options: RunAskEvalOptions): Promise<AskEvalRunHandle> {
  // The database name is read from the environment directly — the same
  // POSTGRES_DB `buildDatabaseUrl()` reads — so the safe-database guard never
  // needs a live connection to refuse an unsafe one.
  assertSafeDatabase(process.env.POSTGRES_DB ?? '', options.allowDb ?? null);

  // Read before `AppModule` boots: `JobsModule`'s worker loop reads this at
  // construction, and this process must be the ONLY claimer of the
  // `ask.respond` jobs it is about to create.
  process.env.JOBS_WORKER_MODE = 'off';

  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  const prisma = app.get(PrismaService) as unknown as PrismaClient;
  const userKeys = app.get(UserAiKeysService, { strict: false });
  const aiTasks = app.get(AiTasksService, { strict: false });
  const port = app.get<KvoxAi>(KVOX_AI, { strict: false });
  const conversations = app.get(AskConversationsService);
  const messages = app.get(AskMessagesService);
  const handler = app.get(AskRespondHandler);

  const fixtures = loadGoldenSet();
  const seeded = await seedGraph(prisma, fixtures);
  const previousAi = (await aiTasks.describeForAdmin()).settings;

  try {
    await aiTasks.update(askEvalAiPatch(options.model), seeded.userId);
    // Verified against the provider and stored encrypted, like a key a person saves in settings.
    await userKeys.set(seeded.userId, ASK_EVAL_PROVIDER_ID, options.apiKey);

    let captureBucket: KvoxChatRequest[] = [];
    const unwrapChat = wrapChatForCapture(port, (request) => captureBucket.push(request));

    const results: QuestionRunResult[] = [];
    try {
      for (const question of options.questions) {
        captureBucket = [];
        const started = Date.now();

        const conversation = await conversations.create(seeded.userId, {});
        const posted = await messages.post(seeded.userId, conversation.id, { content: question.question, model: options.model });

        const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
        const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
        await handler.process(job as Job);

        const finished = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
        results.push({
          question,
          message: toAskMessage(finished),
          capturedPrompts: captureBucket.map((r) => JSON.stringify(r)),
          ms: Date.now() - started,
        });
      }
    } finally {
      unwrapChat();
    }

    const teardown = async () => {
      // ALWAYS: this deployment's shared `ai` policy is not this eval's to keep.
      await aiTasks.update(restorePatch(previousAi), seeded.userId);
      if (!options.keep) await teardownSeededGraph(prisma, seeded.userId);
    };

    return { idMap: seeded.idMap, results, teardown, close: () => app.close() };
  } catch (err) {
    // A failure mid-run must not leave the deployment's live `ai` policy
    // pointed at the eval model, nor the seeded graph behind with no handle
    // left to clean it up.
    await aiTasks.update(restorePatch(previousAi), seeded.userId).catch(() => undefined);
    await teardownSeededGraph(prisma, seeded.userId).catch(() => undefined);
    await app.close();
    throw err;
  }
}

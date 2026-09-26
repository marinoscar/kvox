// =============================================================================
// The Ask evaluation's runner (issue #382, epic #348)
// =============================================================================
//
// Boots a real Nest application context (`JOBS_WORKER_MODE=off`, so nothing
// else claims the `ask.respond` jobs this run creates), seeds #362's gold
// graph under one throwaway user, temporarily points this deployment's `ai`
// policy at the eval model, stores the API key from `ASK_EVAL_OPENAI_API_KEY`
// on that user, then for every selected question:
//
//   create a conversation → POST it through the REAL `AskMessagesService`
//   (checks, transaction, the real `ask.respond` job row) → invoke
//   `AskRespondHandler.process(job)` DIRECTLY (no queue poll — this process
//   is the only claimer) → read the finished assistant message back.
//
// Every `messages` array the provider actually receives is captured through
// a thin wrapper around the registered provider's own `chat()` — never a
// second implementation of the provider — so the scorer's leak check sees
// exactly what left this deployment.
//
// Everything this file changes about the deployment (the `ai` policy, the
// eval user's stored key, the seeded graph) is undone by `teardown()` /
// `close()`, unless the caller asks to keep it for debugging (`--keep`
// skips only the graph teardown — the shared `ai` policy is ALWAYS restored,
// because leaving the eval model wired in would silently change what every
// other user's Ask conversation runs on).
// =============================================================================

import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { AppModule } from '../../src/app.module';
import { AiProviderRegistry } from '../../src/ai/ai-provider.registry';
import type { SystemAiPatchValue, SystemAiValue } from '../../src/ai/ai-settings.schema';
import { AiSettingsService } from '../../src/ai/ai-settings.service';
import type { AiChatEvent, AiChatRequest, AiProviderContext } from '../../src/ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../src/ai/user-ai-credentials.service';
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
export function askEvalAiPatch(model: string): SystemAiPatchValue {
  return {
    enabled: true,
    graphEnabled: true,
    provider: ASK_EVAL_PROVIDER_ID,
    providers: { openai: { allowedModels: [{ id: model }], defaultModel: model } },
    taskModels: { 'graph.agent': { model } },
  };
}

/** The subset of a prior `SystemAiValue` this run touches, as the patch that restores it. */
function restorePatch(previous: SystemAiValue): SystemAiPatchValue {
  return {
    enabled: previous.enabled,
    graphEnabled: previous.graphEnabled,
    provider: previous.provider,
    providers: { openai: { allowedModels: previous.providers.openai.allowedModels, defaultModel: previous.providers.openai.defaultModel } },
    taskModels: previous.taskModels,
  };
}

/** A prompt-capturing wrapper around a real provider's `chat()`. Mutates the provider in place; returns the restorer. */
function wrapChatForCapture(
  provider: { chat?(ctx: AiProviderContext<never>, request: AiChatRequest): AsyncIterable<AiChatEvent> },
  onRequest: (request: AiChatRequest) => void,
): () => void {
  const original = provider.chat;
  if (!original) throw new Error('provider has no chat() to wrap for capture');
  const bound = original.bind(provider);
  provider.chat = (ctx, request) => {
    onRequest(request);
    return bound(ctx, request);
  };
  return () => {
    provider.chat = original;
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
  const credentials = app.get(UserAiCredentialsService);
  const aiSettings = app.get(AiSettingsService);
  const registry = app.get(AiProviderRegistry);
  const conversations = app.get(AskConversationsService);
  const messages = app.get(AskMessagesService);
  const handler = app.get(AskRespondHandler);

  const fixtures = loadGoldenSet();
  const seeded = await seedGraph(prisma, fixtures);
  const previousAi = await aiSettings.get();

  try {
    await aiSettings.update(askEvalAiPatch(options.model), seeded.userId);
    await credentials.save({ provider: ASK_EVAL_PROVIDER_ID, apiKey: options.apiKey }, seeded.userId);

    const provider = registry.get(ASK_EVAL_PROVIDER_ID);
    if (!provider?.chat) throw new Error(`provider "${ASK_EVAL_PROVIDER_ID}" has no chat() — cannot run Ask`);
    let captureBucket: AiChatRequest[] = [];
    const unwrapChat = wrapChatForCapture(provider, (request) => captureBucket.push(request));

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
      await aiSettings.update(restorePatch(previousAi), seeded.userId);
      if (!options.keep) await teardownSeededGraph(prisma, seeded.userId);
    };

    return { idMap: seeded.idMap, results, teardown, close: () => app.close() };
  } catch (err) {
    // A failure mid-run must not leave the deployment's live `ai` policy
    // pointed at the eval model, nor the seeded graph behind with no handle
    // left to clean it up.
    await aiSettings.update(restorePatch(previousAi), seeded.userId).catch(() => undefined);
    await teardownSeededGraph(prisma, seeded.userId).catch(() => undefined);
    await app.close();
    throw err;
  }
}

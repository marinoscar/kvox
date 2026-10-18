// =============================================================================
// The headless Ask evaluation's host: PGlite + the domain slices on Nest (#608)
// =============================================================================
//
// What `ask.respond` needs and nothing more, as a Nest APPLICATION CONTEXT (no
// HTTP server): the ports module, then the transcription, search, transcripts,
// notes, graph and Ask slices, every optional feature switched off the way the
// bare host (examples/bare-host) switches them off:
//
//   schedules: false        no `@nestjs/schedule` timers; nothing housekeeps a
//                           database that lives for one run
//   media.transcode: false  no ffmpeg
//   exporters / documentSources pdf, docx: false   no pdfkit, docx, unpdf
//   providers.assemblyai: false   no transcription provider at all: the seeded
//                           transcripts are already `ready`
//   semantic search off     the seeded rows carry no embeddings, and a query
//                           embedding would spend the key under test
//
// NOT graph-extraction and NOT graph-rdf: the golden graph is seeded from the
// fixtures' HAND LABELS through `GraphWriteService`, so the evaluation isolates
// the agent (extraction quality is `kvox-eval kg`'s question).
//
// THE `peers` OPTION passes the very module objects this module imports, so the
// container holds one module per slice and each job handler registers once.
//
// The host module is a plain class: a dynamic module needs no decorator, and the
// package compiles without decorator metadata (the slices carry their own).
// =============================================================================

import 'reflect-metadata';

import type { DynamicModule, INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AskModule } from '@marinoscar/kvox-api/ask';
import { GraphModule } from '@marinoscar/kvox-api/graph';
import { NotesModule } from '@marinoscar/kvox-api/notes';
import type { KvoxAiPort, KvoxPrismaClientLike, KvoxSettingsPort } from '@marinoscar/kvox-api/ports';
import { SearchIndexingModule, SearchModule } from '@marinoscar/kvox-api/search';
import { createKvoxTestingModule } from '@marinoscar/kvox-api/testing';
import { TranscriptionModule } from '@marinoscar/kvox-api/transcription';
import { TranscriptsModule } from '@marinoscar/kvox-api/transcripts';

import { startAskEvalDatabase, type AskEvalDatabase, type AskEvalPrismaClient } from './db.js';
import { createAskEvalIdentity, createAskEvalJobs, createAskEvalSettings } from './ports.js';

/**
 * The evaluation user's email. A reserved domain (`.invalid`): the account exists
 * only in the run's in-memory database.
 *
 * @stability experimental
 */
export const ASK_EVAL_USER_EMAIL = 'ask-eval@kvox-eval.invalid';

/**
 * What {@link startAskEvalHost} is built from.
 *
 * @stability experimental
 */
export interface StartAskEvalHostOptions {
  /** The model port every turn runs on (the port under test). */
  ai: KvoxAiPort;
  /** Receives progress lines (steps and counts, never data). */
  log?: (line: string) => void;
}

/**
 * A running evaluation host.
 *
 * @stability experimental
 */
export interface AskEvalHost {
  /** The Nest application context the slices run in. */
  readonly app: INestApplicationContext;
  /** The client on the in-memory database. */
  readonly prisma: AskEvalPrismaClient;
  /** The model port the slices were given. */
  readonly ai: KvoxAiPort;
  /** The settings port the slices were given (in memory; the `ai` namespace declared). */
  readonly settings: KvoxSettingsPort;
  /** The evaluation user (owner of every seeded row). */
  readonly userId: string;
  /** The default organization (adopted from the platform migrations). */
  readonly orgId: string;
  /** A provider from anywhere in the container (`app.get(type, { strict: false })`). */
  resolve<T>(type: Type<T>): T;
  /** Closes the application context, the client and the database. Safe to call twice. */
  close(): Promise<void>;
}

/** The domain slices `ask.respond` needs, wired like the bare host's, minus extraction and RDF. */
function createAskEvalModule(ports: Parameters<typeof createKvoxTestingModule>[0]): DynamicModule {
  const transcription = TranscriptionModule.forRoot({ providers: { assemblyai: false } });
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({
    schedules: false,
    media: { transcode: false },
    exporters: { pdf: false },
    peers: { transcription, searchIndexing },
  });
  const notes = NotesModule.forRoot({
    schedules: false,
    exporters: { pdf: false, docx: false },
    documentSources: { pdf: false },
    peers: { transcripts, searchIndexing },
  });
  const search = SearchModule.forRoot({ semantic: { enabled: false } });
  const graph = GraphModule.forRoot({ schedules: false, peers: { transcripts, notes, search } });
  const ask = AskModule.forRoot({ peers: { graph, notes, search } });

  class AskEvalHostModule {}
  return {
    module: AskEvalHostModule,
    imports: [createKvoxTestingModule(ports), transcription, search, searchIndexing, transcripts, notes, graph, ask],
  };
}

/**
 * Starts the in-memory database, adopts its default organization, creates the
 * evaluation user and boots the domain slices over the evaluation's ports.
 *
 * @example
 * ```ts
 * const host = await startAskEvalHost({ ai });
 * try {
 *   const seeded = await seedGoldenGraph(host, loadGoldenSet());
 *   // ... post questions, run the handler
 * } finally {
 *   await host.close();
 * }
 * ```
 *
 * @param options - the model port and a progress sink.
 * @returns the host; call `close()` when done.
 * @stability experimental
 */
export async function startAskEvalHost(options: StartAskEvalHostOptions): Promise<AskEvalHost> {
  const log = options.log ?? (() => {});
  const database: AskEvalDatabase = await startAskEvalDatabase(log);
  const { prisma } = database;
  let app: INestApplicationContext | null = null;

  try {
    // The platform's own migrations create the default organization (its partial
    // unique index allows exactly one): adopt it, as the bare host does.
    const org = await prisma.organization.findFirst({ where: { isDefault: true }, select: { id: true } });
    if (!org) throw new Error('The platform migrations created no default organization.');
    const user = await prisma.user.create({
      data: { email: ASK_EVAL_USER_EMAIL, displayName: 'Ask evaluation', isActive: true },
      select: { id: true },
    });

    const settings = createAskEvalSettings();
    app = await NestFactory.createApplicationContext(
      createAskEvalModule({
        overrides: {
          ai: options.ai,
          prisma: prisma as unknown as KvoxPrismaClientLike,
          settings,
          jobs: createAskEvalJobs(org.id),
          identity: createAskEvalIdentity(user.id, org.id),
        },
      }),
      { logger: ['error', 'warn'] },
    );
    log('host: slices started');

    const context = app;
    let closed = false;
    return {
      app: context,
      prisma,
      ai: options.ai,
      settings,
      userId: user.id,
      orgId: org.id,
      resolve: <T>(type: Type<T>): T => context.get(type, { strict: false }),
      async close() {
        if (closed) return;
        closed = true;
        await context.close().catch(() => undefined);
        await database.close();
      },
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await database.close();
    throw error;
  }
}

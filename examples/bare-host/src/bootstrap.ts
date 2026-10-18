import 'reflect-metadata';

import { resolve } from 'node:path';

import type { Type } from '@nestjs/common';
import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { createRecordingKvoxNotify, type FakeKvoxAi, type RecordingKvoxNotify } from '@marinoscar/kvox-api/testing';

import { createBareHostModule } from './app.module.js';
import { PROJECT_ROOT, createPrismaClient, startDatabase, type BareHostDatabase, type DbLeg } from './db.js';
import { createBareHostAi } from './fake-ai.js';
import { HostHousekeeping } from './housekeeping.js';
import { FileSettings } from './ports/file-settings.js';
import { LocalFsObjectStore } from './ports/local-fs-object-store.js';
import { LocalSingleUserIdentity } from './ports/local-single-user-identity.js';
import { MemorySecrets } from './ports/memory-secrets.js';
import { PgTableJobs } from './ports/pg-table-jobs.js';
import { LOCAL_USER_ID, seedDatabase, seedRuntime } from './seed.js';
import {
  GRAPH_PERMISSIONS,
  NOTES_PERMISSIONS,
  NOTE_TEMPLATES_PERMISSIONS,
  TRANSCRIPTS_PERMISSIONS,
} from './permissions.js';

// =============================================================================
// Starting the bare host
// =============================================================================
//
// `main.ts` calls this, and so does the end-to-end test: the same wiring, with the
// background job loop and the hourly housekeeping timer on for `main.ts` and off
// for the test (which drains the queue and calls `housekeeping.runOnce()`
// itself, so every step is deterministic).
// =============================================================================

/** The text the fake model "writes" for every note. */
export const FAKE_NOTE_TEXT = [
  '# Smoke test notes\n\n',
  'The bare host runs the transcripts, notes and search slices.\n\n',
  '- Every port is a small local implementation.\n',
  '- Quarterly zebracorn planning is on track.\n',
];

/** Options of {@link startBareHost}. */
export interface StartOptions {
  /** Which PostgreSQL to use; default `BARE_HOST_DB` or `service`. */
  leg?: DbLeg;
  /** The loopback port; default 0 (the system picks one). */
  port?: number;
  /** Where objects, settings and scratch files live; default `<project>/.data`. */
  dataDir?: string;
  /** Run the 200 ms background job loop and the hourly housekeeping timer (default true). */
  backgroundJobs?: boolean;
  /** Receives progress lines. */
  log?: (line: string) => void;
}

/** A running bare host. */
export interface RunningBareHost {
  /** `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  readonly app: NestFastifyApplication;
  readonly prisma: PrismaClient;
  readonly database: BareHostDatabase;
  readonly jobs: PgTableJobs;
  readonly objectStore: LocalFsObjectStore;
  /** The identity port the application authenticates with. */
  readonly identity: LocalSingleUserIdentity;
  readonly notify: RecordingKvoxNotify;
  /** The fake model (`fake-ai.ts`); `ai.calls` records every call the slices made. */
  readonly ai: FakeKvoxAi;
  /** The enqueuers `@nestjs/schedule` would have ticked; `runOnce()` queues one round. */
  readonly housekeeping: HostHousekeeping;
  /** A provider from anywhere in the container (`app.get(type, { strict: false })`). */
  resolve<T>(type: Type<T>): T;
  /** The data folder. */
  readonly dataDir: string;
  /** Stops the loop, the server, the client and the database. */
  close(): Promise<void>;
}

/** Brings the database up, seeds it, boots Nest on Fastify and listens on loopback. */
export async function startBareHost(options: StartOptions = {}): Promise<RunningBareHost> {
  const log = options.log ?? (() => {});
  const dataDir = resolve(options.dataDir ?? `${PROJECT_ROOT}/.data`);
  const database = await startDatabase(options.leg ?? ((process.env.BARE_HOST_DB as DbLeg | undefined) ?? 'service'), log);
  const prisma = createPrismaClient(database);

  let jobs: PgTableJobs | undefined;
  let app: NestFastifyApplication | undefined;
  try {
    const orgId = await seedDatabase(prisma);

    let baseUrl = '';
    const objectStore = new LocalFsObjectStore({ prisma, dataDir, orgId, baseUrl: () => baseUrl });
    jobs = new PgTableJobs(prisma, { dataDir, orgId });
    const notify = createRecordingKvoxNotify();
    const settings = new FileSettings(`${dataDir}/settings.json`);
    const secrets = new MemorySecrets();
    // THE `ai` SYSTEM NAMESPACE IS THE HOST'S TO DECLARE. The notes, transcripts (name check),
    // graph and Ask slices read it through the settings port and none of them declares it; in the
    // web edition it is the platform AI slice's. What they read:
    //   maxInputTokens, maxOutputTokens  the spend caps (null: the model's own limit governs)
    //   maxDocumentBytes                 the notes slice's uploaded-document ceiling
    //   graphEnabled                     the connected-knowledge switch (`GraphAiRunResolver`):
    //                                    absent or false, every graph AI route answers 409
    //                                    `graph_disabled` and the entity digest is never queued.
    //                                    Off by default, as in the web edition; `seedRuntime`
    //                                    turns it on the way an administrator would.
    //   reasoningEffort                  the graph's fallback when the model target names none
    settings.registerNamespace({
      scope: 'system',
      name: 'ai',
      schema: z.object({
        maxInputTokens: z.number().int().positive().nullable().default(null),
        maxOutputTokens: z.number().int().positive().nullable().default(null),
        maxDocumentBytes: z.number().int().positive().default(10 * 1024 * 1024),
        graphEnabled: z.boolean().default(false),
        reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).default('none'),
      }),
      defaults: {
        maxInputTokens: null,
        maxOutputTokens: null,
        maxDocumentBytes: 10 * 1024 * 1024,
        graphEnabled: false,
        reasoningEffort: 'none',
      },
    });
    // No embeddings model: search runs on full text and says why the vector arm is off, and the
    // graph resolves entities by name only (the `vector(1536)` columns stay null).
    const ai = createBareHostAi({ noteText: FAKE_NOTE_TEXT });
    const identity = new LocalSingleUserIdentity({
      userId: LOCAL_USER_ID,
      orgId,
      permissions: [
        ...TRANSCRIPTS_PERMISSIONS,
        ...NOTES_PERMISSIONS,
        ...NOTE_TEMPLATES_PERMISSIONS,
        ...GRAPH_PERMISSIONS,
        'system_settings:read',
        'system_settings:write',
      ].map((permission) => (typeof permission === 'string' ? permission : permission.id)),
    });

    app = await NestFactory.create<NestFastifyApplication>(
      createBareHostModule({
        objectStore,
        ports: {
          ai: { useValue: ai },
          objectStore: { useValue: objectStore },
          jobs: { useValue: jobs },
          identity: { useValue: identity },
          notify: { useValue: notify },
          settings: { useValue: settings },
          secrets: { useValue: secrets },
          prisma: { useValue: prisma as never },
        },
      }),
      new FastifyAdapter({ bodyLimit: 64 * 1024 * 1024 }),
      { logger: ['error', 'warn'] },
    );

    // The API under /api; the signed-URL endpoints of the object store at the origin.
    app.setGlobalPrefix('api', { exclude: ['local-store/*path'] });
    // Upload parts arrive with the file's own content type (audio/mpeg, ...): hand the bytes through.
    app.getHttpAdapter().getInstance().addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    // MULTIPART IS THE HOST'S PLUGIN. `POST /api/graph/imports` (graph-rdf) and the notes slice's
    // document sources read `request.file()`, the decoration `@fastify/multipart` adds; no slice
    // registers it (or lists it as a peer). Without it the import route fails on
    // `request.isMultipart`. One file per request; the slices bound each read themselves (the
    // import at `maxImportBytes`, 20 MiB). Fastify prefers this specific parser to the `*` above.
    await app.register(multipart, { limits: { fileSize: 64 * 1024 * 1024, files: 1 } });

    await app.listen(options.port ?? 0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    log(`bare host listening on ${baseUrl}`);

    await seedRuntime(settings, secrets);
    const housekeeping = new HostHousekeeping(app, undefined, log);
    if (options.backgroundJobs !== false) {
      jobs.start();
      housekeeping.start();
    }

    const running = { jobs, app, prisma, database, housekeeping };
    return {
      baseUrl,
      app,
      prisma,
      database,
      jobs,
      objectStore,
      identity,
      notify,
      ai,
      housekeeping,
      dataDir,
      resolve: (type) => running.app.get(type, { strict: false }),
      async close() {
        await running.housekeeping.stop();
        await running.jobs.stop();
        await running.app.close();
        await running.prisma.$disconnect();
        await running.database.close();
      },
    };
  } catch (error) {
    await jobs?.stop().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

import 'reflect-metadata';

import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { createFakeKvoxAi, createRecordingKvoxNotify, type FakeKvoxAi, type RecordingKvoxNotify } from '@marinoscar/kvox-api/testing';

import { createBareHostModule } from './app.module.js';
import { PROJECT_ROOT, createPrismaClient, startDatabase, type BareHostDatabase, type DbLeg } from './db.js';
import { FileSettings } from './ports/file-settings.js';
import { LocalFsObjectStore } from './ports/local-fs-object-store.js';
import { LocalSingleUserIdentity } from './ports/local-single-user-identity.js';
import { MemorySecrets } from './ports/memory-secrets.js';
import { PgTableJobs } from './ports/pg-table-jobs.js';
import { LOCAL_USER_ID, seedDatabase, seedRuntime } from './seed.js';
import {
  NOTES_PERMISSIONS,
  NOTE_TEMPLATES_PERMISSIONS,
  TRANSCRIPTS_PERMISSIONS,
} from './permissions.js';

// =============================================================================
// Starting the bare host
// =============================================================================
//
// `main.ts` calls this, and so does the end-to-end test: the same wiring, with the
// background job loop on for `main.ts` and off for the test (which drains the
// queue itself, so every step is deterministic).
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
  /** Run the 200 ms background job loop (default true). */
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
  readonly notify: RecordingKvoxNotify;
  readonly ai: FakeKvoxAi;
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
    // THE `ai` SYSTEM NAMESPACE IS THE HOST'S TO DECLARE. The notes, transcripts (name check) and
    // graph slices read the deployment's AI spend caps from it through the settings port
    // (`ai.maxInputTokens`, `ai.maxOutputTokens`, `ai.maxDocumentBytes`); in the web edition it is
    // the platform AI slice's. A null cap means "the model's own limit governs".
    settings.registerNamespace({
      scope: 'system',
      name: 'ai',
      schema: z.object({
        maxInputTokens: z.number().int().positive().nullable().default(null),
        maxOutputTokens: z.number().int().positive().nullable().default(null),
        maxDocumentBytes: z.number().int().positive().default(10 * 1024 * 1024),
      }),
      defaults: { maxInputTokens: null, maxOutputTokens: null, maxDocumentBytes: 10 * 1024 * 1024 },
    });
    // No embeddings model: search runs on full text and says why the vector arm is off.
    const ai = createFakeKvoxAi({ script: { text: FAKE_NOTE_TEXT, capabilities: { embeddings: null } } });
    const identity = new LocalSingleUserIdentity({
      userId: LOCAL_USER_ID,
      orgId,
      permissions: [
        ...TRANSCRIPTS_PERMISSIONS,
        ...NOTES_PERMISSIONS,
        ...NOTE_TEMPLATES_PERMISSIONS,
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

    await app.listen(options.port ?? 0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    log(`bare host listening on ${baseUrl}`);

    await seedRuntime(settings, secrets);
    if (options.backgroundJobs !== false) jobs.start();

    const running = { jobs, app, prisma, database };
    return {
      baseUrl,
      app,
      prisma,
      database,
      jobs,
      objectStore,
      notify,
      ai,
      dataDir,
      async close() {
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

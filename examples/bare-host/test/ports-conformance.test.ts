import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z as Zod } from 'zod';

import type { KvoxPortsUnderTest } from '@marinoscar/kvox-api/testing';

import type { RunningBareHost } from '../src/bootstrap.js';

// =============================================================================
// The shared ports conformance kit, run against the bare host's own ports
// =============================================================================
//
// `describeKvoxPortsConformance` is the executable definition of a correct port
// binding: the package fakes pass it, the web edition's adapters pass it, and
// KVox Desktop will run it against its own. This host is the reference Desktop
// starts from, so it runs the kit too, on the same database leg as the other
// tests (`npm test -- --db service|pglite`), against the very instances the
// application is wired with: the local-filesystem object store, the table-backed
// job runner, the single-user identity, the JSON-file settings and the in-memory
// secrets.
//
// THE UPLOAD RULE SENDS ITS BYTES. This store, like S3, refuses to seal an upload whose
// parts never arrived (`Part 1 of 1 has not been uploaded`), so the factory's `uploadParts`
// hook PUTs them to the signed part URLs first. The kit used to complete an empty upload,
// which only an in-memory fake accepts; the hook is the kit's answer to this host.
//
// WHAT IS NOT RUN, AND WHY. `ai` and `notify` are the package fakes (they pass the
// kit in the package's own spec); `events` and `audit` are the defaults the host
// leaves unbound. Nothing local exists to hold to the rules.
//
// ONE HOST FOR ALL RULES. Booting the application per rule would cost minutes; the
// kit builds its ports "fresh" per call, which here means a new settings file and
// a new secrets map each time, and the shared object store and job table (the kit
// names its jobs and keys uniquely, and the object owner is the seeded local user,
// because every owner column is a foreign key to `users`).
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const load = createRequire(import.meta.url);
const { startBareHost } = load('../dist/bootstrap.js') as typeof import('../src/bootstrap.js');
const { LOCAL_USER_HEADER } = load('../dist/ports/local-single-user-identity.js') as typeof import('../src/ports/local-single-user-identity.js');
const { LOCAL_USER_ID } = load('../dist/seed.js') as typeof import('../src/seed.js');
const { FileSettings } = load('../dist/ports/file-settings.js') as typeof import('../src/ports/file-settings.js');
const { MemorySecrets } = load('../dist/ports/memory-secrets.js') as typeof import('../src/ports/memory-secrets.js');
const { describeKvoxPortsConformance, createFakeKvoxExecutionContext } = load('@marinoscar/kvox-api/testing') as typeof import('@marinoscar/kvox-api/testing');
const { z } = load('zod') as { z: typeof Zod };

let host: RunningBareHost;
let started: Promise<RunningBareHost> | undefined;
let sequence = 0;

beforeAll(async () => {
  started = startBareHost({ backgroundJobs: false, dataDir: join(here, '..', '.data', `conformance-${process.pid}`) });
  host = await started;
});

afterAll(async () => {
  await host?.close();
});

/** The ports under test: the host's own instances, with fresh settings and secrets per call. */
async function bareHostPorts(): Promise<KvoxPortsUnderTest> {
  const running = await started!;
  sequence += 1;
  return {
    objectStore: {
      port: running.objectStore,
      ownerId: LOCAL_USER_ID,
      // The store checks its parts at `completeUpload`, as S3 does, so the kit's upload goes through the signed part URLs.
      async uploadParts(init, size) {
        for (const part of init.parts) {
          const length = Math.min(init.partSize, size - (part.partNumber - 1) * init.partSize);
          const response = await fetch(part.url, { method: 'PUT', body: Buffer.alloc(Math.max(length, 0), part.partNumber) });
          if (!response.ok) throw new Error(`part ${part.partNumber} was refused with ${response.status}`);
        }
      },
    },
    jobs: { port: running.jobs, drain: () => running.jobs.drain() },
    identity: {
      port: running.identity,
      anonymous: createFakeKvoxExecutionContext(),
      authenticated: createFakeKvoxExecutionContext({ [LOCAL_USER_HEADER]: '1' }),
      permissions: { granted: 'transcripts:read', notGranted: 'conformance:not_granted' },
    },
    settings: {
      port: new FileSettings(join(running.dataDir, `settings-conformance-${sequence}.json`)),
      namespaces: [
        {
          scope: 'system',
          name: 'conformance_system',
          schema: z.object({ enabled: z.boolean(), label: z.string() }),
          defaults: { enabled: false, label: '' },
        },
        {
          scope: 'user',
          name: 'conformance_user',
          schema: z.object({ theme: z.string() }),
          defaults: { theme: 'light' },
        },
      ],
      system: { name: 'conformance_system', patch: { enabled: true, label: 'x' }, actorUserId: LOCAL_USER_ID },
      user: { name: 'conformance_user', userId: LOCAL_USER_ID, patch: { theme: 'dark' } },
    },
    secrets: { port: new MemorySecrets(), purpose: 'conformance', name: 'default', actorUserId: LOCAL_USER_ID },
  };
}

describeKvoxPortsConformance('bare host', bareHostPorts, { describe, it, expect }, { skip: ['ai', 'notify', 'events', 'audit'] });

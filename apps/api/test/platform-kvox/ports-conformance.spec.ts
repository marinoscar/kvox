// =============================================================================
// describeKvoxPortsConformance against the web edition's adapters (issue #490)
// =============================================================================
//
// The same kit `packages/kvox-api/test/ports-conformance.spec.ts` runs against the
// in-memory fakes, run against each adapter in `src/platform-kvox/`. What is real and
// what is a stand-in:
//
//   ai          the REAL binding (`createWebKvoxAi`: `createKvoxAi` of `@marinoscar/kvox-ai`
//               over the real `PlatformAiRuntime`, #579) over a scripted platform `AiService`
//               (`test/helpers/web-kvox-ai.helper.ts`), so the feature mapping, the error
//               translation (the package's and the runtime's) and the step handling are
//               exercised; the model mechanics have their own specs in `packages/kvox-ai`.
//   objectStore the REAL adapter over an in-memory `KvoxManagedObjects`, storage provider
//               and `ObjectsService`, with the REAL `ObjectProcessorRegistry`: completing an
//               upload runs the registered processors as the platform's job does.
//   jobs        the REAL adapter over the platform's `createFakeJobQueue`, its REAL
//               `JobHandlerRegistry` and a stand-in throttle.
//   identity    the REAL adapter, a stand-in `JwtAuthGuard` that attaches what the real one
//               does (`request.user`, `request.principal`), and the platform's real
//               `toRequestUser` / `principalFactory`.
//   notify, secrets, settings, audit, events
//               the REAL adapters over stand-ins for the platform services (in memory),
//               and the platform's REAL registries (`findEvent`, `credentialPurposeRegistry`,
//               the settings namespace registries filled by `kvox.manifest`).
//
// The AI jobs' `nodeResultSchema` refusal, the rate-limit translation and the other
// adapter-specific rules are pinned in `platform-kvox-adapters.spec.ts`.
// =============================================================================

import '../../src/kvox.manifest';

import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

import { UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { createFakeJobQueue } from '@marinoscar/platform-api/jobs/testing';
import { ObjectProcessorRegistry } from '@marinoscar/platform-api/storage';
import type { StorageObject } from '@marinoscar/platform-api/storage';
import {
  KVOX_AI_ERROR_CLASSES,
  type KvoxAiErrorClass,
} from '@marinoscar/kvox-api/ports';
import {
  createFakeKvoxExecutionContext,
  describeKvoxPortsConformance,
  type KvoxPortsUnderTest,
} from '@marinoscar/kvox-api/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JOB_SETTLED_EVENT, JobSettledEvent, RateLimitError } from '@marinoscar/platform-api/jobs';

import { AiError } from '@marinoscar/platform-api/ai';

import { KvoxAiConflict } from '../../src/ai-port/kvox-ai-errors';
import { createWebAiUnderTest } from '../helpers/web-kvox-ai.helper';
import { PlatformKvoxAuditAdapter } from '../../src/platform-kvox/audit/platform-kvox-audit.adapter';
import { PlatformKvoxEventsAdapter } from '../../src/platform-kvox/events/platform-kvox-events.adapter';
import { PlatformKvoxIdentityAdapter } from '../../src/platform-kvox/identity/platform-kvox-identity.adapter';
import { PlatformKvoxJobsAdapter } from '../../src/platform-kvox/jobs/platform-kvox-jobs.adapter';
import { PlatformKvoxNotifyAdapter } from '../../src/platform-kvox/notify/platform-kvox-notify.adapter';
import { PlatformKvoxObjectStoreAdapter } from '../../src/platform-kvox/object-store/platform-kvox-object-store.adapter';
import { PlatformKvoxSecretsAdapter } from '../../src/platform-kvox/secrets/platform-kvox-secrets.adapter';
import { PlatformKvoxSettingsAdapter } from '../../src/platform-kvox/settings/platform-kvox-settings.adapter';
import { InProcessEventBus } from '@marinoscar/platform-api/host';

// -- ai ----------------------------------------------------------------------

/**
 * What the platform `AiService` (or the target resolver under it) throws for each port error
 * class, on a route (the kit's default context has no job). The auth one carries a key-shaped
 * string on purpose. `null`: a text, chat or embeddings round trip of the web edition cannot
 * produce the class, and why.
 */
const PLATFORM_FAILURES: Record<KvoxAiErrorClass, (() => unknown) | { cannot: string }> = {
  auth: () => new KvoxAiConflict('ai_key_invalid', 'The provider rejected the key sk-abcdefghij1234567890 for this user.'),
  refusal: () => new AiError('AI_CONTENT_FILTERED', 'The provider declined to answer.'),
  rate_limit: () => new AiError('AI_RATE_LIMITED', 'Rate limited', { retryAfterMs: 1500 }),
  budget: { cannot: 'a budget refusal is the caller\'s pre-flight check (computeTokenBudget), never a provider answer' },
  timeout: () => new DOMException('The provider call outlived its deadline.', 'TimeoutError'),
  not_configured: () => new AiError('AI_DISABLED', 'AI is switched off.'),
  key_missing: () => new AiError('AI_KEY_REQUIRED', 'No key may pay for this call.'),
  capability: () => new AiError('AI_MODEL_NOT_ENABLED', 'The model is not enabled.'),
  truncated: { cannot: 'only a structured call that set an output ceiling reads truncation (proved in packages/kvox-ai)' },
  invalid_output: { cannot: 'only a structured call or a job reads an unusable structured answer (proved in packages/kvox-ai)' },
  other: () => new AiError('AI_PROVIDER_UNAVAILABLE', 'The provider is having a bad day.'),
};

function aiUnderTest(): KvoxPortsUnderTest['ai'] {
  const web = createWebAiUnderTest();

  return {
    port: web.port,
    structured: { schema: z.object({ ok: z.boolean() }), schemaName: 'conformance' },
    failNextWith(errorClass) {
      const failure = PLATFORM_FAILURES[errorClass];
      if (typeof failure !== 'function') return false;
      web.arm(failure());
      return true;
    },
    arrangeTextAfterToolCall() {
      web.script([
        { type: 'output_text.delta', delta: 'Let me look.' },
        { type: 'output_item.done', item: { type: 'function_call', callId: 'call-1', name: 'lookup', arguments: '{}' } },
        { type: 'output_text.delta', delta: 'Text after the call.' },
        {
          type: 'response.completed',
          response: { id: 'r', provider: 'openai', model: 'gpt-4o', output: [], outputText: '', usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'tool_calls' },
        },
      ]);
    },
  };
}

// -- objectStore -------------------------------------------------------------

interface Row extends Record<string, unknown> {
  id: string;
  name: string;
  size: bigint;
  mimeType: string;
  storageKey: string;
  status: string;
  s3UploadId: string | null;
  uploadedById: string | null;
  orgId: string;
}

function objectStoreUnderTest(): KvoxPortsUnderTest['objectStore'] {
  const rows = new Map<string, Row>();
  const owners = new Map<string, 'transcripts' | 'notes' | 'graph'>();
  const blobs = new Map<string, Buffer>();
  const registry = new ObjectProcessorRegistry();

  const storage = {
    kind: 'memory',
    getBucket: () => 'memory',
    async upload(key: string, stream: Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      blobs.set(key, Buffer.concat(chunks));
      return { key, bucket: 'memory', location: key };
    },
    async download(key: string) {
      return Readable.from([blobs.get(key) ?? Buffer.alloc(0)]);
    },
    async delete(key: string) {
      blobs.delete(key);
    },
    async getSignedUploadUrl(key: string, uploadId: string, partNumber: number) {
      return `https://upload.example/${key}?u=${uploadId}&p=${partNumber}`;
    },
  };

  const abortListeners: Array<(event: { objectId: string; module: string | null }) => Promise<void>> = [];

  const managed = {
    async initManagedUpload(input: { module: 'transcripts' | 'notes' | 'graph'; userId: string; name: string; size: number; mimeType: string }) {
      const id = randomUUID();
      rows.set(id, {
        id,
        name: input.name,
        size: BigInt(input.size),
        mimeType: input.mimeType,
        storageKey: `uploads/${id}`,
        status: 'pending',
        s3UploadId: `upload-${id}`,
        uploadedById: input.userId,
        orgId: 'org-default',
      });
      owners.set(id, input.module);
      return {
        objectId: id,
        uploadId: `upload-${id}`,
        partSize: 5 * 1024 * 1024,
        totalParts: 1,
        presignedUrls: [{ partNumber: 1, url: `https://upload.example/${id}/1` }],
      };
    },
    async create(input: { module: 'transcripts' | 'notes' | 'graph'; key: string; mimeType: string; size: number; uploadedById: string; metadata?: Record<string, unknown> }) {
      const id = randomUUID();
      rows.set(id, {
        id,
        name: input.key,
        size: BigInt(input.size),
        mimeType: input.mimeType,
        storageKey: input.key,
        status: 'ready',
        s3UploadId: null,
        uploadedById: input.uploadedById,
        orgId: 'org-default',
        metadata: input.metadata ?? null,
      });
      owners.set(id, input.module);
      return rows.get(id)!;
    },
    async setMetadata(id: string, metadata: Record<string, unknown>) {
      const row = rows.get(id);
      if (row) row.metadata = metadata;
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
    async findByKey(key: string) {
      return [...rows.values()].find((row) => row.storageKey === key) ?? null;
    },
    async findMany(args: {
      where: { id?: { in: string[] }; kvoxOwnership?: { managedBy: string }; uploadedById?: string; storageKey?: { startsWith: string } };
      take?: number;
    }) {
      // `describe`: by id. `listManaged`: one module's files of one user under a key prefix, ascending by id.
      const { where } = args;
      const found = where.id
        ? where.id.in.flatMap((id) => {
            const row = rows.get(id);
            return row ? [{ ...row, createdAt: new Date(), updatedAt: new Date() }] : [];
          })
        : [...rows.values()]
            .filter((row) => owners.get(row.id as string) === where.kvoxOwnership?.managedBy)
            .filter((row) => row.uploadedById === where.uploadedById)
            .filter((row) => where.storageKey === undefined || String(row.storageKey).startsWith(where.storageKey.startsWith))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)))
            .slice(0, args.take);
      return found;
    },
    async managedBy(ids: readonly string[]) {
      return new Map(ids.filter((id) => owners.has(id)).map((id) => [id, owners.get(id)!] as const));
    },
    async openStream(id: string) {
      const row = rows.get(id);
      return row ? { stream: await storage.download(row.storageKey), object: row } : null;
    },
    async signedDownloadUrl(id: string, options: { expiresIn: number; contentDisposition?: string }) {
      const row = rows.get(id);
      return row && row.status === 'ready' ? { url: `https://download.example/${id}?e=${options.expiresIn}`, expiresAt: new Date(), object: row } : null;
    },
    async deleteManaged(id: string) {
      const row = rows.get(id);
      if (row) blobs.delete(row.storageKey);
      rows.delete(id);
      owners.delete(id);
    },
    async abortManaged(id: string) {
      const row = rows.get(id);
      if (row && row.status === 'pending') {
        row.status = 'failed';
        row.s3UploadId = null;
        for (const listener of abortListeners) await listener({ objectId: id, module: owners.get(id) ?? null });
      }
    },
    onAborted(listener: (event: { objectId: string; module: string | null }) => Promise<void>) {
      abortListeners.push(listener);
    },
  };

  // The platform completes an upload, then runs every registered processor in a job.
  const objects = {
    async completeUpload(id: string) {
      const row = rows.get(id)!;
      row.status = 'ready';
      for (const processor of registry.list()) {
        const asObject = row as unknown as StorageObject;
        if (processor.canProcess(asObject)) await processor.process(asObject, async () => Readable.from([]));
      }
    },
    async delete(id: string) {
      rows.delete(id);
    },
  };

  const lister = { listParts: async () => [{ partNumber: 1, etag: 'etag-1', size: 1 }] };

  return {
    port: new PlatformKvoxObjectStoreAdapter(managed as never, objects as never, lister as never, registry, storage as never),
  };
}

// -- jobs --------------------------------------------------------------------

function jobsUnderTest(): KvoxPortsUnderTest['jobs'] {
  const queue = createFakeJobQueue();
  const registerProviderKey = jest.fn();
  const events = new EventEmitter2();

  type JobWhere = {
    type?: { in: string[] };
    status?: { in: string[] };
    id?: { not: string };
    OR?: Array<{ subjectType?: string; subjectId?: { in: string[] }; payload?: { path: string[]; equals: unknown } }>;
  };

  const prisma = {
    organization: { findFirst: async () => ({ id: 'org-default' }) },
    job: {
      findFirst: async ({ where }: { where: { dedupKey?: string; type?: string; subjectType?: string; subjectId?: string } }) => {
        // `findLatest`: the newest job of a subject, whatever its status.
        if (where.dedupKey === undefined) {
          return (
            queue
              .jobs()
              .filter((job) => job.type === where.type && job.subjectType === where.subjectType && (where.subjectId === undefined || job.subjectId === where.subjectId))
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
          );
        }
        return queue.jobs().find((job) => job.dedupKey === where.dedupKey && (job.status === 'pending' || job.status === 'running')) ?? null;
      },
      // `runNow`: a pending job scheduled for later is pulled forward.
      updateMany: async ({ where, data }: { where: { id: string }; data: { scheduledFor: null } }) => {
        const job = queue.get(where.id);
        if (!job || job.status !== 'pending' || job.scheduledFor === null || job.scheduledFor.getTime() <= Date.now()) return { count: 0 };
        job.scheduledFor = data.scheduledFor;
        return { count: 1 };
      },
      // The adapter's `findActive` query, evaluated over the fake queue's rows.
      findMany: async ({ where }: { where: JobWhere }) =>
        queue.jobs().filter((job) => {
          if (where.type && !where.type.in.includes(job.type)) return false;
          if (where.status && !where.status.in.includes(job.status)) return false;
          if (where.id && job.id === where.id.not) return false;
          if (where.OR) {
            return where.OR.some((match) => {
              if (match.subjectId) {
                return (!match.subjectType || job.subjectType === match.subjectType) && match.subjectId.in.includes(job.subjectId as string);
              }
              if (match.payload) {
                return (job.payload as Record<string, unknown> | null)?.[match.payload.path[0]] === match.payload.equals;
              }
              return false;
            });
          }
          return true;
        }),
    },
  };
  const port = new PlatformKvoxJobsAdapter(
    queue.asJobsService(),
    queue.registry,
    { registerProviderKey } as never,
    prisma as never,
    events,
  );

  return {
    port,
    // A worker pass; the worker announces each job it settles on the shared emitter.
    drain: async () => {
      for (const run of await queue.drain()) {
        events.emit(JOB_SETTLED_EVENT, new JobSettledEvent(run.job));
      }
    },
  };
}

// -- identity ----------------------------------------------------------------

function identityUnderTest(): KvoxPortsUnderTest['identity'] {
  const user = {
    id: 'user-conformance',
    email: 'u@example.com',
    isActive: true,
    activeOrgId: 'org-default',
    userRoles: [],
    memberships: [
      {
        orgId: 'org-default',
        status: 'active',
        org: { id: 'org-default', isDefault: true },
        role: {
          name: 'contributor',
          rolePermissions: [{ permission: { name: 'things:read' } }],
        },
      },
    ],
  };
  // What the real JwtAuthGuard does on success; it throws a 401 with no credential.
  const jwt = {
    canActivate: async (context: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => {
      const request = context.switchToHttp().getRequest() as { headers: Record<string, string | undefined>; user?: unknown; principal?: unknown };
      if (!request.headers.authorization) throw new UnauthorizedException();
      request.user = user;
      request.principal = {
        kind: 'user',
        userId: user.id,
        email: user.email,
        credential: 'session',
        roles: ['contributor'],
        permissions: ['things:read'],
        activeOrgId: 'org-default',
      };
      return true;
    },
  };
  const prisma = { user: { findUnique: async () => user } };

  return {
    port: new PlatformKvoxIdentityAdapter(jwt as never, prisma as never),
    anonymous: createFakeKvoxExecutionContext(),
    authenticated: createFakeKvoxExecutionContext({ authorization: 'Bearer x' }),
    permissions: { granted: 'things:read', notGranted: 'things:write' },
  };
}

// -- settings, secrets, audit, events, notify ----------------------------------

function settingsUnderTest(): KvoxPortsUnderTest['settings'] {
  // `transcription` (system) and `graph` (user) are registered by `kvox.manifest` in the REAL
  // platform registries; the services behind them are in-memory stand-ins.
  const system = new Map<string, { value: Record<string, unknown>; version: number }>();
  const store = {
    async read(namespace: string) {
      const held = system.get(namespace) ?? { value: {}, version: 1 };
      return { value: held.value, version: held.version };
    },
    async patch(namespace: string, patch: Record<string, unknown>) {
      const held = system.get(namespace) ?? { value: {}, version: 1 };
      const next = { value: { ...held.value, ...patch }, version: held.version + 1 };
      system.set(namespace, next);
      return next;
    },
  };
  const user = new Map<string, Record<string, unknown>>();
  const users = {
    async getSettings(userId: string) {
      return { graph: user.get(userId) };
    },
    async patchSettings(userId: string, dto: { graph: Record<string, unknown> }) {
      const next = { ...(user.get(userId) ?? {}), ...dto.graph };
      user.set(userId, next);
      return { graph: next };
    },
  };

  return {
    port: new PlatformKvoxSettingsAdapter(store as never, users as never, { systemSettings: { findUnique: async () => null } } as never),
    namespaces: [
      { scope: 'system', name: 'transcription', schema: z.object({}), defaults: {} },
      { scope: 'user', name: 'graph', schema: z.object({}), defaults: {} },
    ],
    system: { name: 'transcription', patch: { enabled: true, label: 'x' }, actorUserId: 'user-conformance' },
    user: { name: 'graph', userId: 'user-conformance', patch: { mode: 'dark' } },
    // The real per-user `graph` namespace is declared with `defaults: undefined` (absent means the slice's own).
    noDefaults: { name: 'graph', schema: z.object({ mode: z.string() }), userId: 'user-conformance-fresh', patch: { mode: 'dark' } },
  };
}

function secretsUnderTest(): KvoxPortsUnderTest['secrets'] {
  const held = new Map<string, { value: string; updatedAt: Date }>();
  const credentials = {
    async getSecret(purpose: string, name: string) {
      return held.get(`${purpose}/${name}`)?.value ?? null;
    },
    async setSecret(purpose: string, name: string, value: string) {
      held.set(`${purpose}/${name}`, { value, updatedAt: new Date() });
    },
    async deleteSecret(purpose: string, name: string) {
      held.delete(`${purpose}/${name}`);
    },
    async describe(purpose: string, name: string) {
      const entry = held.get(`${purpose}/${name}`);
      return entry ? { purpose, name, hint: '…7890', label: null, updatedByUserId: null, createdAt: entry.updatedAt, updatedAt: entry.updatedAt } : null;
    },
  };

  return {
    port: new PlatformKvoxSecretsAdapter(credentials as never),
    purpose: `kvox_conformance_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
    name: 'default',
    actorUserId: 'user-conformance',
  };
}

async function build(): Promise<KvoxPortsUnderTest> {
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const sink = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    ai: aiUnderTest(),
    objectStore: objectStoreUnderTest(),
    jobs: jobsUnderTest(),
    identity: identityUnderTest(),
    notify: { port: new PlatformKvoxNotifyAdapter(notifications as never) },
    events: { port: new PlatformKvoxEventsAdapter(new InProcessEventBus()) },
    settings: settingsUnderTest(),
    secrets: secretsUnderTest(),
    audit: { port: new PlatformKvoxAuditAdapter(sink as never) },
  };
}

describeKvoxPortsConformance('web edition adapters', build, { describe, it, expect });

describe('the adapters cover every port error class', () => {
  it('has a platform failure (or a reason it cannot happen) for each class the kit knows', () => {
    expect(Object.keys(PLATFORM_FAILURES).sort()).toEqual([...KVOX_AI_ERROR_CLASSES].sort());
  });

  it.each(
    (Object.entries(PLATFORM_FAILURES) as Array<[KvoxAiErrorClass, (() => unknown) | { cannot: string }]>).filter(
      (entry): entry is [KvoxAiErrorClass, () => unknown] => typeof entry[1] === 'function',
    ),
  )('a platform failure meant as %s surfaces as exactly that class, with no key in it', async (errorClass, failure) => {
    const web = createWebAiUnderTest();
    const ctx = { userId: 'user-conformance', orgId: null, feature: 'notes.generate' };
    const target = await web.port.resolveTask(ctx, 'notes.generate');
    web.arm(failure());

    const error = await (async () => {
      try {
        for await (const event of web.port.generateText(ctx, { target, system: 's', user: 'u' })) void event;
      } catch (caught) {
        return caught as { errorClass?: string; message: string };
      }
      throw new Error('expected a failure');
    })();

    expect(error.errorClass).toBe(errorClass);
    expect(error.message).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });
});

// =============================================================================
// describeKvoxPortsConformance against the web edition's adapters (issue #490)
// =============================================================================
//
// The same kit `packages/kvox-api/test/ports-conformance.spec.ts` runs against the
// in-memory fakes, run against each adapter in `src/platform-kvox/`. What is real and
// what is a stand-in:
//
//   ai          the REAL adapter over `FakeKvoxAi` (the app's scripted `KvoxAi`), so the
//               feature mapping, the error translation and the step handling are exercised;
//               the facade's own model calls have their own specs (`platform-kvox-ai.spec.ts`).
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
import { RateLimitError } from '@marinoscar/platform-api/jobs';

import { AiAuthError, AiBudgetError, AiRefusedError } from '../../src/ai-port/ai-errors';
import { keyMissingConflict, lacksCapabilityConflict, notConfiguredConflict } from '../../src/ai-port/kvox-ai-errors';
import { FakeKvoxAi } from '../../src/ai-port/testing/fake-kvox-ai';
import { PlatformKvoxAiAdapter } from '../../src/platform-kvox/ai/platform-kvox-ai.adapter';
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

/** A `FakeKvoxAi` whose NEXT stream, chat or embed call fails with the armed error. */
class ArmedFacade extends FakeKvoxAi {
  armed: unknown = null;

  private take(): unknown {
    const error = this.armed;
    this.armed = null;
    return error;
  }

  override streamText(req: Parameters<FakeKvoxAi['streamText']>[0]) {
    const error = this.take();
    if (error === null) return super.streamText(req);
    return (async function* () {
      throw error;
    })();
  }

  override chat(req: Parameters<FakeKvoxAi['chat']>[0]) {
    const error = this.take();
    if (error === null) return super.chat(req);
    return (async function* () {
      throw error;
    })();
  }

  override async embed(req: Parameters<FakeKvoxAi['embed']>[0]) {
    const error = this.take();
    if (error !== null) throw error;
    return super.embed(req);
  }
}

/** What the facade throws for each port error class (the auth one carries a key-shaped string on purpose). */
const FACADE_FAILURES: Record<KvoxAiErrorClass, () => unknown> = {
  auth: () => new AiAuthError('The provider rejected the key sk-abcdefghij1234567890 for this user.'),
  refusal: () => new AiRefusedError('The provider declined to answer.'),
  rate_limit: () => new RateLimitError('Rate limited', 1500),
  budget: () => new AiBudgetError('Too large', 14_200, 11_500, 'openai'),
  timeout: () => new Error('The AI request timed out after 600000 ms.'),
  not_configured: () => notConfiguredConflict(),
  key_missing: () => keyMissingConflict(),
  capability: () => lacksCapabilityConflict({ task: 'graph.extract', model: 'm', missing: ['structured output'] }),
  other: () => new Error('The provider is having a bad day.'),
};

function aiUnderTest(): KvoxPortsUnderTest['ai'] {
  const facade = new ArmedFacade();
  facade.setStructuredHandler(() => ({ ok: true }));
  const adapter = new PlatformKvoxAiAdapter(facade, { graphEnabled: async () => true } as never);

  return {
    port: adapter,
    structured: { schema: z.object({ ok: z.boolean() }), schemaName: 'conformance' },
    failNextWith(errorClass) {
      facade.armed = FACADE_FAILURES[errorClass]();
      return true;
    },
    arrangeTextAfterToolCall() {
      facade.queueChat([
        { kind: 'delta', text: 'Let me look.' },
        { kind: 'tool_call', id: 'call-1', name: 'lookup', argumentsJson: '{}' },
        { kind: 'delta', text: 'Text after the call.' },
        { kind: 'done', finishReason: 'tool_calls', model: 'gpt-4o', usage: { inputTokens: 1, outputTokens: 1 } },
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
    async create(input: { module: 'transcripts' | 'notes' | 'graph'; key: string; mimeType: string; size: number; uploadedById: string }) {
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
      });
      owners.set(id, input.module);
      return rows.get(id)!;
    },
    async get(id: string) {
      return rows.get(id) ?? null;
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
      }
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
  const prisma = {
    organization: { findFirst: async () => ({ id: 'org-default' }) },
    job: {
      findFirst: async ({ where }: { where: { dedupKey: string } }) =>
        queue.jobs().find((job) => job.dedupKey === where.dedupKey && (job.status === 'pending' || job.status === 'running')) ?? null,
    },
  };
  const port = new PlatformKvoxJobsAdapter(
    queue.asJobsService(),
    queue.registry,
    { registerProviderKey } as never,
    prisma as never,
  );

  return { port, drain: async () => void (await queue.drain()) };
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
  it('has a facade failure for each class the kit knows', () => {
    expect(Object.keys(FACADE_FAILURES).sort()).toEqual([...KVOX_AI_ERROR_CLASSES].sort());
  });
});

// =============================================================================
// The web-edition adapters' own rules (issue #490, epic #486)
// =============================================================================
//
// `ports-conformance.spec.ts` proves each adapter satisfies the shared kit. This file
// pins what only the web edition has to get right: how `KVOX_AI` is bound (the
// translation of the host's AI errors and the runtime's call shape are
// `test/ai/platform-ai-runtime.spec.ts`; the port's own rules moved to
// `packages/kvox-ai` with `createKvoxAi`, #579), the refusal of a node-eligible AI job,
// the rate-limit and throttle plumbing,
// the object-store cleanup rules, the identity trap, the detached notify, and the boot
// failure when a port is left unbound.
// =============================================================================

import { EventEmitter2 } from '@nestjs/event-emitter';
import '../../src/kvox.manifest';
// Registers this app's notification events and email templates (the app imports it from the notifications config).
import '../../src/platform/notifications/notification.manifest';

import { Readable } from 'node:stream';

import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';

import { credentialPurposeRegistry } from '@marinoscar/platform-api/credentials';
import { RateLimitError } from '@marinoscar/platform-api/jobs';
import { createFakeJobQueue } from '@marinoscar/platform-api/jobs/testing';
import { findEvent } from '@marinoscar/platform-api/notifications';
import { KVOX_AI, KVOX_AUDIT, KVOX_EVENTS, KVOX_IDENTITY, KVOX_JOBS, KVOX_NOTIFY, KVOX_OBJECT_STORE, KVOX_PRISMA, KVOX_SECRETS, KVOX_SETTINGS, KvoxRateLimitError } from '@marinoscar/kvox-api/ports';
import { createFakeKvoxExecutionContext } from '@marinoscar/kvox-api/testing';

import { AiReadinessService } from '../../src/ai-port/ai-readiness.service';
import { KvoxAiSettings } from '../../src/ai-port/kvox-ai-settings';
import { PlatformAiRuntime } from '../../src/ai-port/platform-ai-runtime';
import { PlatformTaskModelSource } from '../../src/ai-port/platform-task-model-source';
import { TracedKvoxAiPort } from '../../src/platform-kvox/ai/traced-kvox-ai-port';
import { PlatformKvoxAuditAdapter } from '../../src/platform-kvox/audit/platform-kvox-audit.adapter';
import { PlatformKvoxEventsAdapter } from '../../src/platform-kvox/events/platform-kvox-events.adapter';
import { PlatformKvoxIdentityAdapter } from '../../src/platform-kvox/identity/platform-kvox-identity.adapter';
import { KVOX_AI_JOB_TYPES, PlatformKvoxJobsAdapter } from '../../src/platform-kvox/jobs/platform-kvox-jobs.adapter';
import { PlatformKvoxNotifyAdapter } from '../../src/platform-kvox/notify/platform-kvox-notify.adapter';
import { PlatformKvoxObjectStoreAdapter } from '../../src/platform-kvox/object-store/platform-kvox-object-store.adapter';
import { createPlatformKvoxModule, platformKvoxPorts } from '../../src/platform-kvox/platform-kvox.module';
import { PlatformKvoxSecretsAdapter } from '../../src/platform-kvox/secrets/platform-kvox-secrets.adapter';
import { PlatformKvoxSettingsAdapter } from '../../src/platform-kvox/settings/platform-kvox-settings.adapter';

const CTX = { userId: 'user-1', orgId: null, feature: 'notes.generate' as const };

// -----------------------------------------------------------------------------
describe('AI binding', () => {
  // The rules the retired `PlatformKvoxAiAdapter` pinned here (the feature vocabulary, the
  // refusal of an unknown feature, resolveTask's reasons and numbers, capabilities() never
  // throwing, the chat step rule, the embeddings width) moved to
  // `packages/kvox-ai/src/port/create-kvox-ai.port.spec.ts` with the code; the translation of
  // the host's own errors is `test/ai/platform-ai-runtime.spec.ts`.

  it('binds KVOX_AI with a factory over the runtime, the shared task-model source, the readiness reader and the settings', () => {
    const binding = platformKvoxPorts.ai as { useFactory: (...deps: unknown[]) => unknown; inject: unknown[] };

    expect(binding.inject).toEqual([PlatformAiRuntime, PlatformTaskModelSource, AiReadinessService, KvoxAiSettings]);

    const port = binding.useFactory(
      { stream: jest.fn(), create: jest.fn(), readiness: jest.fn() },
      { load: jest.fn() },
      { readiness: jest.fn() },
      { requestTimeoutMs: jest.fn(), graphEnabled: jest.fn() },
    );
    expect(port).toBeInstanceOf(TracedKvoxAiPort);
  });

  it('keeps the spans of the retired adapter under their former names, and leaves the generators untraced', async () => {
    const inner = {
      capabilities: jest.fn(async () => ({ available: true })),
      resolveTask: jest.fn(async () => ({ model: 'm' })),
      generateStructured: jest.fn(async () => ({ value: 1 })),
      embed: jest.fn(async () => ({ vectors: [] })),
      generateText: jest.fn(() => 'text-iterable'),
      chat: jest.fn(() => 'chat-iterable'),
      countTokens: jest.fn(() => 7),
    };
    const port = new TracedKvoxAiPort(inner as never);

    await expect(port.capabilities(CTX)).resolves.toEqual({ available: true });
    await expect(port.resolveTask(CTX, 'notes.generate')).resolves.toEqual({ model: 'm' });
    await expect(port.generateStructured(CTX, {} as never)).resolves.toEqual({ value: 1 });
    await expect(port.embed(CTX, { inputs: [] })).resolves.toEqual({ vectors: [] });
    // Returned as they are: a Promise here would break `for await`.
    expect(port.generateText(CTX, {} as never)).toBe('text-iterable');
    expect(port.chat(CTX, {} as never)).toBe('chat-iterable');
    expect(port.countTokens({} as never, 'x')).toBe(7);
  });
});

// -----------------------------------------------------------------------------
describe('jobs adapter', () => {
  function build(overrides: { dedupHit?: boolean } = {}) {
    const queue = createFakeJobQueue();
    const jobs = queue.asJobsService();
    const enqueue = jest.spyOn(jobs, 'enqueue');
    const recordProvider = jest.spyOn(jobs, 'recordProvider');
    const registerProviderKey = jest.fn();
    const prisma = {
      organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org-default' }) },
      job: { findFirst: jest.fn().mockResolvedValue(overrides.dedupHit ? { id: 'existing' } : null) },
    };
    const adapter = new PlatformKvoxJobsAdapter(jobs, queue.registry, { registerProviderKey } as never, prisma as never, new EventEmitter2());

    return { queue, adapter, enqueue, recordProvider, registerProviderKey, prisma };
  }

  it('passes the default organization explicitly, a default reason, and null for absent fields', async () => {
    const { adapter, enqueue, prisma } = build();

    await adapter.enqueue({ type: 'x.y', payload: { a: 1 } });
    await adapter.enqueue({ type: 'x.y', subjectType: 's', subjectId: '2', payload: {}, reason: 'rerun', priority: 3 });

    expect(enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'x.y', reason: 'upload', orgId: 'org-default', subjectType: null, subjectId: null, skipDedup: false }));
    expect(enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ reason: 'rerun', priority: 3, subjectId: '2' }));
    expect(prisma.organization.findFirst).toHaveBeenCalledTimes(1);
  });

  it('records the throttle key on the job row', async () => {
    const { adapter, recordProvider } = build();

    const { id } = await adapter.enqueue({ type: 'x.y', payload: {}, throttleKey: 'ai-provider:user-1' });

    expect(recordProvider).toHaveBeenCalledWith(id, 'ai-provider:user-1', null);
  });

  it('reports a job that was already queued as deduplicated', async () => {
    const { adapter, queue } = build({ dedupHit: true });
    const first = await queue.enqueue({ type: 'x.y', reason: 'upload', subjectType: null, subjectId: null });
    const found = (adapter as unknown as { prisma: { job: { findFirst: jest.Mock } } }).prisma.job.findFirst;
    found.mockResolvedValue({ id: first.id });

    expect(await adapter.enqueue({ type: 'x.y', payload: {} })).toEqual({ id: first.id, deduplicated: true });
  });

  it('registers the same type, label and profile, and runs the handler with the port view of the job', async () => {
    const { adapter, queue } = build();
    const seen: unknown[] = [];
    adapter.registerHandler({
      type: 'kvox.test.view',
      label: 'View',
      profile: { maxRuntimeMs: 1000, maxAttempts: 2 },
      async process(job) {
        seen.push(job);
      },
    });

    expect(queue.registry.get('kvox.test.view')).toMatchObject({ type: 'kvox.test.view', label: 'View', profile: { maxRuntimeMs: 1000, maxAttempts: 2 } });
    await adapter.enqueue({ type: 'kvox.test.view', subjectType: 's', subjectId: '1', payload: { a: 1 } });
    await queue.drain();

    expect(seen).toEqual([expect.objectContaining({ type: 'kvox.test.view', subjectType: 's', subjectId: '1', payload: { a: 1 }, attempts: 1 })]);
  });

  it('turns KvoxRateLimitError into the platform RateLimitError the queue defers on', async () => {
    const { adapter, queue, registerProviderKey } = build();
    adapter.registerHandler({
      type: 'kvox.test.limited',
      async process() {
        throw new KvoxRateLimitError('ai-provider:user-1', 4000);
      },
    });
    const handler = queue.registry.get('kvox.test.limited')!;

    const error = await handler.process({ id: 'j', type: 'kvox.test.limited', payload: {}, attempts: 1, providerKey: null } as never).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(4000);
    expect(registerProviderKey).toHaveBeenCalledWith('kvox.test.limited', 'ai-provider:user-1');
  });

  it('registers the job row throttle bucket before the handler runs, per job', async () => {
    const { adapter, queue, registerProviderKey } = build();
    const order: string[] = [];
    registerProviderKey.mockImplementation(() => order.push('register'));
    adapter.registerHandler({ type: 'kvox.test.bucket', async process() { order.push('process'); } });

    await queue.registry.get('kvox.test.bucket')!.process({ id: 'j', type: 'kvox.test.bucket', payload: {}, attempts: 1, providerKey: 'ai-provider:u' } as never);

    expect(order).toEqual(['register', 'process']);
    expect(registerProviderKey).toHaveBeenCalledWith('kvox.test.bucket', 'ai-provider:u');
  });

  it('refuses an AI job that is node-eligible', () => {
    const { adapter } = build();
    const nodeParts = { nodeResultSchema: z.object({}), async persistNodeResult() {} };

    for (const type of KVOX_AI_JOB_TYPES) {
      expect(() => adapter.registerHandler({ type, async process() {}, ...nodeParts })).toThrow(/server-only/);
    }
    expect(() => adapter.registerHandler({ type: 'kvox.test.flagged', usesAi: true, async process() {}, ...nodeParts })).toThrow(/server-only/);
    expect(adapter.isRegistered('note.generate')).toBe(false);
  });

  it('accepts a non-AI node-eligible job and refuses half a node contract', () => {
    const { adapter } = build();

    adapter.registerHandler({ type: 'kvox.test.node', async process() {}, nodeResultSchema: z.object({}), async persistNodeResult() {} });
    expect(adapter.isRegistered('kvox.test.node')).toBe(true);
    expect(() => adapter.registerHandler({ type: 'kvox.test.half', async process() {}, nodeResultSchema: z.object({}) })).toThrow(/together/);
  });

  it('pins the AI job type strings (they are permanent)', () => {
    expect([...KVOX_AI_JOB_TYPES].sort()).toEqual(
      ['ask.respond', 'kg.embed', 'kg.entity_digest', 'kg.extract', 'kg.import', 'kg.resolve', 'note.generate', 'note.import.format', 'note.retitle', 'search.index', 'transcript.name_check'],
    );
  });
});

// -----------------------------------------------------------------------------
describe('object store adapter', () => {
  function build() {
    const storage = {
      upload: jest.fn(async (key: string, stream: Readable, _options: Record<string, unknown>) => {
        for await (const chunk of stream) void chunk;
        return { key, bucket: 'b', location: key };
      }),
      delete: jest.fn().mockResolvedValue(undefined),
      getSignedUploadUrl: jest.fn(async (_k: string, _u: string, n: number) => `https://u/${n}`),
    };
    const managed = {
      create: jest.fn(),
      findByKey: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      get: jest.fn(),
      managedBy: jest.fn(),
      deleteManaged: jest.fn(),
      abortManaged: jest.fn(),
      signedDownloadUrl: jest.fn(),
    };
    const objects = { completeUpload: jest.fn(), delete: jest.fn() };
    const lister = { listParts: jest.fn().mockResolvedValue([{ partNumber: 1, etag: 'e1', size: 1 }]) };
    const registry = { register: jest.fn() };
    const adapter = new PlatformKvoxObjectStoreAdapter(managed as never, objects as never, lister as never, registry as never, storage as never);

    return { adapter, storage, managed, objects, lister, registry };
  }

  it('counts a streamed put without collecting it, and stamps the owning module', async () => {
    const { adapter, managed, storage } = build();
    managed.create.mockResolvedValue({ id: 'obj-1' });
    const chunks = [Buffer.alloc(1000), Buffer.alloc(500)];

    const result = await adapter.put({ ownerId: 'u', key: 'k/1', body: Readable.from(chunks), contentType: 'audio/mp4', managedBy: 'transcripts' });

    expect(result).toEqual({ objectId: 'obj-1', size: 1500 });
    expect(managed.create).toHaveBeenCalledWith({ module: 'transcripts', key: 'k/1', mimeType: 'audio/mp4', size: 1500, uploadedById: 'u' });
    expect(storage.upload.mock.calls[0]?.[2]).toEqual({ mimeType: 'audio/mp4' });
  });

  it('gives a buffer its content length', async () => {
    const { adapter, managed, storage } = build();
    managed.create.mockResolvedValue({ id: 'obj-1' });

    await adapter.put({ ownerId: 'u', key: 'k', body: Buffer.from('abc'), contentType: 'text/plain', managedBy: 'notes' });

    expect(storage.upload.mock.calls[0]?.[2]).toEqual({ mimeType: 'text/plain', contentLength: 3 });
  });

  it('takes the bytes back when the row cannot be written', async () => {
    const { adapter, managed, storage } = build();
    managed.create.mockRejectedValue(new Error('row failed'));

    await expect(
      adapter.put({ ownerId: 'u', key: 'k/2', body: Buffer.from('x'), contentType: 'text/plain', managedBy: 'notes' }),
    ).rejects.toThrow('row failed');
    expect(storage.delete).toHaveBeenCalledWith('k/2');
  });

  it('lists the parts when the caller has none, and passes eTag to the platform', async () => {
    const { adapter, managed, objects, lister } = build();
    managed.get.mockResolvedValue({ id: 'o', storageKey: 'k', s3UploadId: 'up', uploadedById: 'u', orgId: 'org' });

    await adapter.completeUpload('o');
    await adapter.completeUpload('o', [{ partNumber: 2, etag: 'x' }]);

    expect(lister.listParts).toHaveBeenCalledTimes(1);
    expect(objects.completeUpload).toHaveBeenNthCalledWith(1, 'o', { parts: [{ partNumber: 1, eTag: 'e1' }] }, 'u', 'org');
    expect(objects.completeUpload).toHaveBeenNthCalledWith(2, 'o', { parts: [{ partNumber: 2, eTag: 'x' }] }, 'u', 'org');
  });

  it('answers 404 for an upload that does not exist', async () => {
    const { adapter, managed } = build();
    managed.get.mockResolvedValue(null);

    await expect(adapter.completeUpload('missing')).rejects.toBeInstanceOf(NotFoundException);
    await expect(adapter.signParts('missing', [1])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('signs parts only for an upload still open', async () => {
    const { adapter, managed } = build();
    managed.get.mockResolvedValueOnce({ id: 'o', storageKey: 'k', s3UploadId: 'up', status: 'pending' });
    expect(await adapter.signParts('o', [1, 3])).toEqual([{ partNumber: 1, url: 'https://u/1' }, { partNumber: 3, url: 'https://u/3' }]);

    managed.get.mockResolvedValueOnce({ id: 'o', storageKey: 'k', s3UploadId: null, status: 'ready' });
    await expect(adapter.signParts('o', [1])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('abortUpload is idempotent: a missing, orphaned or settled upload is not an error', async () => {
    const { adapter, managed } = build();

    managed.get.mockResolvedValueOnce(null);
    await expect(adapter.abortUpload('gone')).resolves.toBeUndefined();

    managed.get.mockResolvedValueOnce({ id: 'o', uploadedById: null, orgId: 'org' });
    await expect(adapter.abortUpload('orphan')).resolves.toBeUndefined();
    expect(managed.abortManaged).not.toHaveBeenCalled();

    managed.get.mockResolvedValueOnce({ id: 'o', uploadedById: 'u', orgId: 'org' });
    managed.abortManaged.mockRejectedValueOnce(new BadRequestException('settled'));
    await expect(adapter.abortUpload('o')).resolves.toBeUndefined();
  });

  it('folds platform statuses into the port\'s three and reports a missing object as null', async () => {
    const { adapter, managed } = build();
    const row = (status: string) => ({ id: 'o', size: BigInt(7), mimeType: 'text/plain', status });

    managed.get.mockResolvedValueOnce(row('uploading'));
    expect((await adapter.head('o'))?.status).toBe('pending');
    managed.get.mockResolvedValueOnce(row('processing'));
    expect((await adapter.head('o'))?.status).toBe('pending');
    managed.get.mockResolvedValueOnce(row('ready'));
    expect(await adapter.head('o')).toEqual({ size: 7, mimeType: 'text/plain', status: 'ready' });
    managed.get.mockResolvedValueOnce(row('failed'));
    expect((await adapter.head('o'))?.status).toBe('failed');
    managed.get.mockResolvedValueOnce(null);
    expect(await adapter.head('o')).toBeNull();
  });

  it('signs a download with a safe attachment header, and refuses an object that is not ready', async () => {
    const { adapter, managed } = build();
    managed.signedDownloadUrl.mockResolvedValueOnce({ url: 'https://d/1' });

    expect(await adapter.signedDownloadUrl('o', { ttlSeconds: 60, filename: 'ré"port.pdf' })).toBe('https://d/1');
    const options = managed.signedDownloadUrl.mock.calls[0]?.[1] as { expiresIn: number; contentDisposition: string };
    expect(options.expiresIn).toBe(60);
    expect(options.contentDisposition).toMatch(/^attachment; filename="r_+port\.pdf"; filename\*=UTF-8''r%C3%A9%22port\.pdf$/);

    managed.signedDownloadUrl.mockResolvedValueOnce(null);
    await expect(adapter.signedDownloadUrl('o', { ttlSeconds: 60 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete: a missing object is a no-op, a managed one goes through its owner, an unmanaged one through the platform', async () => {
    const { adapter, managed, objects } = build();

    managed.get.mockResolvedValueOnce(null);
    await adapter.delete('gone');
    expect(managed.deleteManaged).not.toHaveBeenCalled();

    managed.get.mockResolvedValueOnce({ id: 'm', uploadedById: 'u', orgId: 'org' });
    managed.managedBy.mockResolvedValueOnce(new Map([['m', 'notes']]));
    await adapter.delete('m');
    expect(managed.deleteManaged).toHaveBeenCalledWith('m', 'notes');

    managed.get.mockResolvedValueOnce({ id: 'p', uploadedById: 'u', orgId: 'org' });
    managed.managedBy.mockResolvedValueOnce(new Map());
    await adapter.delete('p');
    expect(objects.delete).toHaveBeenCalledWith('p', 'u', 'org', { canDeleteAny: true });
  });

  it('registers ONE processor however many handlers, runs each, and survives a failing one', async () => {
    const { adapter, registry, managed } = build();
    const seen: unknown[] = [];
    adapter.onUploaded(async () => {
      throw new Error('first handler fails');
    });
    adapter.onUploaded(async (event) => {
      seen.push(event);
    });
    managed.managedBy.mockResolvedValue(new Map([['obj', 'graph']]));

    expect(registry.register).toHaveBeenCalledTimes(1);
    const processor = registry.register.mock.calls[0]?.[0];
    expect(processor.canProcess({ id: 'obj', mimeType: 'anything' })).toBe(true);
    const result = await processor.process({ id: 'obj' }, async () => Readable.from([]));

    expect(result).toEqual({ success: true, metadata: { handlers: 2, failed: 1 } });
    expect(seen).toEqual([{ objectId: 'obj', managedBy: 'graph' }]);
  });

  it('queues a processing job only for a file some handler wants, and runs only the handlers that want it', async () => {
    const { adapter, registry, managed } = build();
    const audio: unknown[] = [];
    const everything: unknown[] = [];
    adapter.onUploaded(async (event) => void audio.push(event), { contentTypes: ['audio/*', 'video/*', 'application/zip'] });
    managed.managedBy.mockResolvedValue(new Map([['obj', 'transcripts']]));

    const processor = registry.register.mock.calls[0]?.[0];

    expect(processor.canProcess({ id: 'a', mimeType: 'audio/mpeg' })).toBe(true);
    expect(processor.canProcess({ id: 'a', mimeType: 'AUDIO/WAV' })).toBe(true);
    expect(processor.canProcess({ id: 'v', mimeType: 'video/mp4' })).toBe(true);
    expect(processor.canProcess({ id: 'z', mimeType: 'application/zip' })).toBe(true);
    expect(processor.canProcess({ id: 'p', mimeType: 'application/pdf' })).toBe(false);
    expect(processor.canProcess({ id: 'n', mimeType: '' })).toBe(false);

    // A second handler with no filter wants every file, so every file is processed again.
    adapter.onUploaded(async (event) => void everything.push(event));
    expect(processor.canProcess({ id: 'p', mimeType: 'application/pdf' })).toBe(true);

    await processor.process({ id: 'obj', mimeType: 'application/pdf' }, async () => Readable.from([]));
    expect(audio).toEqual([]);
    expect(everything).toEqual([{ objectId: 'obj', managedBy: 'transcripts' }]);
  });
});

// -----------------------------------------------------------------------------
describe('identity adapter', () => {
  const user = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'u@example.com',
    isActive: true,
    activeOrgId: 'org-default',
    userRoles: [],
    memberships: [
      {
        orgId: 'org-default',
        status: 'active',
        org: { id: 'org-default', isDefault: true },
        role: { name: 'viewer', rolePermissions: [{ permission: { name: 'notes:read' } }] },
      },
    ],
    ...overrides,
  });
  const jwtThatAttaches = (attach: Record<string, unknown>) => ({
    canActivate: async (context: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => {
      Object.assign(context.switchToHttp().getRequest(), attach);
      return true;
    },
  });
  const ctx = () => createFakeKvoxExecutionContext({ authorization: 'Bearer x' });

  it('derives permissions from the request user when no principal was attached, never from requestUser', async () => {
    // `requestUser` is what PermissionsGuard sets, and only on a route that declares a permission:
    // a poisoned value there must be ignored.
    const adapter = new PlatformKvoxIdentityAdapter(
      jwtThatAttaches({ user: user(), requestUser: { permissions: ['poisoned:all'] } }) as never,
      {} as never,
    );

    const principal = await adapter.authenticate(ctx());

    expect(principal?.permissions).toEqual(new Set(['notes:read']));
    expect(principal?.permissions.has('poisoned:all')).toBe(false);
    expect(principal).toMatchObject({ userId: 'u1', orgId: 'org-default', roles: ['viewer'] });
  });

  it('prefers the principal JwtAuthGuard attached (the active organization\'s permissions)', async () => {
    const adapter = new PlatformKvoxIdentityAdapter(
      jwtThatAttaches({
        user: user(),
        principal: { kind: 'user', userId: 'u1', credential: 'pat', roles: ['org_admin'], permissions: ['graph:write'], activeOrgId: 'org-9' },
      }) as never,
      {} as never,
    );

    expect(await adapter.authenticate(ctx())).toMatchObject({ orgId: 'org-9', roles: ['org_admin'], permissions: new Set(['graph:write']) });
  });

  it('is null for an unauthenticated request, an inactive user or a request with no user', async () => {
    const rejecting = { canActivate: async () => { throw new UnauthorizedException(); } };
    expect(await new PlatformKvoxIdentityAdapter(rejecting as never, {} as never).authenticate(ctx())).toBeNull();
    expect(await new PlatformKvoxIdentityAdapter(jwtThatAttaches({ user: user({ isActive: false }) }) as never, {} as never).authenticate(ctx())).toBeNull();
    expect(await new PlatformKvoxIdentityAdapter(jwtThatAttaches({}) as never, {} as never).authenticate(ctx())).toBeNull();
  });

  it('lets a 403 from the platform guard through (a node credential on a domain route)', async () => {
    const forbidding = { canActivate: async () => { throw new ForbiddenException('Worker node credentials may only be used on node endpoints'); } };

    await expect(new PlatformKvoxIdentityAdapter(forbidding as never, {} as never).authenticate(ctx())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('hasPermission reads fresh from the database and is false for a missing or inactive user', async () => {
    const find = jest.fn();
    const adapter = new PlatformKvoxIdentityAdapter({} as never, { user: { findUnique: find } } as never);

    find.mockResolvedValueOnce(user());
    expect(await adapter.hasPermission('u1', 'notes:read')).toBe(true);
    find.mockResolvedValueOnce(user());
    expect(await adapter.hasPermission('u1', 'notes:write')).toBe(false);
    find.mockResolvedValueOnce(user({ isActive: false }));
    expect(await adapter.hasPermission('u1', 'notes:read')).toBe(false);
    find.mockResolvedValueOnce(null);
    expect(await adapter.hasPermission('nobody', 'notes:read')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
describe('notify adapter', () => {
  it('notify returns at once and swallows a rejected or synchronously thrown delivery', () => {
    const rejecting = new PlatformKvoxNotifyAdapter({ notify: jest.fn().mockRejectedValue(new Error('smtp down')) } as never);
    const throwing = new PlatformKvoxNotifyAdapter({ notify: jest.fn(() => { throw new Error('sync'); }) } as never);

    expect(rejecting.notify('notes.note_ready', 'u', {})).toBeUndefined();
    expect(throwing.notify('notes.note_ready', 'u', {})).toBeUndefined();
  });

  it('forwards the event key, recipient and data', () => {
    const notify = jest.fn().mockResolvedValue(undefined);

    new PlatformKvoxNotifyAdapter({ notify } as never).notify('notes.note_ready', 'u1', { noteId: 'n' });

    expect(notify).toHaveBeenCalledWith('notes.note_ready', 'u1', { noteId: 'n' });
  });

  it('skips an event the app already registered and registers a new one with the platform defaults', () => {
    const adapter = new PlatformKvoxNotifyAdapter({} as never);
    expect(findEvent('notes.note_ready')).toBeDefined();
    const key = `kvox_test.event_${Date.now()}`;

    adapter.registerEvents([{ key: 'notes.note_ready', label: 'x', description: 'x', channels: ['email'] }]);
    adapter.registerEvents([{ key, label: 'Test', description: 'A test event', channels: ['browser'], browserTemplate: () => ({ title: 't', body: 'b' }) }]);

    expect(findEvent('notes.note_ready')?.label).not.toBe('x');
    expect(findEvent(key)).toMatchObject({ key, defaultEnabled: true, channels: ['browser'] });
  });
});

// -----------------------------------------------------------------------------
describe('settings adapter', () => {
  const store = { read: jest.fn(), patch: jest.fn() };
  const users = { getSettings: jest.fn(), patchSettings: jest.fn() };
  const prisma = { systemSettings: { findUnique: jest.fn() } };
  const adapter = () => new PlatformKvoxSettingsAdapter(store as never, users as never, prisma as never);

  it('verifies a namespace is in the platform registry instead of declaring it', () => {
    expect(() => adapter().registerNamespace({ scope: 'system', name: 'transcription', schema: z.object({}), defaults: {} })).not.toThrow();
    expect(() => adapter().registerNamespace({ scope: 'user', name: 'graph', schema: z.object({}), defaults: {} })).not.toThrow();
    expect(() => adapter().registerNamespace({ scope: 'system', name: 'not_there', schema: z.object({}), defaults: {} })).toThrow(/app-registrations\/settings\.ts/);
    // A user namespace is not a system one.
    expect(() => adapter().registerNamespace({ scope: 'system', name: 'graph', schema: z.object({}), defaults: {} })).toThrow(/not in the platform registry/);
  });

  it('falls back to the declared defaults for an unset namespace', async () => {
    const a = adapter();
    a.registerNamespace({ scope: 'user', name: 'graph', schema: z.object({}), defaults: { mode: 'off' } });
    users.getSettings.mockResolvedValue({});
    store.read.mockResolvedValue({ value: undefined, version: 3 });

    expect(await a.readUser('u', 'graph')).toEqual({ mode: 'off' });
    expect(await a.readSystem('missing')).toEqual({ value: undefined, version: 3 });
  });

  it('reads who last changed the settings row only when asked', async () => {
    store.read.mockResolvedValue({ value: { a: 1 }, version: 5 });
    prisma.systemSettings.findUnique.mockReset().mockResolvedValue({
      updatedAt: new Date('2026-01-02T03:04:05Z'),
      updatedByUser: { id: 'u1', email: 'admin@example.com' },
    });

    expect(await adapter().readSystem('transcription')).toEqual({ value: { a: 1 }, version: 5 });
    expect(prisma.systemSettings.findUnique).not.toHaveBeenCalled();

    expect(await adapter().readSystem('transcription', { withUpdatedBy: true })).toEqual({
      value: { a: 1 },
      version: 5,
      updatedAt: '2026-01-02T03:04:05.000Z',
      updatedBy: { id: 'u1', email: 'admin@example.com' },
    });
    expect(prisma.systemSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'global' } }),
    );
  });

  it('reports no author for a settings row nobody has written', async () => {
    store.read.mockResolvedValue({ value: { a: 1 }, version: 0 });
    prisma.systemSettings.findUnique.mockReset().mockResolvedValue(null);

    expect(await adapter().readSystem('transcription', { withUpdatedBy: true })).toEqual({
      value: { a: 1 },
      version: 0,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('passes the actor and the If-Match version to the platform store', async () => {
    store.patch.mockResolvedValue({ value: { a: 1 }, version: 4 });

    const result = await adapter().patchSystem('transcription', { a: 1 }, { actorUserId: 'admin', ifMatchVersion: 3 });

    expect(store.patch).toHaveBeenCalledWith('transcription', { a: 1 }, { actorUserId: 'admin', ifMatchVersion: 3 });
    expect(result).toEqual({ value: { a: 1 }, version: 4 });
  });
});

// -----------------------------------------------------------------------------
describe('secrets adapter', () => {
  it('leaves a purpose the app already registered alone and registers a new one once', () => {
    const adapter = new PlatformKvoxSecretsAdapter({} as never);
    const before = credentialPurposeRegistry.get('transcription');
    expect(before).toBeDefined();

    adapter.registerPurpose('transcription', 'something else');
    expect(credentialPurposeRegistry.get('transcription')).toBe(before);

    const purpose = `kvox_test_${Date.now()}`;
    adapter.registerPurpose(purpose, 'Test');
    adapter.registerPurpose(purpose, 'Test again');
    expect(credentialPurposeRegistry.get(purpose)).toMatchObject({ owner: 'kvox', label: 'Test', tiers: ['system'] });
  });

  it('records the actor and returns metadata only from status', async () => {
    const credentials = {
      setSecret: jest.fn(),
      describe: jest.fn().mockResolvedValue({ hint: '…1234', updatedAt: new Date('2026-01-01T00:00:00Z') }),
    };
    const adapter = new PlatformKvoxSecretsAdapter(credentials as never);

    await adapter.set('p', 'n', 'secret-value', 'admin');

    expect(credentials.setSecret).toHaveBeenCalledWith('p', 'n', 'secret-value', { updatedByUserId: 'admin' });
    expect(await adapter.status('p', 'n')).toEqual({ configured: true, hint: '…1234', updatedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('stores the label the caller names, and reports who last changed the secret', async () => {
    const credentials = {
      setSecret: jest.fn(),
      describe: jest.fn().mockResolvedValue({
        hint: '…1234',
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        updatedByUserId: 'admin',
      }),
    };
    const adapter = new PlatformKvoxSecretsAdapter(credentials as never);

    await adapter.set('p', 'n', 'secret-value', 'admin', { label: 'AssemblyAI API key' });

    expect(credentials.setSecret).toHaveBeenCalledWith('p', 'n', 'secret-value', {
      updatedByUserId: 'admin',
      label: 'AssemblyAI API key',
    });
    expect(await adapter.status('p', 'n')).toMatchObject({ updatedByUserId: 'admin' });
  });
});

// -----------------------------------------------------------------------------
describe('audit and events adapters', () => {
  it('stores a non-scalar audit detail as JSON text and drops undefined', async () => {
    const record = jest.fn().mockResolvedValue(undefined);

    await new PlatformKvoxAuditAdapter({ record } as never).record({
      actorUserId: 'a',
      action: 'x.deleted',
      targetType: 't',
      targetId: '1',
      meta: { n: 1, ok: true, nothing: null, text: 's', list: [1, 2], nested: { a: 1 }, absent: undefined },
    });

    expect(record).toHaveBeenCalledWith({
      actorUserId: 'a',
      action: 'x.deleted',
      targetType: 't',
      targetId: '1',
      meta: { n: 1, ok: true, nothing: null, text: 's', list: '[1,2]', nested: '{"a":1}' },
    });
  });

  it('emit never throws, even when the bus rejects or throws', () => {
    const rejecting = new PlatformKvoxEventsAdapter({ publish: jest.fn().mockRejectedValue(new Error('pg down')) } as never);
    const throwing = new PlatformKvoxEventsAdapter({ publish: jest.fn(() => { throw new Error('sync'); }) } as never);

    expect(rejecting.emit('graph.changed', {})).toBeUndefined();
    expect(throwing.emit('graph.changed', {})).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
describe('PlatformKvoxModule', () => {
  const required = [
    ['ai', KVOX_AI],
    ['objectStore', KVOX_OBJECT_STORE],
    ['jobs', KVOX_JOBS],
    ['identity', KVOX_IDENTITY],
    ['notify', KVOX_NOTIFY],
    ['prisma', KVOX_PRISMA],
    ['settings', KVOX_SETTINGS],
    ['secrets', KVOX_SECRETS],
  ] as const;

  it('binds all ten ports and exports their tokens', () => {
    const module = createPlatformKvoxModule();

    for (const key of ['ai', 'objectStore', 'jobs', 'identity', 'notify', 'prisma', 'settings', 'secrets', 'events', 'audit'] as const) {
      expect(platformKvoxPorts[key]).toBeDefined();
    }
    expect(module.global).toBe(true);
    expect(module.exports).toEqual(expect.arrayContaining([...required.map(([, token]) => token), KVOX_EVENTS, KVOX_AUDIT]));
  });

  it.each(required)('fails at boot, naming the port, when %s is not bound', (key, token) => {
    expect(() => createPlatformKvoxModule({ [key]: undefined })).toThrow(new RegExp(`${String(token.description?.split('/').pop())} \\(ports\\.${key}\\)`));
  });

  it('names every missing port at once', () => {
    expect(() => createPlatformKvoxModule({ jobs: undefined, secrets: undefined })).toThrow(/KVOX_JOBS.*KVOX_SECRETS/);
  });
});

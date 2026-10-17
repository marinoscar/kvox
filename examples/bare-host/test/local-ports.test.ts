import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RunningBareHost } from '../src/bootstrap.js';

// =============================================================================
// The local ports, one rule at a time
// =============================================================================
//
// The happy path proves the slices run on the ports; this file proves the ports
// themselves keep the promises `docs/specs/kvox-ports.md` makes, on the same
// database leg, because KVox Desktop starts from this code. Each rule names the
// behaviour a host must not lose when it replaces the implementation.
// =============================================================================

const here = dirname(fileURLToPath(import.meta.url));
const load = createRequire(import.meta.url);
const { startBareHost } = load('../dist/bootstrap.js') as typeof import('../src/bootstrap.js');
const { KvoxRateLimitError } = load('@marinoscar/kvox-api/ports') as typeof import('@marinoscar/kvox-api/ports');
const { LOCAL_USER_ID } = load('../dist/seed.js') as typeof import('../src/seed.js');
const { FileSettings } = load('../dist/ports/file-settings.js') as typeof import('../src/ports/file-settings.js');
const { z } = load('zod') as typeof import('zod');

let host: RunningBareHost;
let counter = 0;
const uniqueType = (): string => `bare.host.test.${process.pid}.${(counter += 1)}`;

beforeAll(async () => {
  host = await startBareHost({ backgroundJobs: false, dataDir: join(here, '..', '.data', `ports-${process.pid}`) });
});

afterAll(async () => {
  await host?.close();
});

describe('PgTableJobs', () => {
  it('collapses a repeat of the same type and subject into the first job, and skipDedup makes a distinct one', async () => {
    const type = uniqueType();
    host.jobs.registerHandler({ type, async process() {} });

    const first = await host.jobs.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {} });
    const repeat = await host.jobs.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {} });
    const distinct = await host.jobs.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {}, skipDedup: true });

    expect(first.deduplicated).toBe(false);
    expect(repeat).toEqual({ id: first.id, deduplicated: true });
    expect(distinct.deduplicated).toBe(false);
    expect(distinct.id).not.toBe(first.id);

    const active = await host.jobs.findActive({ types: [type], subjectType: 'thing', subjectIds: ['1'] });
    expect(active.map((job) => job.id).sort()).toEqual([first.id, distinct.id].sort());

    await host.jobs.drain();
    expect(await host.jobs.findActive({ types: [type] })).toEqual([]);
    // Once settled, the key is free again.
    expect((await host.jobs.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {} })).deduplicated).toBe(false);
    await host.jobs.drain();
  });

  it('retries a failing attempt up to maxAttempts, then fails the job and tells the listeners', async () => {
    const type = uniqueType();
    const attempts: number[] = [];
    host.jobs.registerHandler({
      type,
      profile: { maxRuntimeMs: 60_000, maxAttempts: 3 },
      async process(job) {
        attempts.push(job.attempts);
        throw new Error('always broken');
      },
    });
    const settled: Array<{ type: string; status: string; lastError: string | null }> = [];
    host.jobs.onSettled((event) => {
      if (event.type === type) settled.push({ type: event.type, status: event.status, lastError: event.lastError });
    });

    const { id } = await host.jobs.enqueue({ type, payload: {} });
    await host.jobs.drain();

    expect(attempts).toEqual([1, 2, 3]);
    expect(settled).toEqual([{ type, status: 'failed', lastError: 'always broken' }]);
    const row = await host.prisma.job.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(3);
    expect(row.lastError).toBe('always broken');
  });

  it('defers a rate-limited job without spending an attempt, and runNow pulls it forward', async () => {
    const type = uniqueType();
    let calls = 0;
    host.jobs.registerHandler({
      type,
      async process() {
        calls += 1;
        if (calls === 1) throw new KvoxRateLimitError('provider:test', 60_000);
      },
    });

    const { id } = await host.jobs.enqueue({ type, subjectType: 'thing', subjectId: 'rl', payload: {} });
    await host.jobs.drain();

    const waiting = await host.prisma.job.findUniqueOrThrow({ where: { id } });
    expect(calls).toBe(1);
    expect(waiting.status).toBe('pending');
    expect(waiting.attempts).toBe(0);
    expect(waiting.rateLimitHits).toBe(1);
    expect(waiting.scheduledFor!.getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Not due yet: a drain leaves it alone.
    await host.jobs.drain();
    expect(calls).toBe(1);
    expect((await host.jobs.findLatest({ type, subjectType: 'thing', subjectId: 'rl' }))?.status).toBe('pending');

    expect(await host.jobs.runNow(id)).toBe(true);
    expect(await host.jobs.runNow(id)).toBe(false);
    await host.jobs.drain();
    expect(calls).toBe(2);
    expect((await host.jobs.findLatest({ type, subjectType: 'thing', subjectId: 'rl' }))?.status).toBe('succeeded');
  });

  it('never claims a type nothing registered, and enqueueWithin joins the caller\'s transaction', async () => {
    const orphan = uniqueType();
    const { id } = await host.jobs.enqueue({ type: orphan, payload: {} });
    await host.jobs.drain();
    expect((await host.prisma.job.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    await host.prisma.job.delete({ where: { id } });

    const type = uniqueType();
    host.jobs.registerHandler({ type, async process() {} });
    await expect(
      host.prisma.$transaction(async (tx) => {
        await host.jobs.enqueueWithin(tx, { type, payload: {} });
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await host.prisma.job.count({ where: { type } })).toBe(0);

    await host.prisma.$transaction(async (tx) => {
      await host.jobs.enqueueWithin(tx, { type, payload: {} });
    });
    expect(await host.prisma.job.count({ where: { type } })).toBe(1);
    await host.jobs.drain();
  });
});

describe('LocalFsObjectStore', () => {
  const put = (key: string, body: Buffer | Readable = Buffer.from('bytes')) =>
    host.objectStore.put({ ownerId: LOCAL_USER_ID, key, body, contentType: 'text/plain', managedBy: 'notes' });

  it('refuses a key that leaves the object folder', async () => {
    for (const key of ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', '']) {
      await expect(put(key), key).rejects.toThrow(/unsafe storage key|leaves the object folder/);
    }
  });

  it('is idempotent on a key, streams bytes in and out, and deletes idempotently', async () => {
    const first = await put('ports/idempotent.txt', Readable.from([Buffer.from('one '), Buffer.from('two')]));
    const second = await put('ports/idempotent.txt', Buffer.from('ignored'));
    expect(second.objectId).toBe(first.objectId);
    expect(first.size).toBe(7);

    const chunks: Buffer[] = [];
    for await (const chunk of await host.objectStore.openRead(first.objectId)) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('one two');

    await host.objectStore.delete(first.objectId);
    await host.objectStore.delete(first.objectId);
    expect(await host.objectStore.head(first.objectId)).toBeNull();
    expect(existsSync(join(host.objectStore.objectFolder, 'ports', 'idempotent.txt'))).toBe(false);
  });

  it('describes owner and owning module, replaces metadata and lists a module\'s files under a prefix', async () => {
    const a = await host.objectStore.put({ ownerId: LOCAL_USER_ID, key: 'ports/listed/a.txt', body: Buffer.from('a'), contentType: 'text/plain', managedBy: 'graph', metadata: { first: 1 } });
    const b = await host.objectStore.put({ ownerId: LOCAL_USER_ID, key: 'ports/listed/b.txt', body: Buffer.from('b'), contentType: 'text/plain', managedBy: 'graph' });
    await put('ports/listed/other.txt');

    const info = (await host.objectStore.describe([a.objectId, 'not-an-object'])).get(a.objectId);
    expect(info).toMatchObject({ ownerId: LOCAL_USER_ID, managedBy: 'graph', metadata: { first: 1 }, state: 'ready', size: 1 });
    await host.objectStore.setMetadata(a.objectId, { second: 2 });
    expect((await host.objectStore.describe([a.objectId])).get(a.objectId)?.metadata).toEqual({ second: 2 });
    expect((await host.objectStore.describe([a.objectId])).get(a.objectId)?.managedBy).toBe('graph');

    const listed = await host.objectStore.listManaged({ ownerId: LOCAL_USER_ID, managedBy: 'graph', keyPrefix: 'ports/listed/', limit: 10 });
    expect(listed).toEqual([a.objectId, b.objectId].sort());
    expect(await host.objectStore.listManaged({ ownerId: LOCAL_USER_ID, managedBy: 'graph', keyPrefix: 'ports/listed/', limit: 1 })).toHaveLength(1);
  });

  it('serves a signed download, and refuses a tampered, foreign or expired signature', async () => {
    const { objectId } = await put('ports/download.txt', Buffer.from('download me'));
    const url = await host.objectStore.signedDownloadUrl(objectId, { ttlSeconds: 60, filename: 'x.txt' });

    const ok = await fetch(url);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('download me');
    expect(ok.headers.get('content-disposition')).toContain('x.txt');

    expect((await fetch(url.replace(/sig=[0-9a-f]{4}/, 'sig=0000'))).status).toBe(401);
    expect((await fetch(url.replace('x.txt', 'y.txt'))).status).toBe(401);
    const expired = await host.objectStore.signedDownloadUrl(objectId, { ttlSeconds: -1 });
    expect((await fetch(expired)).status).toBe(401);
  });

  it('aborts an upload once: the row is kept as failed and onAborted fires once', async () => {
    const seen: string[] = [];
    host.objectStore.onAborted(async (event) => {
      seen.push(`${event.objectId}:${event.managedBy}`);
    });
    const init = await host.objectStore.initUpload({ userId: LOCAL_USER_ID }, { name: 'a.m4a', mimeType: 'audio/mp4', size: 10, managedBy: 'transcripts' });
    await host.objectStore.abortUpload(init.objectId);
    await host.objectStore.abortUpload(init.objectId);

    expect(seen).toEqual([`${init.objectId}:transcripts`]);
    expect(await host.objectStore.head(init.objectId)).toMatchObject({ status: 'failed' });
  });

  it('rejects a type the owning module does not accept', async () => {
    await expect(
      host.objectStore.initUpload({ userId: LOCAL_USER_ID }, { name: 'a.exe', mimeType: 'application/x-msdownload', size: 10, managedBy: 'transcripts', allowedMimeTypes: ['audio/*'] }),
    ).rejects.toThrow(/not accepted/);
  });
});

describe('FileSettings', () => {
  it('keeps versions, merges patches, validates against the schema and survives a restart', async () => {
    const path = join(host.dataDir, 'settings-rule.json');
    const def = {
      scope: 'system' as const,
      name: 'rule',
      schema: z.object({ label: z.string(), nested: z.object({ a: z.number(), b: z.number() }) }),
      defaults: { label: 'none', nested: { a: 1, b: 2 } },
    };
    const first = new FileSettings(path);
    first.registerNamespace(def);

    expect(await first.readSystem('rule')).toMatchObject({ version: 0, value: def.defaults });
    const patched = await first.patchSystem('rule', { nested: { a: 10 } } as never, { actorUserId: LOCAL_USER_ID, ifMatchVersion: 0 });
    expect(patched).toMatchObject({ version: 1, value: { label: 'none', nested: { a: 10, b: 2 } } });
    await expect(first.patchSystem('rule', { label: 'x' }, { actorUserId: LOCAL_USER_ID, ifMatchVersion: 0 })).rejects.toThrow(/version 1/);
    await expect(first.patchSystem('rule', { label: 5 } as never, { actorUserId: LOCAL_USER_ID })).rejects.toThrow();

    const second = new FileSettings(path);
    second.registerNamespace(def);
    expect(await second.readSystem('rule')).toMatchObject({ version: 1, value: { nested: { a: 10, b: 2 } } });
  });
});

describe('LocalSingleUserIdentity', () => {
  it('answers 401 on every guarded route without the header, and 404 for an object that is not the caller\'s', async () => {
    for (const path of ['/api/transcripts', '/api/notes', '/api/note-templates', '/api/search?q=x', '/api/transcription-settings']) {
      expect((await fetch(`${host.baseUrl}${path}`)).status, path).toBe(401);
    }
    const missing = '00000000-0000-4000-8000-0000000000ff';
    const response = await fetch(`${host.baseUrl}/api/storage/objects/${missing}/upload/complete`, {
      method: 'POST',
      headers: { 'x-local-user': '1', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });
});

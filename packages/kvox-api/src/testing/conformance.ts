import { Readable } from 'node:stream';

import type { ExecutionContext } from '@nestjs/common';
import { z } from 'zod';

import {
  KVOX_AI_ERROR_CLASSES,
  KvoxAiError,
  type KvoxAiContext,
  type KvoxAiErrorClass,
  type KvoxAiPort,
  type KvoxAuditPort,
  type KvoxEventsPort,
  type KvoxIdentityPort,
  type KvoxInitUploadResult,
  type KvoxJobsPort,
  type KvoxNotifyPort,
  type KvoxObjectStorePort,
  type KvoxSecretsPort,
  type KvoxSettingsNamespaceDef,
  type KvoxSettingsPort,
} from '../ports/index.js';

// =============================================================================
// describeKvoxPortsConformance (issue 5.4, epic 486)
// =============================================================================
//
// The executable proof that a binding of the host ports is correct. The fakes of
// this package pass it, the web edition's adapters pass it, and a Desktop author
// runs it against theirs. It is test-runner neutral: the caller hands over
// `describe`, `it` and `expect`, so it works under Jest and Vitest alike.
//
// Each port has a section. A section needs the port from the factory plus the few
// hooks the kit cannot invent (how to provoke a failure, an anonymous request,
// which settings namespace exists). A hook a host cannot offer is simply left out
// and the rule that needs it is skipped; a port the factory omits fails its
// section unless it is named in `options.skip`.
// =============================================================================

/** Patterns that would mean a credential leaked into an event, error or capability. */
const KEY_PATTERNS: readonly RegExp[] = [/sk-[A-Za-z0-9]{10,}/, /ghp_|gho_|github_pat_/];

/**
 * The test runner's functions, so the kit runs under Jest or Vitest. When
 * omitted, the globals are used.
 *
 * @stability experimental
 */
export interface KvoxConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * A schema the model under test will answer.
 *
 * @stability experimental
 */
export interface KvoxStructuredFixture {
  /** The schema. */
  schema: z.ZodType;
  /** Its name, as sent to the provider. */
  schemaName: string;
}

/**
 * Two permissions for the identity checks.
 *
 * @stability experimental
 */
export interface KvoxPermissionFixture {
  /** A permission the authenticated principal holds. */
  granted: string;
  /** One it lacks. */
  notGranted: string;
}

/**
 * A registered event and its recipient.
 *
 * @stability experimental
 */
export interface KvoxNotifyFixture {
  /** The event key. */
  key: string;
  /** The recipient. */
  userId: string;
}

/**
 * A system settings namespace and a valid patch for it.
 *
 * @stability experimental
 */
export interface KvoxSystemSettingsFixture {
  /** The namespace key. */
  name: string;
  /** A patch the schema accepts. */
  patch: Record<string, unknown>;
  /** The acting user. */
  actorUserId: string;
}

/**
 * A user settings namespace and a valid patch for it.
 *
 * @stability experimental
 */
export interface KvoxUserSettingsFixture {
  /** The namespace key. */
  name: string;
  /** The user whose value is patched. */
  userId: string;
  /** A patch the schema accepts. */
  patch: Record<string, unknown>;
}

/**
 * The events port under test.
 *
 * @stability experimental
 */
export interface KvoxEventsUnderTest {
  /** The port. */
  port: KvoxEventsPort;
}

/**
 * The audit port under test.
 *
 * @stability experimental
 */
export interface KvoxAuditUnderTest {
  /** The port. */
  port: KvoxAuditPort;
}

/**
 * What the kit needs to test the AI port.
 *
 * @stability experimental
 */
export interface KvoxAiUnderTest {
  /** The port. */
  port: KvoxAiPort;
  /** The context to call with. Defaults to a throwaway user and `notes.generate`. */
  context?: KvoxAiContext;
  /**
   * Arranges for the next call to fail with the given class, and returns whether
   * the host can produce it. A class the host cannot produce is skipped.
   */
  failNextWith?(errorClass: KvoxAiErrorClass): boolean | Promise<boolean>;
  /** Arranges for the next `chat` step to emit text, then a tool call, then more text. */
  arrangeTextAfterToolCall?(): void | Promise<void>;
  /** A schema the model will answer, so `generateStructured` can be checked. */
  structured?: KvoxStructuredFixture;
}

/**
 * What the kit needs to test the object-store port.
 *
 * @stability experimental
 */
export interface KvoxObjectStoreUnderTest {
  /** The port. */
  port: KvoxObjectStorePort;
  /** The owner to put objects as. Defaults to a throwaway user. */
  ownerId?: string;
  /**
   * Puts the bytes of an upload the kit just started to the part URLs `initUpload` handed out.
   * A store that checks its parts at `completeUpload` (a filesystem store, S3) refuses to seal an
   * upload nothing was sent to; leave the hook out only when the port accepts that (the fakes do).
   * The kit calls it with the result of `initUpload` and the declared size, before `completeUpload`.
   */
  uploadParts?(init: KvoxInitUploadResult, size: number): Promise<void>;
}

/**
 * What the kit needs to test the job port.
 *
 * @stability experimental
 */
export interface KvoxJobsUnderTest {
  /** The port. */
  port: KvoxJobsPort;
  /** Runs every runnable job to completion (a worker pass). */
  drain(): Promise<void>;
}

/**
 * What the kit needs to test the identity port.
 *
 * @stability experimental
 */
export interface KvoxIdentityUnderTest {
  /** The port. */
  port: KvoxIdentityPort;
  /** A request that carries no credentials. */
  anonymous: ExecutionContext;
  /** A request that carries valid credentials, when the host can build one. */
  authenticated?: ExecutionContext;
  /** A permission the authenticated principal holds and one it lacks, for `hasPermission`. */
  permissions?: KvoxPermissionFixture;
}

/**
 * What the kit needs to test the notification port.
 *
 * @stability experimental
 */
export interface KvoxNotifyUnderTest {
  /** The port. */
  port: KvoxNotifyPort;
  /** A registered event key and a recipient to raise it for. */
  event?: KvoxNotifyFixture;
}

/**
 * What the kit needs to test the settings port.
 *
 * @stability experimental
 */
export interface KvoxSettingsUnderTest {
  /** The port. */
  port: KvoxSettingsPort;
  /** Namespaces to declare through `registerNamespace` before the rules run. */
  namespaces?: KvoxSettingsNamespaceDef[];
  /** A system namespace the host knows and a valid patch for it. */
  system?: KvoxSystemSettingsFixture;
  /** A user namespace the host knows and a valid patch for it. */
  user?: KvoxUserSettingsFixture;
}

/**
 * What the kit needs to test the secrets port.
 *
 * @stability experimental
 */
export interface KvoxSecretsUnderTest {
  /** The port. */
  port: KvoxSecretsPort;
  /** A purpose to register and use. */
  purpose: string;
  /** The secret name within the purpose. */
  name: string;
  /** The user recorded as the author of changes. */
  actorUserId: string;
}

/**
 * The ports a host (or a fake) offers to the kit. Build it fresh on every call:
 * each test gets its own.
 *
 * @stability experimental
 */
export interface KvoxPortsUnderTest {
  /** The model port. */
  ai?: KvoxAiUnderTest;
  /** The object-store port. */
  objectStore?: KvoxObjectStoreUnderTest;
  /** The job port. */
  jobs?: KvoxJobsUnderTest;
  /** The identity port. */
  identity?: KvoxIdentityUnderTest;
  /** The notification port. */
  notify?: KvoxNotifyUnderTest;
  /** The event port. */
  events?: KvoxEventsUnderTest;
  /** The settings port. */
  settings?: KvoxSettingsUnderTest;
  /** The secrets port. */
  secrets?: KvoxSecretsUnderTest;
  /** The audit port. */
  audit?: KvoxAuditUnderTest;
  /** Releases whatever the test built. */
  dispose?(): Promise<void> | void;
}

/**
 * The names of the ports a section exists for.
 *
 * @stability experimental
 */
export type KvoxConformancePort =
  | 'ai'
  | 'objectStore'
  | 'jobs'
  | 'identity'
  | 'notify'
  | 'events'
  | 'settings'
  | 'secrets'
  | 'audit';

/**
 * Options of {@link describeKvoxPortsConformance}.
 *
 * @stability experimental
 */
export interface KvoxConformanceOptions {
  /** Ports to leave out (for example `events` on a host that binds the default). */
  skip?: KvoxConformancePort[];
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function noKeyIn(expect: KvoxConformanceHarness['expect'], what: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const pattern of KEY_PATTERNS) {
    expect(`${what}: ${pattern.test(text ?? '')}`).toBe(`${what}: false`);
  }
}

/** A readable that yields `count` chunks of `size` bytes, lazily, noting each pull. */
function lazyChunks(count: number, size: number, onPull: (index: number) => void): Readable {
  let index = 0;
  return new Readable({
    highWaterMark: size,
    read() {
      if (index >= count) {
        this.push(null);
        return;
      }
      onPull(index);
      this.push(Buffer.alloc(size, index % 251));
      index += 1;
    },
  });
}

/**
 * Registers the behavioural rules every binding of the host ports must satisfy.
 *
 * @example
 * ```ts
 * describeKvoxPortsConformance('fakes', createFakeKvoxPortsUnderTest);
 * ```
 *
 * @param name - what is being tested, for the group names.
 * @param factory - builds the ports under test; called once per test.
 * @param harness - `describe`, `it` and `expect` of the runner; the globals when omitted.
 * @param options - ports to skip.
 * @stability experimental
 */
export function describeKvoxPortsConformance(
  name: string,
  factory: () => KvoxPortsUnderTest | Promise<KvoxPortsUnderTest>,
  harness?: KvoxConformanceHarness,
  options: KvoxConformanceOptions = {},
): void {
  const g = globalThis as unknown as Partial<KvoxConformanceHarness>;
  const { describe, it, expect } = (harness ?? {
    describe: g.describe,
    it: g.it,
    expect: g.expect,
  }) as KvoxConformanceHarness;
  if (!describe || !it || !expect) {
    throw new Error('describeKvoxPortsConformance needs describe, it and expect: pass them as the third argument.');
  }
  const skipped = new Set(options.skip ?? []);

  function section<K extends KvoxConformancePort>(
    key: K,
    title: string,
    rules: (rule: (ruleName: string, body: (under: NonNullable<KvoxPortsUnderTest[K]>) => Promise<void>) => void) => void,
  ): void {
    if (skipped.has(key)) return;
    describe(`${name}: ${title}`, () => {
      rules((ruleName, body) => {
        it(ruleName, async () => {
          const ports = await factory();
          try {
            const under = ports[key];
            if (!under) {
              throw new Error(`The factory returned no "${key}" port. Name it in options.skip to leave it out.`);
            }
            await body(under as NonNullable<KvoxPortsUnderTest[K]>);
          } finally {
            await ports.dispose?.();
          }
        });
      });
    });
  }

  const ctxOf = (under: KvoxAiUnderTest): KvoxAiContext =>
    under.context ?? { userId: 'user-conformance', orgId: null, feature: 'notes.generate' };

  // ---------------------------------------------------------------------------
  section('ai', 'KVOX_AI', (rule) => {
    rule('capabilities() never throws, even when the next call is set to fail', async (ai) => {
      await ai.failNextWith?.('other');
      const capabilities = await ai.port.capabilities(ctxOf(ai));
      expect(typeof capabilities.available).toBe('boolean');
      expect(typeof capabilities.structuredOutput).toBe('boolean');
      expect(typeof capabilities.toolCalling).toBe('boolean');
      noKeyIn(expect, 'capabilities', capabilities);
    });

    rule('resolveTask returns a target with positive limits', async (ai) => {
      const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
      expect(typeof target.provider).toBe('string');
      expect(typeof target.model).toBe('string');
      expect(target.contextWindowTokens).toBeGreaterThan(0);
      expect(target.maxOutputTokens).toBeGreaterThan(0);
    });

    rule('generateText yields at least one event and ends with exactly one done', async (ai) => {
      const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
      const events = await collect(ai.port.generateText(ctxOf(ai), { target, system: 'Be brief.', user: 'Say hi.' }));
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]?.type).toBe('done');
      expect(events.filter((event) => event.type === 'done').length).toBe(1);
      expect(events.slice(0, -1).every((event) => event.type === 'delta')).toBe(true);
      noKeyIn(expect, 'generateText events', events);
    });

    rule('generateStructured returns a value that satisfies its schema', async (ai) => {
      if (!ai.structured) return;
      const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
      const { value, usage } = await ai.port.generateStructured(ctxOf(ai), {
        target,
        system: 'Answer in JSON.',
        user: 'Go.',
        schema: ai.structured.schema,
        schemaName: ai.structured.schemaName,
      });
      expect(ai.structured.schema.safeParse(value).success).toBe(true);
      expect(usage).toBeTruthy();
    });

    rule('chat yields at least one event, a step_end and exactly one done', async (ai) => {
      const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
      const events = await collect(
        ai.port.chat(ctxOf(ai), {
          target,
          messages: [{ role: 'user', content: 'Hello' }],
          tools: [],
          toolChoice: 'none',
        }),
      );
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]?.type).toBe('done');
      expect(events.filter((event) => event.type === 'done').length).toBe(1);
      expect(events.some((event) => event.type === 'step_end')).toBe(true);
      noKeyIn(expect, 'chat events', events);
    });

    rule('chat never yields text after a tool_call in the same step', async (ai) => {
      if (!ai.arrangeTextAfterToolCall) return;
      await ai.arrangeTextAfterToolCall();
      const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
      const events = await collect(
        ai.port.chat(ctxOf(ai), {
          target,
          messages: [{ role: 'user', content: 'Use the tool.' }],
          tools: [{ name: 'lookup', description: 'Looks something up.', parameters: { type: 'object', properties: {} } }],
          toolChoice: 'auto',
        }),
      );
      let afterToolCall = false;
      for (const event of events) {
        if (event.type === 'tool_call') afterToolCall = true;
        if (event.type === 'step_end') afterToolCall = false;
        expect(afterToolCall && event.type === 'delta').toBe(false);
      }
      expect(events.some((event) => event.type === 'tool_call')).toBe(true);
    });

    rule('embed returns one vector per input, each of the reported width', async (ai) => {
      const inputs = ['alpha', 'beta', 'gamma'];
      const result = await ai.port.embed(ctxOf(ai), { inputs });
      expect(result.vectors.length).toBe(inputs.length);
      expect(result.dimensions).toBeGreaterThan(0);
      expect(result.vectors.every((vector) => vector.length === result.dimensions)).toBe(true);
      expect(typeof result.model).toBe('string');
    });

    rule('countTokens returns a non-negative integer', async (ai) => {
      const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
      const tokens = ai.port.countTokens(target, 'How many tokens is this sentence?');
      expect(Number.isInteger(tokens)).toBe(true);
      expect(tokens).toBeGreaterThan(0);
    });

    rule('every failure is a KvoxAiError of a known class, with no key in its message', async (ai) => {
      if (!ai.failNextWith) return;
      for (const errorClass of KVOX_AI_ERROR_CLASSES) {
        const calls: Array<[string, () => Promise<unknown>]> = [
          ['generateText', async () => {
            const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
            return collect(ai.port.generateText(ctxOf(ai), { target, system: 's', user: 'u' }));
          }],
          ['chat', async () => {
            const target = await ai.port.resolveTask(ctxOf(ai), ctxOf(ai).feature);
            return collect(
              ai.port.chat(ctxOf(ai), { target, messages: [{ role: 'user', content: 'u' }], tools: [], toolChoice: 'none' }),
            );
          }],
          ['embed', () => ai.port.embed(ctxOf(ai), { inputs: ['x'] })],
        ];
        for (const [method, run] of calls) {
          // The resolve step inside a call may itself be the one that fails; either is fine.
          if (!(await ai.failNextWith(errorClass))) break;
          const error = await failure(run);
          expect(`${method}/${errorClass}: ${error instanceof KvoxAiError}`).toBe(`${method}/${errorClass}: true`);
          const known = error instanceof KvoxAiError && KVOX_AI_ERROR_CLASSES.includes(error.errorClass);
          expect(`${method}/${errorClass}: ${known}`).toBe(`${method}/${errorClass}: true`);
          noKeyIn(expect, `${method}/${errorClass} message`, (error as Error).message);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  section('objectStore', 'KVOX_OBJECT_STORE', (rule) => {
    const owner = (under: KvoxObjectStoreUnderTest): string => under.ownerId ?? 'user-conformance';

    rule('put, head and openRead round-trip the same bytes', async (store) => {
      const body = Buffer.from('hello object store');
      const { objectId, size } = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/hello.txt',
        body,
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      expect(size).toBe(body.length);
      const head = await store.port.head(objectId);
      expect(head?.size).toBe(body.length);
      expect(head?.mimeType).toBe('text/plain');
      expect(head?.status).toBe('ready');
      expect(Buffer.concat(await collect(await store.port.openRead(objectId) as AsyncIterable<Buffer>)).equals(body)).toBe(true);
    });

    rule('a 6 MiB stream is consumed incrementally, not read whole up front', async (store) => {
      const chunk = 1024 * 1024;
      const pulled: number[] = [];
      const source = lazyChunks(6, chunk, (index) => pulled.push(index));
      const result = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/large.bin',
        body: source,
        contentType: 'application/octet-stream',
        managedBy: 'transcripts',
      });
      expect(result.size).toBe(6 * chunk);
      // Every chunk was pulled one after another from the source, in order.
      expect(pulled).toEqual([0, 1, 2, 3, 4, 5]);
      const read = Buffer.concat(await collect(await store.port.openRead(result.objectId) as AsyncIterable<Buffer>));
      expect(read.length).toBe(6 * chunk);
      expect(read[0]).toBe(0);
      expect(read[read.length - 1]).toBe(5);
    });

    rule('signedDownloadUrl returns a string', async (store) => {
      const { objectId } = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/signed.txt',
        body: Buffer.from('x'),
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      const url = await store.port.signedDownloadUrl(objectId, { ttlSeconds: 60, filename: 'signed.txt' });
      expect(typeof url).toBe('string');
      expect(url.length).toBeGreaterThan(0);
    });

    rule('delete is idempotent and head then answers null', async (store) => {
      const { objectId } = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/delete.txt',
        body: Buffer.from('x'),
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      await store.port.delete(objectId);
      await store.port.delete(objectId);
      expect(await store.port.head(objectId)).toBeNull();
    });

    rule('initUpload hands out an object id, a part size and at least one part', async (store) => {
      const init = await store.port.initUpload(
        { userId: owner(store) },
        { name: 'a.m4a', mimeType: 'audio/mp4', size: 1024, managedBy: 'transcripts' },
      );
      expect(typeof init.objectId).toBe('string');
      expect(init.partSize).toBeGreaterThan(0);
      expect(init.parts.length).toBeGreaterThan(0);
      expect(init.parts.every((part) => typeof part.url === 'string' && part.partNumber >= 1)).toBe(true);
      await store.port.abortUpload(init.objectId);
      await store.port.abortUpload(init.objectId);
    });

    rule('put is idempotent on the key: a second put of the same key answers the first object', async (store) => {
      const first = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/idempotent.txt',
        body: Buffer.from('once'),
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      const second = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/idempotent.txt',
        body: Buffer.from('once'),
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      expect(second.objectId).toBe(first.objectId);
    });

    rule('describe answers the facts of the known ids in one call and leaves the unknown ones out', async (store) => {
      const { objectId } = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/described.txt',
        body: Buffer.from('describe me'),
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      const found = await store.port.describe([objectId, 'conformance-unknown-object']);
      expect(found.size).toBe(1);
      const info = found.get(objectId);
      expect(info?.id).toBe(objectId);
      expect(info?.mimeType).toBe('text/plain');
      expect(info?.size).toBe('describe me'.length);
      expect(info?.state).toBe('ready');
      expect(info?.createdAt instanceof Date).toBe(true);
      expect(info?.updatedAt instanceof Date).toBe(true);
      expect((await store.port.describe([])).size).toBe(0);
    });

    rule('describe reports the owner and owning module, and setMetadata replaces the stored data', async (store) => {
      const { objectId } = await store.port.put({
        ownerId: owner(store),
        key: 'conformance/metadata.txt',
        body: Buffer.from('meta'),
        contentType: 'text/plain',
        managedBy: 'notes',
        metadata: { first: 1 },
      });
      const before = (await store.port.describe([objectId])).get(objectId);
      expect(before?.ownerId).toBe(owner(store));
      expect(before?.managedBy).toBe('notes');
      expect(before?.metadata).toEqual({ first: 1 });
      await store.port.setMetadata(objectId, { second: 2 });
      const after = (await store.port.describe([objectId])).get(objectId);
      expect(after?.metadata).toEqual({ second: 2 });
      await store.port.setMetadata('conformance-unknown-object', { ignored: true });
    });

    rule('listManaged answers the ids of one module\'s files of one user under a key prefix, ascending', async (store) => {
      const prefix = `conformance/listed-${Date.now().toString(36)}/`;
      const ids: string[] = [];
      for (const name of ['a.txt', 'b.txt']) {
        const { objectId } = await store.port.put({
          ownerId: owner(store),
          key: `${prefix}${name}`,
          body: Buffer.from(name),
          contentType: 'text/plain',
          managedBy: 'graph',
        });
        ids.push(objectId);
      }
      await store.port.put({
        ownerId: owner(store),
        key: `${prefix}notes.txt`,
        body: Buffer.from('other module'),
        contentType: 'text/plain',
        managedBy: 'notes',
      });
      const listed = await store.port.listManaged({
        ownerId: owner(store),
        managedBy: 'graph',
        keyPrefix: prefix,
        limit: 10,
      });
      expect(listed).toEqual([...ids].sort());
      const limited = await store.port.listManaged({ ownerId: owner(store), managedBy: 'graph', keyPrefix: prefix, limit: 1 });
      expect(limited.length).toBe(1);
    });

    rule('the onAborted handler fires once for a cancelled upload', async (store) => {
      const seen: Array<{ objectId: string; managedBy: string | null }> = [];
      store.port.onAborted(async (event) => {
        seen.push(event);
      });
      const init = await store.port.initUpload(
        { userId: owner(store) },
        { name: 'c.m4a', mimeType: 'audio/mp4', size: 1024, managedBy: 'transcripts' },
      );
      await store.port.abortUpload(init.objectId);
      await store.port.abortUpload(init.objectId);
      await tick();
      expect(seen.length).toBe(1);
      expect(seen[0]?.objectId).toBe(init.objectId);
      expect(seen[0]?.managedBy).toBe('transcripts');
    });

    rule('the onUploaded handler fires once per completed upload', async (store) => {
      const seen: Array<{ objectId: string; managedBy: string | null }> = [];
      store.port.onUploaded(async (event) => {
        seen.push(event);
      });
      const init = await store.port.initUpload(
        { userId: owner(store) },
        { name: 'b.m4a', mimeType: 'audio/mp4', size: 1024, managedBy: 'transcripts' },
      );
      await store.uploadParts?.(init, 1024);
      await store.port.completeUpload(init.objectId);
      await tick();
      expect(seen.length).toBe(1);
      expect(seen[0]?.objectId).toBe(init.objectId);
      expect(seen[0]?.managedBy).toBe('transcripts');
    });
  });

  // ---------------------------------------------------------------------------
  section('jobs', 'KVOX_JOBS', (rule) => {
    let counter = 0;
    const uniqueType = (): string => `kvox.conformance.${Date.now().toString(36)}.${(counter += 1)}`;

    rule('isRegistered is false for an unknown type and true once registered', async (jobs) => {
      const type = uniqueType();
      expect(jobs.port.isRegistered(type)).toBe(false);
      jobs.port.registerHandler({ type, async process() {} });
      expect(jobs.port.isRegistered(type)).toBe(true);
    });

    rule('enqueue returns an id and collapses a repeat of the same type and subject', async (jobs) => {
      const type = uniqueType();
      jobs.port.registerHandler({ type, async process() {} });
      const first = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {} });
      expect(typeof first.id).toBe('string');
      expect(first.deduplicated).toBe(false);
      const second = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {} });
      expect(second.deduplicated).toBe(true);
      expect(second.id).toBe(first.id);
    });

    rule('skipDedup queues a distinct job', async (jobs) => {
      const type = uniqueType();
      jobs.port.registerHandler({ type, async process() {} });
      const first = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {} });
      const second = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: {}, skipDedup: true });
      expect(second.deduplicated).toBe(false);
      expect(second.id === first.id).toBe(false);
    });

    rule('findActive lists the pending jobs of a type, narrowed by subject and by excluded id', async (jobs) => {
      const type = uniqueType();
      jobs.port.registerHandler({ type, async process() {} });
      const one = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: 'a', payload: { key: 'one' } });
      const two = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: 'b', payload: { key: 'two' } });

      const all = await jobs.port.findActive({ types: [type] });
      expect(all.map((job) => job.id).sort()).toEqual([one.id, two.id].sort());

      const bySubject = await jobs.port.findActive({ types: [type], subjectType: 'thing', subjectIds: ['a'] });
      expect(bySubject.map((job) => job.id)).toEqual([one.id]);
      expect(bySubject[0]?.subjectId).toBe('a');

      const excluding = await jobs.port.findActive({ types: [type], excludeJobId: one.id });
      expect(excluding.map((job) => job.id)).toEqual([two.id]);

      const byPayload = await jobs.port.findActive({ types: [type], payloadKey: 'key', payloadValues: ['two'] });
      expect(byPayload.map((job) => job.id)).toEqual([two.id]);

      expect(await jobs.port.findActive({ types: [type], subjectIds: [] })).toEqual([]);

      await jobs.drain();
      expect(await jobs.port.findActive({ types: [type] })).toEqual([]);
    });

    rule('findLatest reports the newest job of a subject and runNow pulls a delayed one forward', async (jobs) => {
      const type = uniqueType();
      jobs.port.registerHandler({ type, async process() {} });
      expect(await jobs.port.findLatest({ type, subjectType: 'thing', subjectId: 'z' })).toBeNull();

      const delayed = await jobs.port.enqueue({
        type,
        subjectType: 'thing',
        subjectId: 'z',
        payload: {},
        scheduledFor: new Date(Date.now() + 3_600_000),
      });
      const before = await jobs.port.findLatest({ type, subjectType: 'thing', subjectId: 'z' });
      expect(before).toMatchObject({ id: delayed.id, status: 'pending' });
      expect(before?.scheduledFor).not.toBeNull();

      expect(await jobs.port.runNow(delayed.id)).toBe(true);
      expect((await jobs.port.findLatest({ type, subjectType: 'thing', subjectId: 'z' }))?.scheduledFor).toBeNull();
      expect(await jobs.port.runNow(delayed.id)).toBe(false);
    });

    rule('onSettled reports a finished job with its type, subject and payload', async (jobs) => {
      const type = uniqueType();
      const seen: Array<{ jobId: string; type: string; status: string; subjectId: string | null; payload: unknown }> = [];
      jobs.port.onSettled((event) => {
        if (event.type === type) seen.push(event);
      });
      jobs.port.registerHandler({ type, async process() {} });
      const queued = await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '9', payload: { n: 9 } });
      await jobs.drain();
      await tick();
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatchObject({ jobId: queued.id, type, status: 'succeeded', subjectId: '9' });
      expect(seen[0]?.payload).toEqual({ n: 9 });
    });

    rule('tempPath answers a distinct path each call and keeps the suffix', async (jobs) => {
      const first = jobs.port.tempPath('.m4a');
      const second = jobs.port.tempPath('.m4a');
      expect(typeof first).toBe('string');
      expect(first.endsWith('.m4a')).toBe(true);
      expect(first === second).toBe(false);
    });

    rule('a registered handler runs each distinct job once', async (jobs) => {
      const type = uniqueType();
      const processed: string[] = [];
      jobs.port.registerHandler({
        type,
        async process(job) {
          processed.push(job.id);
        },
      });
      await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: { n: 1 } });
      await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '1', payload: { n: 1 } });
      await jobs.port.enqueue({ type, subjectType: 'thing', subjectId: '2', payload: { n: 2 } });
      await jobs.drain();
      expect(processed.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  section('identity', 'KVOX_IDENTITY', (rule) => {
    rule('a request with no credentials is null', async (identity) => {
      expect(await identity.port.authenticate(identity.anonymous)).toBeNull();
    });

    rule('a principal has a ReadonlySet of permissions and a roles array', async (identity) => {
      if (!identity.authenticated) return;
      const principal = await identity.port.authenticate(identity.authenticated);
      expect(principal).toBeTruthy();
      expect(typeof principal?.userId).toBe('string');
      expect(principal?.permissions instanceof Set).toBe(true);
      expect(Array.isArray(principal?.roles)).toBe(true);
      expect(principal?.orgId === null || typeof principal?.orgId === 'string').toBe(true);
    });

    rule('hasPermission answers true for a held permission and false for another', async (identity) => {
      if (!identity.authenticated || !identity.permissions) return;
      const principal = await identity.port.authenticate(identity.authenticated);
      expect(await identity.port.hasPermission(principal!.userId, identity.permissions.granted)).toBe(true);
      expect(await identity.port.hasPermission(principal!.userId, identity.permissions.notGranted)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  section('notify', 'KVOX_NOTIFY', (rule) => {
    rule('notify returns at once and never throws, for a known or an unknown event', async (notify) => {
      notify.port.registerEvents([]);
      expect(notify.port.notify('kvox.conformance.unknown_event', 'user-conformance', { n: 1 })).toBe(undefined);
      if (notify.event) {
        expect(notify.port.notify(notify.event.key, notify.event.userId, { n: 1 })).toBe(undefined);
      }
    });
  });

  // ---------------------------------------------------------------------------
  section('events', 'KVOX_EVENTS', (rule) => {
    rule('a subscriber receives an emitted payload until it unsubscribes', async (events) => {
      const received: unknown[] = [];
      const off = events.port.subscribe('kvox.conformance_event', (payload) => {
        received.push(payload);
      });
      events.port.emit('kvox.conformance_event', { n: 1 });
      await tick();
      off();
      events.port.emit('kvox.conformance_event', { n: 2 });
      await tick();
      expect(received).toEqual([{ n: 1 }]);
    });

    rule('emit does not throw when a listener throws', async (events) => {
      const off = events.port.subscribe('kvox.conformance_throwing', () => {
        throw new Error('listener failure');
      });
      expect(events.port.emit('kvox.conformance_throwing', {})).toBe(undefined);
      await tick();
      off();
    });
  });

  // ---------------------------------------------------------------------------
  section('settings', 'KVOX_SETTINGS', (rule) => {
    const declare = (settings: KvoxSettingsUnderTest): void => {
      for (const def of settings.namespaces ?? []) settings.port.registerNamespace(def);
    };

    rule('a system namespace round-trips a patch and advances its version', async (settings) => {
      declare(settings);
      if (!settings.system) return;
      const { name: namespace, patch, actorUserId } = settings.system;
      const before = await settings.port.readSystem<Record<string, unknown>>(namespace);
      const after = await settings.port.patchSystem<Record<string, unknown>>(namespace, patch, { actorUserId });
      expect(after.version).toBeGreaterThan(before.version);
      const read = await settings.port.readSystem<Record<string, unknown>>(namespace);
      for (const [key, value] of Object.entries(patch)) expect(read.value[key]).toEqual(value);
    });

    rule('a user namespace round-trips a patch', async (settings) => {
      declare(settings);
      if (!settings.user) return;
      const { name: namespace, userId, patch } = settings.user;
      await settings.port.patchUser(userId, namespace, patch);
      const read = await settings.port.readUser<Record<string, unknown>>(userId, namespace);
      for (const [key, value] of Object.entries(patch)) expect(read[key]).toEqual(value);
    });
  });

  // ---------------------------------------------------------------------------
  section('secrets', 'KVOX_SECRETS', (rule) => {
    rule('a secret round-trips, and status never returns its material', async (secrets) => {
      const { port, purpose, name: secretName, actorUserId } = secrets;
      const value = 'conformance-secret-value-1234567890';
      port.registerPurpose(purpose, 'Conformance purpose');
      expect((await port.status(purpose, secretName)).configured).toBe(false);
      await port.set(purpose, secretName, value, actorUserId);
      expect(await port.get(purpose, secretName)).toBe(value);
      const status = await port.status(purpose, secretName);
      expect(status.configured).toBe(true);
      expect(JSON.stringify(status).includes(value)).toBe(false);
      await port.delete(purpose, secretName, actorUserId);
      await port.delete(purpose, secretName, actorUserId);
      expect(await port.get(purpose, secretName)).toBeNull();
      expect((await port.status(purpose, secretName)).configured).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  section('audit', 'KVOX_AUDIT', (rule) => {
    rule('record resolves for an event with scalar details', async (audit) => {
      await audit.port.record({
        actorUserId: null,
        action: 'kvox.conformance',
        targetType: 'thing',
        targetId: '1',
        meta: { count: 1, flag: true, note: 'ok' },
      });
    });
  });
}

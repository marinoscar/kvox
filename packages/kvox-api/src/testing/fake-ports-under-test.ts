import { z } from 'zod';

import { createFakeKvoxAi } from './fake-ai.js';
import { createFakeKvoxExecutionContext, createFakeKvoxIdentity, kvoxPrincipal } from './fake-identity.js';
import { createFakeKvoxJobs } from './fake-jobs.js';
import { createInMemoryKvoxObjectStore } from './in-memory-object-store.js';
import {
  createInMemoryKvoxEvents,
  createInMemoryKvoxSecrets,
  createInMemoryKvoxSettings,
  createRecordingKvoxAudit,
  createRecordingKvoxNotify,
} from './recording-ports.js';
import type { KvoxPortsUnderTest } from './conformance.js';

/**
 * Builds the in-memory fakes in the shape {@link describeKvoxPortsConformance}
 * expects: the factory the fakes' own conformance run uses.
 *
 * @returns fresh fakes with every hook wired.
 * @stability experimental
 */
export function createFakeKvoxPortsUnderTest(): KvoxPortsUnderTest {
  const ai = createFakeKvoxAi({
    script: { structured: { ok: true }, chat: [[{ type: 'delta', text: 'Hello' }]] },
  });
  const jobs = createFakeKvoxJobs();
  const notify = createRecordingKvoxNotify();
  const settings = createInMemoryKvoxSettings();
  const principal = kvoxPrincipal({ userId: 'user-conformance', permissions: ['things:read'] });

  return {
    ai: {
      port: ai,
      structured: { schema: z.object({ ok: z.boolean() }), schemaName: 'conformance' },
      failNextWith(errorClass) {
        ai.script.failWith = errorClass;
        return true;
      },
      arrangeTextAfterToolCall() {
        ai.script.failWith = undefined;
        ai.script.chat = [
          [
            { type: 'delta', text: 'Let me look.' },
            { type: 'tool_call', id: 'call-1', name: 'lookup', arguments: {} },
            { type: 'delta', text: 'Text after the call.' },
          ],
        ];
      },
    },
    objectStore: { port: createInMemoryKvoxObjectStore() },
    jobs: { port: jobs, drain: async () => void (await jobs.runAll()) },
    identity: {
      port: createFakeKvoxIdentity({ principal }),
      anonymous: createFakeKvoxExecutionContext(),
      authenticated: createFakeKvoxExecutionContext({ authorization: 'Bearer token' }),
      permissions: { granted: 'things:read', notGranted: 'things:write' },
    },
    notify: { port: notify, event: { key: 'kvox.conformance_event', userId: 'user-conformance' } },
    events: { port: createInMemoryKvoxEvents() },
    settings: {
      port: settings,
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
      system: { name: 'conformance_system', patch: { enabled: true, label: 'x' }, actorUserId: 'user-conformance' },
      user: { name: 'conformance_user', userId: 'user-conformance', patch: { theme: 'dark' } },
    },
    secrets: {
      port: createInMemoryKvoxSecrets(),
      purpose: 'conformance',
      name: 'default',
      actorUserId: 'user-conformance',
    },
    audit: { port: createRecordingKvoxAudit() },
  };
}

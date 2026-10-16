// =============================================================================
// Server-only job types (issue #468)
// =============================================================================
//
// Node eligibility is DERIVED: a handler is eligible only when it carries BOTH
// `nodeResultSchema` and `persistNodeResult`; `JobHandlerRegistry
// .serverOnlyTypes()` is the complement. `JOBS_WORKER_MODE=system` claims
// exactly that list, so a type that is missing from it is a type a worker node
// could be handed.
//
// The AI types (`note.generate`, `ask.respond`, `kg.*`) and the transcription
// provider types are server-only PERMANENTLY: a provider key never reaches a
// node, and no vendor offers a job-scoped sub-key to broker. This spec boots
// the real module graph and asserts that on the registry the worker consults.
//
// The two node-eligible KVox types are asserted on the other side of the line
// so the check cannot pass by emptying the list.
// =============================================================================

import '../../src/kvox.manifest';

import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

/** Server-only for good. Literal strings on purpose: a rename must fail here. */
const MUST_BE_SERVER_ONLY = [
  // AI jobs spend a user's own provider key
  'note.generate',
  'note.retitle',
  'transcript.name_check',
  'ask.respond',
  'kg.extract',
  'kg.resolve',
  'kg.embed',
  'kg.speaker_link',
  'kg.purge',
  'kg.import',
  'kg.export',
  'kg.graph_layout',
  'kg.entity_digest',
  'kg.migrate',
  // transcription provider types carry the provider key
  'transcription.submit',
  'transcription.poll',
  'transcription.ingest',
  // renderers and database work live in the API
  'transcript.export',
  'note.export',
  // deletes a user's objects as it goes (#480); also the user-data purge it is a delegate of
  'files.purge_unmanaged',
  'transcript.purge',
  'note.purge',
  'user.data.purge',
] as const;

const NODE_ELIGIBLE = ['media.audio.transcode', 'note.source.extract'] as const;

describe('server-only job types (issue #468)', () => {
  let context: TestContext;
  let registry: JobHandlerRegistry;

  beforeAll(async () => {
    context = await createTestApp();
    registry = context.module.get(JobHandlerRegistry, { strict: false });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  it.each(MUST_BE_SERVER_ONLY)('%s is in serverOnlyTypes()', (type) => {
    expect(registry.types()).toContain(type);
    expect(registry.serverOnlyTypes()).toContain(type);
  });

  it.each(NODE_ELIGIBLE)('%s is node-eligible, so it is not in serverOnlyTypes()', (type) => {
    expect(registry.types()).toContain(type);
    expect(registry.serverOnlyTypes()).not.toContain(type);
  });

  it('gives no AI or provider-key type a node member', () => {
    for (const type of MUST_BE_SERVER_ONLY) {
      const handler = registry.get(type);

      expect(handler?.nodeResultSchema).toBeUndefined();
      expect(handler?.persistNodeResult).toBeUndefined();
      expect(handler?.nodeSecretBroker).toBeUndefined();
    }
  });
});

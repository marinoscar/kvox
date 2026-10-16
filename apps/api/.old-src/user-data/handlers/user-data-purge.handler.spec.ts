import { withTemporaryEntries } from '../../common/registry/testing';
import { USER_DATA_PURGE_JOB_TYPE } from '../job-types';
import {
  userDataCategoryRegistry,
  userDataScopeRegistry,
  type UserDataCategoryDef,
  type UserDataScopeDef,
} from '../user-data.registries';
import { UserDataPurgeHandler } from './user-data-purge.handler';
import { JobHandlerRegistry } from '@marinoscar/platform-api/jobs';

// =============================================================================
// `user.data.purge` (issue #80) — the Danger Zone's one job
// =============================================================================
//
// Since issue #460 this handler is an ORCHESTRATOR: it knows no domain. Each
// destructive step is a hook declared by the category's own module and
// registered by `kvox.manifest.ts`, so what this file pins is what the handler
// itself still owns:
//
//   1. THE ORDER. The steps run in `purge.order` — ask 10, graph 20,
//      credentials 30, notes 40, transcripts 50, note templates 60, files 70,
//      onboarding 80 — and that order is the FK-clearing order of
//      `docs/specs/user-data-deletion.md` §4, not a stylistic one.
//   2. WHICH STEPS A SCOPE REACHES (the full matrix is `job-types.spec.ts`).
//   3. A HOOK THAT CANNOT BE RESOLVED FAILS THE JOB — before any step runs,
//      and never by skipping its category.
//   4. THE PROFILE and permanent server-only eligibility.
//
// The per-step behaviour (force semantics, FK clearing, batching, fan-out,
// re-entrancy) is pinned beside the code that has it, in each domain's
// `*.user-data.spec.ts` and in `user-data.base.spec.ts`. The hooks here are
// stubs resolved by a fake `ModuleRef`, so this spec imports no domain module.
// =============================================================================

const USER_ID = 'user-1';
const JOB_ID = 'job-1';

/**
 * A stub hook: every method call is recorded as `<token>.<method>` and
 * resolves. A Proxy rather than hand-written stubs so this spec keeps knowing
 * nothing about the domains' method names beyond the order it asserts.
 */
function harness() {
  const calls: string[] = [];
  const stubs = new Map<unknown, unknown>();

  const moduleRef = {
    get: jest.fn((token: unknown) => {
      if (!stubs.has(token)) {
        stubs.set(
          token,
          new Proxy(
            {},
            {
              get: (_target, method) => {
                if (method === 'then') return undefined;
                return async () => {
                  calls.push(`${String(token)}.${String(method)}`);
                };
              },
            },
          ),
        );
      }
      return stubs.get(token);
    }),
  };

  const registry = new JobHandlerRegistry();
  const handler = new UserDataPurgeHandler(registry, moduleRef as never);

  return { handler, registry, moduleRef, calls };
}

const job = (scope: string, overrides: Record<string, unknown> = {}) =>
  ({ id: JOB_ID, payload: { userId: USER_ID, scope, ...overrides } }) as never;

const ASK = 'ASK_USER_DATA_HOOKS.purge';
const GRAPH = 'GRAPH_USER_DATA_HOOKS.purge';
const CREDENTIALS = 'CREDENTIALS_USER_DATA_HOOKS.purge';
const NOTES = 'NOTES_USER_DATA_HOOKS.purgeNotes';
const TRANSCRIPTS = 'TRANSCRIPTS_USER_DATA_HOOKS.purge';
const NOTE_TEMPLATES = 'NOTES_USER_DATA_HOOKS.purgeNoteTemplates';
const FILES = 'FILES_USER_DATA_HOOKS.purge';
const ONBOARDING = 'ONBOARDING_USER_DATA_HOOKS.purge';

// -----------------------------------------------------------------------------
// Registration, profile, and permanent server-only eligibility
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — registration and profile', () => {
  it('registers itself under the permanent type string', () => {
    const { handler, registry } = harness();

    handler.onModuleInit();

    expect(handler.type).toBe(USER_DATA_PURGE_JOB_TYPE);
    expect(registry.get(USER_DATA_PURGE_JOB_TYPE)).toBe(handler);
  });

  it('declares exactly one attempt and a bounded runtime — never auto-retried', () => {
    const { handler } = harness();

    expect(handler.profile).toEqual({
      maxRuntimeMs: 30 * 60_000,
      maxAttempts: 1,
    });
    expect(Object.keys(handler.profile ?? {}).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
  });

  it('is SERVER-ONLY PERMANENTLY — declares neither node member, so no node can ever claim it', () => {
    const { handler, registry } = harness();

    handler.onModuleInit();

    const asRecord = handler as unknown as Record<string, unknown>;
    expect(asRecord.nodeResultSchema).toBeUndefined();
    expect(asRecord.persistNodeResult).toBeUndefined();

    expect(registry.serverOnlyTypes()).toContain(USER_DATA_PURGE_JOB_TYPE);
    expect(registry.types().filter((t) => !registry.serverOnlyTypes().includes(t))).not.toContain(
      USER_DATA_PURGE_JOB_TYPE,
    );
  });

  it('refuses to boot when a scope names a category nothing registered', async () => {
    const { handler, registry } = harness();
    const broken: UserDataScopeDef = {
      id: 'brokenscope',
      label: 'Broken',
      description: 'Names a category nobody registered.',
      categories: ['noSuchCategory'],
      confirmation: 'BROKENSCOPE',
      layer: 'user',
    };

    await withTemporaryEntries(userDataScopeRegistry, [broken], () => {
      expect(() => handler.onModuleInit()).toThrow(/brokenscope.*noSuchCategory/);
    });

    // Nothing was registered by the refused boot.
    expect(registry.get(USER_DATA_PURGE_JOB_TYPE)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// An unreadable payload is a no-op, not a failure
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — an unreadable payload', () => {
  it.each([
    ['null', null],
    ['a string', 'user-1'],
    ['an unknown scope', { userId: USER_ID, scope: 'literally-everything' }],
    ['a missing userId', { scope: 'everything' }],
  ])('returns successfully and resolves no hook for a payload that is %s', async (_label, payload) => {
    const { handler, moduleRef, calls } = harness();

    await expect(handler.process({ id: JOB_ID, payload } as never)).resolves.toBeUndefined();

    expect(moduleRef.get).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Step ordering across the whole run — the FK-clearing order is load-bearing
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — step ordering', () => {
  // ⚠ THE CALL-ORDER SPEC ISSUE #460 REQUIRES. These eight positions are the
  // order `user.data.purge` has always run in; the registry may be composed in
  // any order, this assertion is what stops a `purge.order` edit from
  // reshuffling FK clearing.
  //
  //   • notes before transcripts: a note's `source_transcript_id` is Restrict.
  //   • note templates after notes: `NoteTemplatesService.remove` archives
  //     while a note still names the template.
  //   • files last of the destructive steps, because nothing can point at them.
  //   • ONBOARDING IS LAST, and that position is the assertion. Resetting
  //     first-run state tells the user "you are starting over"; made before the
  //     destruction it narrates, a later step throwing would leave them reading
  //     a fresh-start banner over a library that is still half there.
  it('scope "everything" runs ask, graph, credentials, notes, transcripts, note templates, files, onboarding — in that order', async () => {
    const { handler, calls } = harness();

    await handler.process(job('everything'));

    expect(calls).toEqual([
      ASK,
      GRAPH,
      CREDENTIALS,
      NOTES,
      TRANSCRIPTS,
      NOTE_TEMPLATES,
      FILES,
      ONBOARDING,
    ]);
  });

  it('scope "content" is the same sequence without credentials and onboarding', async () => {
    const { handler, calls } = harness();

    await handler.process(job('content'));

    expect(calls).toEqual([ASK, GRAPH, NOTES, TRANSCRIPTS, NOTE_TEMPLATES, FILES]);
  });

  it.each([
    ['transcripts', [TRANSCRIPTS]],
    ['notes', [NOTES]],
    ['files', [FILES]],
  ])('narrow scope "%s" reaches exactly its own category', async (scope, expected) => {
    const { handler, calls } = harness();

    await handler.process(job(scope));

    expect(calls).toEqual(expected);
  });

  it('never reaches note templates, the graph, Ask, credentials or onboarding from a narrow scope', async () => {
    for (const scope of ['transcripts', 'notes', 'files']) {
      const { handler, calls } = harness();

      await handler.process(job(scope));

      for (const forbidden of [NOTE_TEMPLATES, GRAPH, ASK, CREDENTIALS, ONBOARDING]) {
        expect(calls).not.toContain(forbidden);
      }
    }
  });

  it('stops at the first step that throws — nothing after it runs', async () => {
    const { handler, calls, moduleRef } = harness();
    const failure = new Error('simulated step failure');

    // The notes step is the 4th of 8; make its hook throw when called.
    const original = moduleRef.get.getMockImplementation() as (token: unknown) => unknown;
    moduleRef.get.mockImplementation((token: unknown) => {
      const stub = original(token) as Record<string, (...args: unknown[]) => Promise<void>>;
      if (token !== 'NOTES_USER_DATA_HOOKS') return stub;
      return {
        purgeNotes: async () => {
          calls.push(NOTES);
          throw failure;
        },
      };
    });

    await expect(handler.process(job('everything'))).rejects.toBe(failure);

    expect(calls).toEqual([ASK, GRAPH, CREDENTIALS, NOTES]);
  });

  it('hands every step the user id and the job context (job id and scope)', async () => {
    const { handler } = harness();
    const run = jest.fn().mockResolvedValue(undefined);
    const synthetic: UserDataCategoryDef = {
      id: 'zzSpecCategory',
      label: 'Spec',
      description: 'A category that only this spec registers.',
      content: true,
      purge: { order: 9_999, inject: 'ZZ_SPEC_HOOKS', run },
    };

    await withTemporaryEntries(userDataCategoryRegistry, [synthetic], async () => {
      await handler.process(job('content'));
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.anything(), USER_ID, {
      jobId: JOB_ID,
      scope: 'content',
    });
  });
});

// -----------------------------------------------------------------------------
// A hook that cannot be resolved FAILS the job — it is never skipped
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — an unresolved hook fails the job', () => {
  it('throws, naming the hook and its category, when the provider cannot be found', async () => {
    const { handler, moduleRef } = harness();

    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === 'GRAPH_USER_DATA_HOOKS') {
        throw new Error('Nest could not find GRAPH_USER_DATA_HOOKS');
      }
      return {};
    });

    await expect(handler.process(job('everything'))).rejects.toThrow(
      /GRAPH_USER_DATA_HOOKS.*category "graph".*could not be resolved/,
    );
  });

  it('treats a provider that resolves to nothing the same way', async () => {
    const { handler, moduleRef } = harness();

    moduleRef.get.mockImplementation((token: unknown) =>
      token === 'FILES_USER_DATA_HOOKS' ? undefined : {},
    );

    await expect(handler.process(job('files'))).rejects.toThrow(
      /FILES_USER_DATA_HOOKS.*category "files".*could not be resolved/,
    );
  });

  // ⚠ RESOLVED BEFORE THE FIRST DESTRUCTIVE STEP, so a missing late hook cannot
  // leave the user with half a deletion that then reports `failed` for a reason
  // that was knowable up front.
  it('fails BEFORE any step has run, even when the missing hook belongs to the last step', async () => {
    const { handler, moduleRef, calls } = harness();
    const original = moduleRef.get.getMockImplementation() as (token: unknown) => unknown;

    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === 'ONBOARDING_USER_DATA_HOOKS') throw new Error('not provided');
      return original(token);
    });

    await expect(handler.process(job('everything'))).rejects.toThrow(/ONBOARDING_USER_DATA_HOOKS/);

    // Not even the first step (ask) ran.
    expect(calls).toEqual([]);
  });

  it('does not require a hook the scope does not reach', async () => {
    const { handler, moduleRef, calls } = harness();
    const original = moduleRef.get.getMockImplementation() as (token: unknown) => unknown;

    moduleRef.get.mockImplementation((token: unknown) => {
      if (token === 'GRAPH_USER_DATA_HOOKS') throw new Error('graph is not provided here');
      return original(token);
    });

    await expect(handler.process(job('notes'))).resolves.toBeUndefined();

    expect(calls).toEqual([NOTES]);
  });
});

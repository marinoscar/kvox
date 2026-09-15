import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { NOTE_RETITLE_JOB_TYPE } from '../job-types';
import {
  NOTE_RETITLE_MAX_RUNTIME_MS,
  NoteRetitleHandler,
  readForce,
} from './note-retitle.handler';

// =============================================================================
// `note.retitle` (issue #184, epic #163)
// =============================================================================
//
// The properties this file exists to pin, mirroring the house style
// `note-purge.handler.spec.ts` and `note-generate.handler.spec.ts` set:
//
//   1. Registration under the permanent type string, `maxAttempts: 1`.
//   2. SERVER-ONLY, PERMANENTLY — neither node member is declared, so no node
//      can ever claim this type.
//   3. Four skips, all returning normally with no call to `titleNote` — a
//      note this handler is asked about may have moved on since it was
//      queued, and none of the four is an error.
//   4. The sticky `titleSource: 'user'` guard is checked HERE, before
//      `titleNote` is ever called, so a hand-named note costs no provider
//      call when it is swept in bulk — `force` is the one thing that lifts it.
//   5. `provider`/`model` pass straight through, nulls included — this file
//      never invents a default to bill someone's account against.
//   6. The payload reader (`readForce`) is total: anything that is not
//      literally `true` is `false`, which is the side with no undo.
//   7. The handler registers ITS OWN type as `titleNote`'s `jobType`, so the
//      per-user throttle a 429 trips holds back `note.retitle`, not
//      `note.generate`.
// =============================================================================

const NOTE_ID = 'note-1';
const OWNER_ID = 'owner-1';
const JOB_ID = 'job-1';

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  ownerId: OWNER_ID,
  body: 'Ana: we ship on Friday.',
  status: 'ready',
  titleSource: 'template',
  deletedAt: null,
  provider: 'openai',
  model: 'gpt-4o',
  ...overrides,
});

describe('NoteRetitleHandler', () => {
  let handler: NoteRetitleHandler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let titles: { titleNote: jest.Mock };
  let registry: { register: jest.Mock };

  const job = (payload: unknown = { noteId: NOTE_ID }) => ({ id: JOB_ID, payload }) as never;

  beforeEach(() => {
    prisma = {
      note: {
        findUnique: jest.fn().mockResolvedValue(noteRow()),
      },
    };
    titles = { titleNote: jest.fn().mockResolvedValue('A proposed title') };
    registry = { register: jest.fn() };

    handler = new NoteRetitleHandler(registry as never, prisma as never, titles as never);
  });

  // ---------------------------------------------------------------------------
  // Registration and shape
  // ---------------------------------------------------------------------------

  describe('registration and profile', () => {
    it('registers itself under the permanent type string', () => {
      handler.onModuleInit();

      expect(registry.register).toHaveBeenCalledWith(handler);
      expect(handler.type).toBe(NOTE_RETITLE_JOB_TYPE);
      expect(handler.type).toBe('note.retitle');
    });

    it('declares ONE attempt and a two-minute ceiling', () => {
      expect(handler.profile).toEqual({
        maxRuntimeMs: NOTE_RETITLE_MAX_RUNTIME_MS,
        maxAttempts: 1,
      });
      expect(handler.profile?.maxAttempts).toBe(1);
      expect(NOTE_RETITLE_MAX_RUNTIME_MS).toBe(2 * 60 * 1000);
    });

    it('carries no lease or heartbeat of its own — both are derived from maxRuntimeMs', () => {
      expect(Object.keys(handler.profile ?? {}).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
    });

    it('is SERVER-ONLY: neither nodeResultSchema nor persistNodeResult is declared', () => {
      const asHandler: JobHandler = handler;

      expect(asHandler.nodeResultSchema).toBeUndefined();
      expect(asHandler.persistNodeResult).toBeUndefined();
      expect(asHandler.nodeSecretBroker).toBeUndefined();
    });

    it('is absent from the registry\'s node-eligible types once registered', () => {
      const realRegistry = new JobHandlerRegistry();
      const registered = new NoteRetitleHandler(realRegistry, prisma as never, titles as never);

      registered.onModuleInit();

      expect(realRegistry.serverOnlyTypes()).toContain(NOTE_RETITLE_JOB_TYPE);
      expect(
        realRegistry.types().filter((type) => !realRegistry.serverOnlyTypes().includes(type)),
      ).not.toContain(NOTE_RETITLE_JOB_TYPE);
    });
  });

  // ---------------------------------------------------------------------------
  // The four skips — all return normally, none calls titleNote
  // ---------------------------------------------------------------------------

  describe('process — four ordinary skips', () => {
    it('the note is gone', async () => {
      prisma.note.findUnique.mockResolvedValue(null);

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(titles.titleNote).not.toHaveBeenCalled();
    });

    it('the note is soft-deleted', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ deletedAt: new Date() }));

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(titles.titleNote).not.toHaveBeenCalled();
    });

    it('the note status is "deleting"', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ status: 'deleting' }));

      await expect(handler.process(job())).resolves.toBeUndefined();

      expect(titles.titleNote).not.toHaveBeenCalled();
    });

    it.each([['draft'], ['generating'], ['failed']])(
      'the note status is "%s", not "ready"',
      async (status) => {
        prisma.note.findUnique.mockResolvedValue(noteRow({ status }));

        await expect(handler.process(job())).resolves.toBeUndefined();

        expect(titles.titleNote).not.toHaveBeenCalled();
      },
    );
  });

  // ---------------------------------------------------------------------------
  // The sticky `titleSource: 'user'` guard, checked before `titleNote`
  // ---------------------------------------------------------------------------

  describe('process — a user-chosen title', () => {
    it('is left alone WITHOUT `force`, and costs no provider call at all', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ titleSource: 'user' }));

      await handler.process(job({ noteId: NOTE_ID }));

      // ⚠ The assertion: the handler's own check skips the note before
      // `NoteTitleService.titleNote` (and therefore any provider call) is
      // ever reached — this is the check that keeps a sweep over a mostly
      // hand-named library free, not merely the service's own race guard.
      expect(titles.titleNote).not.toHaveBeenCalled();
    });

    it('IS retitled when the payload carries `force: true`', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ titleSource: 'user' }));

      await handler.process(job({ noteId: NOTE_ID, force: true }));

      expect(titles.titleNote).toHaveBeenCalledWith(
        expect.objectContaining({ noteId: NOTE_ID, force: true }),
      );
    });

    it('a non-"user" titleSource is retitled regardless of `force`', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ titleSource: 'template' }));

      await handler.process(job({ noteId: NOTE_ID }));

      expect(titles.titleNote).toHaveBeenCalledWith(
        expect.objectContaining({ noteId: NOTE_ID, force: false }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // provider/model pass straight through, nulls included
  // ---------------------------------------------------------------------------

  describe('process — provider and model', () => {
    it('passes a null provider/model straight through rather than defaulting them', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ provider: null, model: null }));

      await handler.process(job());

      expect(titles.titleNote).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: null, model: null }),
      );
    });

    it('passes the note\'s real provider/model through when present', async () => {
      prisma.note.findUnique.mockResolvedValue(
        noteRow({ provider: 'anthropic', model: 'claude-x' }),
      );

      await handler.process(job());

      expect(titles.titleNote).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'anthropic', model: 'claude-x' }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // The handler passes its own type as `jobType`
  // ---------------------------------------------------------------------------

  describe('process — the throttle mapping', () => {
    it('passes its own `type` as `titleNote`\'s `jobType`', async () => {
      await handler.process(job());

      expect(titles.titleNote).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: NOTE_RETITLE_JOB_TYPE }),
      );
      expect(titles.titleNote).toHaveBeenCalledWith(
        expect.objectContaining({ jobType: handler.type }),
      );
    });

    it('never registers `note.generate` as the jobType', async () => {
      await handler.process(job());

      const [[input]] = titles.titleNote.mock.calls;

      expect(input.jobType).not.toBe('note.generate');
    });
  });

  // ---------------------------------------------------------------------------
  // `readForce` — total over garbage, and the safe side has no undo
  // ---------------------------------------------------------------------------

  describe('readForce', () => {
    it('is true only for the literal boolean `true`', () => {
      expect(readForce({ force: true })).toBe(true);
    });

    it.each([
      ['the string "true"', { force: 'true' }],
      ['the number 1', { force: 1 }],
      ['an object', { force: {} }],
      ['an array', { force: [] }],
      ['false', { force: false }],
      ['undefined (absent)', {}],
    ])('is false for %s', (_label, payload) => {
      expect(readForce(payload)).toBe(false);
    });

    it('is false for a payload that is not an object at all', () => {
      expect(readForce(null)).toBe(false);
      expect(readForce('note-1' as never)).toBe(false);
      expect(readForce(7 as never)).toBe(false);
      expect(readForce(['note-1'] as never)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // The payload reader is total over garbage for `noteId` too
  // ---------------------------------------------------------------------------

  describe('process — a payload with no usable note id', () => {
    it.each([
      ['missing entirely', {}],
      ['a non-string', { noteId: 7 }],
      ['an empty string', { noteId: '' }],
      ['null', null],
      ['an array', ['note-1']],
    ])('is a no-op for a payload that is %s', async (_label, payload) => {
      await expect(handler.process(job(payload))).resolves.toBeUndefined();

      expect(prisma.note.findUnique).not.toHaveBeenCalled();
      expect(titles.titleNote).not.toHaveBeenCalled();
    });

    it('a garbage `force` alongside a real note id still lands on the safe side for a user title', async () => {
      prisma.note.findUnique.mockResolvedValue(noteRow({ titleSource: 'user' }));

      await handler.process(job({ noteId: NOTE_ID, force: 'true' }));

      // The string "true" is not the literal boolean `true` — the note's own
      // chosen title must be left alone, exactly as if `force` were absent.
      expect(titles.titleNote).not.toHaveBeenCalled();
    });
  });
});

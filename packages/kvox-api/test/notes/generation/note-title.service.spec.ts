import { KvoxAiError } from '../../../src/ports/index.js';
import { createFakeKvoxAi, type FakeKvoxAi, type FakeKvoxAiScript } from '../../../src/testing/index.js';
import { MAX_TITLE_CHARS } from '../../../src/notes/dto/note.dto.js';
import {
  buildTitleUserContent,
  NoteTitleService,
  sanitizeModelTitle,
  TITLE_EXCERPT_CHARS,
  type TitleNoteInput,
} from '../../../src/notes/generation/note-title.service.js';

// =============================================================================
// NoteTitleService (issue #182, epic #163; the `Title:` fix is issue #182's
// own regression, landed in a follow-up commit — see the test named for it
// below)
// =============================================================================
//
// Three properties this file exists to pin, in order of how expensive getting
// them wrong would be:
//
//   1. `titleNote` NEVER THROWS, for ANY reason rank 1 can fail — including a
//      429, which everywhere else in this codebase IS rethrown. The note is
//      already committed and durable by the time this runs; an exception here
//      would turn a successful generation into a failed job.
//   2. `titleSource: 'user'` is sticky, checked once on read and AGAIN in the
//      UPDATE's own WHERE clause, so a rename that lands mid-flight wins the
//      race rather than losing to a titling pass that started before it.
//   3. `sanitizeModelTitle`'s `Title:` stripping requires a separator
//      (`:`/`-`/`—`/`–`) between the label and the rest — an optional one
//      would also match a real title's first word, e.g. `Title Deeds
//      Explained`.
// =============================================================================

const PROVIDER_ID = 'openai';
const MODEL = 'gpt-4o';
const OWNER_ID = 'user-1';
const NOTE_ID = 'note-1';

/** A model that answers with `text`, reporting the provider's own counts. */
function answering(text: string): FakeKvoxAi {
  return createFakeKvoxAi({ script: { text } });
}

/** The number of calls a fake received for one port method. */
function callsOf(ai: FakeKvoxAi, method: string) {
  return ai.calls.filter((call) => call.method === method);
}

/** A model whose call fails with `error`. */
function throwing(error: KvoxAiError, where: 'resolveTask' | 'generateText' = 'generateText'): FakeKvoxAi {
  const ai = createFakeKvoxAi();

  if (where === 'resolveTask') {
    ai.script = { failWith: error };
  } else {
    // eslint-disable-next-line require-yield
    ai.generateText = async function* () {
      throw error;
    };
  }

  return ai;
}

/** A fake whose `resolveTask` refuses with an error of the given class. */
function refusing(errorClass: FakeKvoxAiScript['failWith']): FakeKvoxAi {
  return createFakeKvoxAi({ script: { failWith: errorClass } });
}

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  title: 'Meeting notes',
  titleSource: 'template',
  status: 'ready',
  deletedAt: null,
  ...overrides,
});

interface HarnessOptions {
  ai?: FakeKvoxAi;
  /** `undefined` uses the default row; pass `null` to simulate a vanished note. */
  note?: Record<string, unknown> | null;
  updateManyCount?: number;
  /** What a re-read after a lost `updateMany` race finds. `undefined` → the row is gone. */
  afterRaceTitle?: string | null;
}

function harness(options: HarnessOptions = {}) {
  const findUnique = jest.fn().mockResolvedValueOnce(
    options.note === undefined ? noteRow() : options.note,
  );

  if (options.afterRaceTitle !== undefined) {
    findUnique.mockResolvedValueOnce(
      options.afterRaceTitle === null ? null : { title: options.afterRaceTitle },
    );
  }

  const prisma = {
    note: {
      findUnique,
      updateMany: jest.fn().mockResolvedValue({ count: options.updateManyCount ?? 1 }),
    },
  };

  const ai = options.ai ?? answering('Q3 revenue review');
  const service = new NoteTitleService(prisma as never, ai);

  return { service, prisma, ai };
}

function input(overrides: Partial<TitleNoteInput> = {}): TitleNoteInput {
  return {
    noteId: NOTE_ID,
    ownerId: OWNER_ID,
    body: '# Q3 Revenue Review\n\nRevenue grew across every segment this quarter.',
    providerId: PROVIDER_ID,
    model: MODEL,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// A user-chosen title is never overwritten
// -----------------------------------------------------------------------------

describe('titleNote — a user-chosen title is never overwritten', () => {
  it('returns the existing title and performs no update, without ever calling the model', () => {
    const ai = answering('Should never be asked');
    const { service, prisma } = harness({
      ai,
      note: noteRow({ title: 'My own name for this', titleSource: 'user' }),
    });

    return service.titleNote(input()).then((result) => {
      expect(result).toBe('My own name for this');
      expect(prisma.note.updateMany).not.toHaveBeenCalled();
      expect(callsOf(ai, 'generateText')).toHaveLength(0);
    });
  });
});

// -----------------------------------------------------------------------------
// `force` (#184): the one caller that may rename a note titled by its owner
// -----------------------------------------------------------------------------

describe('titleNote — `force: true` on a `titleSource: "user"` note', () => {
  it('proceeds to rename it, unlike the default', async () => {
    const ai = answering('A suggested title');
    const { service, prisma } = harness({
      ai,
      note: noteRow({ title: 'My own name for this', titleSource: 'user' }),
    });

    const result = await service.titleNote(input({ force: true }));

    expect(result).toBe('A suggested title');
    expect(callsOf(ai, 'generateText')).toHaveLength(1);
    expect(prisma.note.updateMany).toHaveBeenCalled();
  });

  it('the updateMany WHERE clause OMITS `titleSource: { not: "user" }` — the half that is easy to half-fix', async () => {
    const ai = answering('A suggested title');
    const { service, prisma } = harness({
      ai,
      note: noteRow({ title: 'My own name for this', titleSource: 'user' }),
    });

    await service.titleNote(input({ force: true }));

    // ⚠ Asserted on the ACTUAL WHERE ARGUMENT, not on the return value alone.
    // Relaxing only the early return above and leaving this clause in place
    // would pass a return-value-only test while silently spending the user's
    // tokens and writing NOTHING — `updateMany.count` would be 0 and the
    // caller would never know why the title never changed. That is the
    // regression this test is written to catch by name.
    const [args] = prisma.note.updateMany.mock.calls[0];

    expect(args.where).toEqual({ id: NOTE_ID, deletedAt: null });
    expect(args.where).not.toHaveProperty('titleSource');
  });

  it('still guards `deletedAt: null` under force — no flag makes a row on its way out writable', async () => {
    const ai = answering('A suggested title');
    const { service, prisma } = harness({
      ai,
      note: noteRow({ title: 'My own name for this', titleSource: 'user' }),
    });

    await service.titleNote(input({ force: true }));

    const [args] = prisma.note.updateMany.mock.calls[0];

    expect(args.where.deletedAt).toBeNull();
  });
});

describe('titleNote — `force: false` or absent keeps both halves of the guard exactly as they were', () => {
  it('force: false behaves identically to omitting it: the early return still applies to a user title', async () => {
    const ai = answering('Should never be asked');
    const { service, prisma } = harness({
      ai,
      note: noteRow({ title: 'My own name for this', titleSource: 'user' }),
    });

    const result = await service.titleNote(input({ force: false }));

    expect(result).toBe('My own name for this');
    expect(prisma.note.updateMany).not.toHaveBeenCalled();
    expect(callsOf(ai, 'generateText')).toHaveLength(0);
  });

  it('force: false still carries `titleSource: { not: "user" }` in the updateMany WHERE clause', async () => {
    const { service, prisma } = harness();

    await service.titleNote(input({ force: false }));

    const [args] = prisma.note.updateMany.mock.calls[0];

    expect(args.where).toEqual({ id: NOTE_ID, deletedAt: null, titleSource: { not: 'user' } });
  });

  it('force left absent (undefined) behaves identically to `force: false`', async () => {
    const { service, prisma } = harness();

    await service.titleNote(input());

    const [args] = prisma.note.updateMany.mock.calls[0];

    expect(args.where).toEqual({ id: NOTE_ID, deletedAt: null, titleSource: { not: 'user' } });
  });
});

// -----------------------------------------------------------------------------
// A note on its way out is left alone
// -----------------------------------------------------------------------------

describe('titleNote — a deleted note is not titled', () => {
  it('leaves a soft-deleted note untouched', async () => {
    const { service, prisma } = harness({ note: noteRow({ deletedAt: new Date() }) });

    const result = await service.titleNote(input());

    expect(result).toBe('Meeting notes');
    expect(prisma.note.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a note whose status is "deleting" untouched', async () => {
    const { service, prisma } = harness({ note: noteRow({ status: 'deleting' }) });

    const result = await service.titleNote(input());

    expect(result).toBe('Meeting notes');
    expect(prisma.note.updateMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Rank 1 succeeds
// -----------------------------------------------------------------------------

describe('titleNote — rank 1 succeeds', () => {
  it('updates the note with the model-proposed title and titleSource "ai"', async () => {
    const ai = answering('Q3 revenue jumps across every region');
    const { service, prisma } = harness({ ai });

    const result = await service.titleNote(input());

    expect(result).toBe('Q3 revenue jumps across every region');
    expect(callsOf(ai, 'generateText')).toHaveLength(1);
    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { id: NOTE_ID, deletedAt: null, titleSource: { not: 'user' } },
      data: { title: 'Q3 revenue jumps across every region', titleSource: 'ai' },
    });
  });
});

// -----------------------------------------------------------------------------
// Every rank-1 failure falls through to rank 2, and never throws
// -----------------------------------------------------------------------------

describe('titleNote — every rank-1 failure falls through to rank 2 and never throws', () => {
  // Every scenario below is given a body whose heading rank 2 can find, so a
  // successful fallthrough is distinguishable from an accidental rank 3.
  const FALLBACK_BODY = '# Fallback Heading\n\nSome ordinary prose follows it.';

  async function expectFallthrough(options: HarnessOptions) {
    const { service, prisma } = harness(options);

    const result = await service.titleNote(input({ body: FALLBACK_BODY }));

    expect(result).toBe('Fallback Heading');
    expect(prisma.note.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { title: 'Fallback Heading', titleSource: 'ai' } }),
    );
  }

  it('AI switched off for the deployment', async () => {
    await expectFallthrough({ ai: refusing('not_configured') });
  });

  it('a model no longer enabled for this deployment', async () => {
    await expectFallthrough({ ai: refusing('capability') });
  });

  it('no saved API key', async () => {
    await expectFallthrough({ ai: refusing('key_missing') });
  });

  it('a note that names no provider or model', async () => {
    const { service, prisma, ai } = harness();

    const result = await service.titleNote(input({ body: FALLBACK_BODY, providerId: null, model: null }));

    expect(result).toBe('Fallback Heading');
    expect(callsOf(ai, 'resolveTask')).toHaveLength(0);
    expect(prisma.note.updateMany).toHaveBeenCalled();
  });

  it('the provider throwing AiAuthError', async () => {
    await expectFallthrough({ ai: throwing(new KvoxAiError('auth', 'bad key')) });
  });

  it('the provider throwing RateLimitError — the one an unwary reader would expect to be rethrown', async () => {
    const ai = throwing(new KvoxAiError('rate_limit', 'slow down', 1000));

    // Not `.rejects` — this is the whole point of the test. Everywhere else in
    // this codebase a `RateLimitError` propagates so the queue can defer the
    // job; here it must be caught and swallowed like any other rank-1 failure.
    await expectFallthrough({ ai });
  });

  it('a content-policy refusal', async () => {
    await expectFallthrough({ ai: throwing(new KvoxAiError('refusal', 'declined')) });
  });

  it('a generic Error', async () => {
    await expectFallthrough({ ai: throwing(new KvoxAiError('other', 'the vendor is down')) });
  });
});

// -----------------------------------------------------------------------------
// Rank 3: nothing usable anywhere
// -----------------------------------------------------------------------------

describe('titleNote — rank 3: nothing usable', () => {
  it('leaves the title untouched when the body has no heading and no sentence, and rank 1 also fails', async () => {
    const { service, prisma } = harness({ ai: throwing(new KvoxAiError('other', 'the vendor is down')) });

    const result = await service.titleNote(
      input({ body: '```\ncode only, no prose\n```' }),
    );

    expect(result).toBe('Meeting notes');
    expect(prisma.note.updateMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// The concurrency guard
// -----------------------------------------------------------------------------

describe('titleNote — the WHERE clause is the real guard against a concurrent rename', () => {
  it('carries `titleSource: { not: "user" }` in the updateMany, not just in an earlier `if`', async () => {
    const { service, prisma } = harness();

    await service.titleNote(input());

    const [args] = prisma.note.updateMany.mock.calls[0];

    expect(args.where).toEqual({ id: NOTE_ID, deletedAt: null, titleSource: { not: 'user' } });
  });

  it('discards the proposal and re-reads the row when updateMany changes nothing', async () => {
    const { service, prisma } = harness({
      updateManyCount: 0,
      afterRaceTitle: 'Renamed while the model was thinking',
    });

    const result = await service.titleNote(input({ body: '# New Heading\n\nProse.' }));

    expect(result).toBe('Renamed while the model was thinking');
    expect(prisma.note.findUnique).toHaveBeenCalledTimes(2);
  });

  it('returns null when the race loser re-reads a row that is simply gone', async () => {
    const { service } = harness({ updateManyCount: 0, afterRaceTitle: null });

    const result = await service.titleNote(input({ body: '# New Heading\n\nProse.' }));

    expect(result).toBeNull();
  });
});

describe('titleNote — no write when nothing would change', () => {
  it('writes nothing when the proposed title equals the title the note already has', async () => {
    const ai = answering('Meeting notes');
    const { service, prisma } = harness({ ai });

    const result = await service.titleNote(input());

    expect(result).toBe('Meeting notes');
    expect(prisma.note.updateMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// The outermost backstop
// -----------------------------------------------------------------------------

describe('titleNote — the outermost backstop', () => {
  it('swallows an error from something this file did not anticipate (e.g. the initial read itself failing) and returns null', async () => {
    const prisma = {
      note: {
        findUnique: jest.fn().mockRejectedValue(new Error('connection reset')),
        updateMany: jest.fn(),
      },
    };
    const service = new NoteTitleService(prisma as never, answering('unused'));

    await expect(service.titleNote(input())).resolves.toBeNull();
    expect(prisma.note.updateMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// The call rank 1 makes through the port
// -----------------------------------------------------------------------------

describe('titleNote — the titling call', () => {
  it('is a notes.title call on the owner\'s account, with no reasoning and a tiny ceiling', async () => {
    const { service, ai } = harness();

    await service.titleNote(input({ jobId: 'job-9' }));

    const call = callsOf(ai, 'generateText').at(-1);
    const request = call?.req as { target: { model: string; reasoningEffort?: string }; maxOutputTokens: number };

    expect(call?.ctx).toMatchObject({ userId: OWNER_ID, orgId: null, feature: 'notes.title' });
    expect(call?.ctx?.signal).toBeInstanceOf(AbortSignal);
    expect(request.target).toMatchObject({ model: MODEL, reasoningEffort: 'none' });
    expect(request.maxOutputTokens).toBe(32);
    expect(callsOf(ai, 'resolveTask').at(-1)).toMatchObject({
      ctx: { userId: OWNER_ID, feature: 'notes.title' },
      req: { task: 'notes.title', model: MODEL },
    });
  });

  it('never asks for more output than the model itself produces', async () => {
    const { service, ai } = harness({ ai: createFakeKvoxAi({ script: { text: 'A title', target: { maxOutputTokens: 8 } } }) });

    await service.titleNote(input());

    expect((callsOf(ai, 'generateText').at(-1)?.req as { maxOutputTokens: number }).maxOutputTokens).toBe(8);
  });

  it('spends nothing when the port refuses to resolve the task (the title falls back to rank 2)', async () => {
    const { service, ai } = harness({ ai: refusing('key_missing') });

    await service.titleNote(input());

    expect(callsOf(ai, 'generateText')).toHaveLength(0);
  });
});

// =============================================================================
// buildTitleUserContent — pure
// =============================================================================

describe('buildTitleUserContent', () => {
  it('sends the body, trimmed, prefixed with a label', () => {
    expect(buildTitleUserContent('  hello there  ')).toBe('Document:\n\nhello there');
  });

  it('sends at most TITLE_EXCERPT_CHARS of the body', () => {
    const body = 'a'.repeat(3_000);

    expect(buildTitleUserContent(body)).toBe(`Document:\n\n${'a'.repeat(TITLE_EXCERPT_CHARS)}`);
  });
});

// =============================================================================
// sanitizeModelTitle — pure
// =============================================================================

describe('sanitizeModelTitle', () => {
  it('passes a plain answer through unchanged', () => {
    expect(sanitizeModelTitle('Q3 revenue review')).toBe('Q3 revenue review');
  });

  it('strips surrounding straight quotes', () => {
    expect(sanitizeModelTitle('"Q3 revenue review"')).toBe('Q3 revenue review');
    expect(sanitizeModelTitle("'Q3 revenue review'")).toBe('Q3 revenue review');
  });

  it('strips surrounding curly quotes', () => {
    expect(sanitizeModelTitle('“Q3 revenue review”')).toBe('Q3 revenue review');
  });

  it('strips surrounding guillemets', () => {
    expect(sanitizeModelTitle('«Q3 revenue review»')).toBe('Q3 revenue review');
  });

  it('strips a leading Markdown heading marker', () => {
    expect(sanitizeModelTitle('# Q3 revenue review')).toBe('Q3 revenue review');
  });

  it('takes the first non-empty line of a multi-line answer', () => {
    expect(sanitizeModelTitle('Q3 revenue review\nHere is why I chose that...')).toBe(
      'Q3 revenue review',
    );
    expect(sanitizeModelTitle('\n\nQ3 revenue review\nmore text')).toBe('Q3 revenue review');
  });

  it.each([
    ['Title: Q3 revenue', 'a colon separator'],
    ['Title - Q3 revenue', 'a hyphen separator'],
    ['Title — Q3 revenue', 'an em dash separator'],
    ['Title:Q3 revenue', 'no space around the separator'],
    ['"Title: Q3 revenue"', 'the whole labelled answer wrapped in quotes'],
  ])('strips a "Title" label — %s (%s)', (answer) => {
    expect(sanitizeModelTitle(answer)).toBe('Q3 revenue');
  });

  it('strips the label pass twice, so a label INSIDE quotes also comes out clean', () => {
    expect(sanitizeModelTitle('Title: "Q3 revenue"')).toBe('Q3 revenue');
  });

  it('does NOT strip "Title Deeds Explained" — the separator is mandatory precisely so a real title keeping its first word cannot be amputated (regression test for 7f86ff5)', () => {
    expect(sanitizeModelTitle('Title Deeds Explained')).toBe('Title Deeds Explained');
  });

  it('leaves "Titles of nobility" untouched — "Titles" is not the word "Title"', () => {
    expect(sanitizeModelTitle('Titles of nobility')).toBe('Titles of nobility');
  });

  it('is null for an answer that is only a label', () => {
    expect(sanitizeModelTitle('Title:')).toBeNull();
    expect(sanitizeModelTitle('Title: ')).toBeNull();
  });

  it('is null for an answer that is only quotes', () => {
    expect(sanitizeModelTitle('""')).toBeNull();
    expect(sanitizeModelTitle("''")).toBeNull();
  });

  it('is null for an empty answer', () => {
    expect(sanitizeModelTitle('')).toBeNull();
    expect(sanitizeModelTitle('   ')).toBeNull();
  });

  it('truncates an over-long answer to MAX_TITLE_CHARS, including the ellipsis', () => {
    const result = sanitizeModelTitle('x'.repeat(250));

    expect(result).not.toBeNull();
    expect(result?.length).toBe(MAX_TITLE_CHARS);
    expect(result?.endsWith('…')).toBe(true);
  });
});

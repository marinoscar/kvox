// =============================================================================
// TranscriptNameCheckService (issues #328 and #330, epic #326)
// =============================================================================

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { NAME_CHECK_CONFLICT_REASONS } from './dto/transcript-name-check.dto';
import { TRANSCRIPT_NAME_CHECK_JOB_TYPE } from './job-types';
import {
  resolveTerms,
  toRunView,
  TranscriptNameCheckService,
} from './transcript-name-check.service';

// -----------------------------------------------------------------------------
// resolveTerms — pure
// -----------------------------------------------------------------------------

describe('resolveTerms', () => {
  const speakers = [
    { id: 's-a', label: 'A', displayName: 'Speaker A' },
    { id: 's-b', label: 'B', displayName: 'Oscar' },
    { id: 's-c', label: null, displayName: 'Unknown speaker' },
  ];

  it('skips a speaker still carrying a generic "Speaker A" name', () => {
    const out = resolveTerms({ speakers, providerOptions: {} });
    expect(out).not.toContain('Speaker A');
  });

  it('skips a speaker named "Unknown" (and similar)', () => {
    const out = resolveTerms({ speakers, providerOptions: {} });
    expect(out).not.toContain('Unknown speaker');
  });

  it('skips a speaker whose display name still equals their raw provider label', () => {
    // label 'B' equals display name 'B' — never renamed.
    const out = resolveTerms({
      speakers: [{ id: 's-x', label: 'B', displayName: 'B' }],
      providerOptions: {},
    });
    expect(out).toEqual([]);
  });

  it('includes a speaker with a real display name', () => {
    const out = resolveTerms({ speakers, providerOptions: {} });
    expect(out).toContain('Oscar');
  });

  it('dedups case-insensitively, first spelling wins, across speakers/terms/keyterms', () => {
    const out = resolveTerms({
      speakers,
      terms: ['oscar', 'Ana'],
      providerOptions: { keyterms: ['ANA'] },
    });
    // Speaker "Oscar" first, then "Ana" from terms (not re-added by keyterms).
    expect(out.filter((n) => n.toLowerCase() === 'oscar')).toHaveLength(1);
    expect(out.filter((n) => n.toLowerCase() === 'ana')).toHaveLength(1);
  });

  it('merges upload keyterms in', () => {
    const out = resolveTerms({ speakers: [], providerOptions: { keyterms: ['Kestrel', 'Fig'] } });
    expect(out).toEqual(expect.arrayContaining(['Kestrel', 'Fig']));
  });

  it('filters to only the requested speakerIds, and rejects an unknown one', () => {
    const out = resolveTerms({ speakers, speakerIds: ['s-b'], providerOptions: {} });
    expect(out).toEqual(['Oscar']);

    expect(() =>
      resolveTerms({ speakers, speakerIds: ['s-b', 'does-not-exist'], providerOptions: {} }),
    ).toThrow(BadRequestException);
  });
});

// -----------------------------------------------------------------------------
// toRunView
// -----------------------------------------------------------------------------

describe('toRunView', () => {
  it('renders dates as ISO strings and null dates as null', () => {
    const run = {
      id: 'check-1',
      transcriptId: 't1',
      mode: 'standard',
      status: 'ready',
      basedOnVersion: 3,
      terms: ['Oscar'],
      providerId: 'openai',
      model: 'gpt-4o',
      candidateCount: 1,
      suggestionCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      errorClass: null,
      error: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      completedAt: null,
    } as never;

    const view = toRunView(run);

    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(view.startedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(view.completedAt).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The service — `create`
// -----------------------------------------------------------------------------

const TRANSCRIPT_ID = 'transcript-1';
const USER = { id: 'user-1', email: 'u@example.test', roles: ['Contributor'], permissions: ['transcripts:write', 'transcripts:read'], isActive: true } as never;

function transcriptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRANSCRIPT_ID,
    status: 'ready',
    currentVersion: 3,
    providerOptions: {},
    ...overrides,
  };
}

function harness() {
  const access = { require: jest.fn().mockResolvedValue({ transcript: transcriptRow(), role: 'owner' }) };
  const editing = { applyOperations: jest.fn(), currentResult: jest.fn() };
  const aiConfig = {
    getConfig: jest.fn().mockResolvedValue({
      available: true,
      provider: 'openai',
      providerLabel: 'OpenAI',
      models: [],
      defaultModel: 'gpt-4o',
      keyConfigured: true,
    }),
  };
  const providers = {
    get: jest.fn().mockReturnValue({ id: 'openai', label: 'OpenAI', countTokens: (t: string) => Math.ceil(t.length / 4) }),
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }) };

  const prisma = {
    transcriptSpeaker: { findMany: jest.fn().mockResolvedValue([]) },
    transcriptSegment: { findMany: jest.fn().mockResolvedValue([]) },
    transcriptNameCheck: {
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'check-1',
        transcriptId: data.transcriptId,
        mode: data.mode,
        status: data.status,
        basedOnVersion: data.basedOnVersion,
        terms: data.terms,
        providerId: data.providerId,
        model: data.model,
        candidateCount: 0,
        suggestionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        errorClass: null,
        error: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        startedAt: null,
        completedAt: null,
        jobId: null,
      })),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'check-1',
        transcriptId: TRANSCRIPT_ID,
        mode: 'standard',
        status: 'pending',
        basedOnVersion: 3,
        terms: ['Oscar'],
        providerId: 'openai',
        model: 'gpt-4o',
        candidateCount: 0,
        suggestionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        errorClass: null,
        error: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        startedAt: null,
        completedAt: null,
        ...data,
      })),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
    },
    transcriptNameSuggestion: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    transcriptVersion: { findUnique: jest.fn().mockResolvedValue(null) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  const service = new TranscriptNameCheckService(
    prisma as never,
    access as never,
    editing as never,
    aiConfig as never,
    providers as never,
    jobs as never,
  );

  return { service, access, editing, aiConfig, providers, jobs, prisma };
}

describe('TranscriptNameCheckService.create', () => {
  it('409s with transcript_not_ready when the transcript has no version yet', async () => {
    const { service, access } = harness();
    access.require.mockResolvedValue({ transcript: transcriptRow({ currentVersion: 0, status: 'processing' }), role: 'owner' });

    await expect(
      service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        details: { reason: NAME_CHECK_CONFLICT_REASONS.TRANSCRIPT_NOT_READY },
      }),
    });
  });

  it('409s with ai_not_configured when AI is unavailable for this deployment', async () => {
    const { service, aiConfig } = harness();
    aiConfig.getConfig.mockResolvedValue({
      available: false,
      provider: null,
      providerLabel: null,
      models: [],
      defaultModel: null,
      keyConfigured: false,
    });

    await expect(service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER)).rejects.toMatchObject({
      response: expect.objectContaining({ details: { reason: NAME_CHECK_CONFLICT_REASONS.AI_NOT_CONFIGURED } }),
    });
  });

  it('409s with ai_key_missing when the caller has no saved API key', async () => {
    const { service, aiConfig } = harness();
    aiConfig.getConfig.mockResolvedValue({
      available: true,
      provider: 'openai',
      providerLabel: 'OpenAI',
      models: [],
      defaultModel: 'gpt-4o',
      keyConfigured: false,
    });

    await expect(service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER)).rejects.toMatchObject({
      response: expect.objectContaining({ details: { reason: NAME_CHECK_CONFLICT_REASONS.AI_KEY_MISSING } }),
    });
  });

  it('409s with name_check_running when a run is already pending or running', async () => {
    const { service, prisma } = harness();
    prisma.transcriptNameCheck.findMany.mockResolvedValue([
      { id: 'other-check', job: { status: 'running' } },
    ]);

    await expect(service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER)).rejects.toMatchObject({
      response: expect.objectContaining({
        details: expect.objectContaining({ reason: NAME_CHECK_CONFLICT_REASONS.NAME_CHECK_RUNNING }),
      }),
    });
  });

  it('400s when resolving names leaves nothing to check', async () => {
    const { service, prisma } = harness();
    prisma.transcriptSpeaker.findMany.mockResolvedValue([]);

    await expect(service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enqueues transcript.name_check carrying the created run id as payload.checkId', async () => {
    const { service, prisma, jobs } = harness();
    prisma.transcriptSpeaker.findMany.mockResolvedValue([{ id: 's-a', label: 'A', displayName: 'Oscar' }]);

    const result = await service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER);

    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TRANSCRIPT_NAME_CHECK_JOB_TYPE,
        subjectId: TRANSCRIPT_ID,
        payload: { checkId: 'check-1' },
      }),
    );
    expect(result.run.id).toBe('check-1');
    expect(result.estimate).toBeDefined();
  });

  it('returns a 202-shaped body: { run, estimate }', async () => {
    const { service, prisma } = harness();
    prisma.transcriptSpeaker.findMany.mockResolvedValue([{ id: 's-a', label: 'A', displayName: 'Oscar' }]);

    const result = await service.create(TRANSCRIPT_ID, { mode: 'standard' } as never, USER);

    expect(result).toEqual(
      expect.objectContaining({
        run: expect.objectContaining({ id: 'check-1' }),
        estimate: expect.objectContaining({ inputTokens: expect.any(Number) }),
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// latest
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckService.latest', () => {
  it('returns nulls/empties when there is no run yet', async () => {
    const { service, prisma } = harness();
    prisma.transcriptNameCheck.findFirst.mockResolvedValue(null);

    const result = await service.latest(TRANSCRIPT_ID, USER);

    expect(result).toEqual({
      run: null,
      suggestions: [],
      counts: { pending: 0, accepted: 0, rejected: 0, stale: 0 },
    });
  });

  it('marks a stale flag and relocates offsets when the segment changed since the check ran', async () => {
    const { service, prisma } = harness();
    prisma.transcriptNameCheck.findFirst.mockResolvedValue({
      id: 'check-1',
      transcriptId: TRANSCRIPT_ID,
      mode: 'standard',
      status: 'ready',
      basedOnVersion: 3,
      terms: ['Oscar'],
      providerId: 'openai',
      model: 'gpt-4o',
      candidateCount: 1,
      suggestionCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      errorClass: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    });
    prisma.transcriptNameSuggestion.groupBy.mockResolvedValue([{ status: 'pending', _count: { _all: 1 } }]);
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([
      {
        id: 'sugg-1',
        segmentId: 'seg-1',
        start: 999,
        end: 1003,
        original: 'Skar',
        replacement: 'Oscar',
        confidence: 0.9,
        reason: 'sounds like it',
        source: 'phonetic',
        segment: { text: 'They called him Skar yesterday.', speakerId: 's-a', startMs: 0 },
      },
    ]);

    const result = await service.latest(TRANSCRIPT_ID, USER);

    expect(result.suggestions).toHaveLength(1);
    // The stored [999,1003) no longer reads "Skar"; it relocates because
    // "Skar" occurs exactly once as a whole word.
    expect(result.suggestions[0]!.stale).toBe(false);
    expect(result.suggestions[0]!.start).toBe(16);
    expect(result.suggestions[0]!.end).toBe(20);
  });

  it('marks stale: true when the original text cannot be relocated', async () => {
    const { service, prisma } = harness();
    prisma.transcriptNameCheck.findFirst.mockResolvedValue({
      id: 'check-1',
      transcriptId: TRANSCRIPT_ID,
      mode: 'standard',
      status: 'ready',
      basedOnVersion: 3,
      terms: ['Oscar'],
      providerId: 'openai',
      model: 'gpt-4o',
      candidateCount: 1,
      suggestionCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      errorClass: null,
      error: null,
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    });
    prisma.transcriptNameSuggestion.groupBy.mockResolvedValue([{ status: 'pending', _count: { _all: 1 } }]);
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([
      {
        id: 'sugg-1',
        segmentId: 'seg-1',
        start: 999,
        end: 1003,
        original: 'Skar',
        replacement: 'Oscar',
        confidence: 0.9,
        reason: null,
        source: 'phonetic',
        segment: { text: 'Completely different text now.', speakerId: 's-a', startMs: 0 },
      },
    ]);

    const result = await service.latest(TRANSCRIPT_ID, USER);

    expect(result.suggestions[0]!.stale).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// reject
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckService.reject', () => {
  it('404s for a check id that does not belong to the transcript', async () => {
    const { service, prisma } = harness();
    prisma.transcriptNameCheck.findFirst.mockResolvedValue(null);

    await expect(
      service.reject(TRANSCRIPT_ID, 'nope', { suggestionIds: ['s1'] } as never, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks the named pending suggestions rejected and returns the count', async () => {
    const { service, prisma } = harness();
    prisma.transcriptNameCheck.findFirst.mockResolvedValue({ id: 'check-1' });
    prisma.transcriptNameSuggestion.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.reject(TRANSCRIPT_ID, 'check-1', { suggestionIds: ['s1', 's2'] } as never, USER);

    expect(result).toEqual({ rejected: 2 });
    expect(prisma.transcriptNameSuggestion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['s1', 's2'] }, checkId: 'check-1', status: 'pending' },
        data: expect.objectContaining({ status: 'rejected' }),
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// apply
// -----------------------------------------------------------------------------

describe('TranscriptNameCheckService.apply', () => {
  function applyHarness() {
    const h = harness();
    h.prisma.transcriptNameCheck.findFirst.mockResolvedValue({ id: 'check-1' });
    h.editing.currentResult.mockResolvedValue({
      version: 3,
      summary: 'No changes',
      speakers: [],
      segments: [],
      merges: [],
    });
    return h;
  }

  it('sends one segment.update_text op per segment, carrying the segment CURRENT rev', async () => {
    const { service, prisma, editing } = applyHarness();

    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([
      {
        id: 'sugg-1',
        segmentId: 'seg-1',
        checkId: 'check-1',
        status: 'pending',
        start: 16,
        end: 20,
        original: 'Skar',
        replacement: 'Oscar',
      },
    ]);
    (prisma as unknown as { transcriptSegment: { findMany: jest.Mock } }).transcriptSegment = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'seg-1',
          rev: 7,
          text: 'They called him Skar yesterday.',
          startMs: 0,
          ordinal: 1,
        },
      ]),
    };

    editing.applyOperations.mockResolvedValue({
      version: 4,
      summary: 'Applied 1 AI name correction',
      speakers: [],
      segments: [],
      merges: [],
    });

    const result = await service.apply(
      TRANSCRIPT_ID,
      'check-1',
      { suggestionIds: ['sugg-1'] } as never,
      USER,
    );

    expect(editing.applyOperations).toHaveBeenCalledTimes(1);
    const [, dto, , options] = editing.applyOperations.mock.calls[0];
    expect(dto.ops).toEqual([{ op: 'segment.update_text', segmentId: 'seg-1', rev: 7, text: 'They called him Oscar yesterday.' }]);
    expect(options?.summary).toContain('AI name correction');
    expect(result.applied).toBe(1);
    expect(result.version).toBe(4);
  });

  it('chunks batches at MAX_OPS_PER_BATCH segments', async () => {
    const { service, prisma, editing } = applyHarness();

    const MAX = 200; // MAX_OPS_PER_BATCH
    const suggestions = Array.from({ length: MAX + 1 }, (_, i) => ({
      id: `sugg-${i}`,
      segmentId: `seg-${i}`,
      checkId: 'check-1',
      status: 'pending',
      start: 0,
      end: 4,
      original: 'Skar',
      replacement: 'Oscar',
    }));
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue(suggestions);
    (prisma as unknown as { transcriptSegment: { findMany: jest.Mock } }).transcriptSegment = {
      findMany: jest.fn().mockResolvedValue(
        Array.from({ length: MAX + 1 }, (_, i) => ({
          id: `seg-${i}`,
          rev: 1,
          text: 'Skar was here.',
          startMs: i,
          ordinal: i,
        })),
      ),
    };
    editing.applyOperations.mockResolvedValue({
      version: 4,
      summary: 'x',
      speakers: [],
      segments: [],
      merges: [],
    });

    await service.apply(TRANSCRIPT_ID, 'check-1', { suggestionIds: suggestions.map((s) => s.id) } as never, USER);

    // MAX segments in the first batch, 1 in the second.
    expect(editing.applyOperations).toHaveBeenCalledTimes(2);
  });

  it('produces a deterministic clientBatchId (same suggestion ids -> same id)', async () => {
    const { service, prisma, editing } = applyHarness();
    const suggestion = {
      id: 'sugg-1',
      segmentId: 'seg-1',
      checkId: 'check-1',
      status: 'pending',
      start: 16,
      end: 20,
      original: 'Skar',
      replacement: 'Oscar',
    };
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([suggestion]);
    (prisma as unknown as { transcriptSegment: { findMany: jest.Mock } }).transcriptSegment = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'seg-1', rev: 7, text: 'They called him Skar yesterday.', startMs: 0, ordinal: 1 },
      ]),
    };
    editing.applyOperations.mockResolvedValue({ version: 4, summary: 'x', speakers: [], segments: [], merges: [] });

    await service.apply(TRANSCRIPT_ID, 'check-1', { suggestionIds: ['sugg-1'] } as never, USER);
    const firstBatchId = editing.applyOperations.mock.calls[0][1].clientBatchId;

    editing.applyOperations.mockClear();
    await service.apply(TRANSCRIPT_ID, 'check-1', { suggestionIds: ['sugg-1'] } as never, USER);
    const secondBatchId = editing.applyOperations.mock.calls[0][1].clientBatchId;

    expect(firstBatchId).toBe(secondBatchId);
    expect(firstBatchId).toContain('namecheck:check-1:');
  });

  it('replays idempotently when a version with that clientBatchId already exists, marking suggestions accepted', async () => {
    const { service, prisma, editing } = applyHarness();
    const suggestion = {
      id: 'sugg-1',
      segmentId: 'seg-1',
      checkId: 'check-1',
      status: 'pending',
      start: 16,
      end: 20,
      original: 'Skar',
      replacement: 'Oscar',
    };
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([suggestion]);
    (prisma as unknown as { transcriptSegment: { findMany: jest.Mock } }).transcriptSegment = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'seg-1', rev: 7, text: 'They called him Skar yesterday.', startMs: 0, ordinal: 1 },
      ]),
    };

    // A version with the computed clientBatchId is already recorded, naming
    // seg-1 as an edited segment.
    (prisma as unknown as { transcriptVersion: { findUnique: jest.Mock } }).transcriptVersion = {
      findUnique: jest.fn().mockResolvedValue({
        ops: [{ op: 'segment.update_text', segmentId: 'seg-1', rev: 7, text: 'They called him Oscar yesterday.' }],
      }),
    };
    editing.applyOperations.mockResolvedValue({ version: 4, summary: 'Applied', speakers: [], segments: [], merges: [] });

    const result = await service.apply(TRANSCRIPT_ID, 'check-1', { suggestionIds: ['sugg-1'] } as never, USER);

    expect(result.applied).toBe(1);
    expect(prisma.transcriptNameSuggestion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['sugg-1'] }, checkId: 'check-1', status: 'pending' },
        data: expect.objectContaining({ status: 'accepted' }),
      }),
    );
  });

  it('marks a suggestion stale when its span cannot be resolved against the current text', async () => {
    const { service, prisma, editing } = applyHarness();
    const suggestion = {
      id: 'sugg-1',
      segmentId: 'seg-1',
      checkId: 'check-1',
      status: 'pending',
      start: 999,
      end: 1003,
      original: 'Skar',
      replacement: 'Oscar',
    };
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([suggestion]);
    (prisma as unknown as { transcriptSegment: { findMany: jest.Mock } }).transcriptSegment = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'seg-1', rev: 7, text: 'Completely different text.', startMs: 0, ordinal: 1 },
      ]),
    };
    (prisma as unknown as { transcriptVersion: { findUnique: jest.Mock } }).transcriptVersion = {
      findUnique: jest.fn().mockResolvedValue(null),
    };

    const result = await service.apply(TRANSCRIPT_ID, 'check-1', { suggestionIds: ['sugg-1'] } as never, USER);

    expect(result.applied).toBe(0);
    expect(result.stale).toBe(1);
    expect(editing.applyOperations).not.toHaveBeenCalled();
    expect(prisma.transcriptNameSuggestion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'stale' }) }),
    );
  });

  it('passes a custom summary to applyOperations', async () => {
    const { service, prisma, editing } = applyHarness();
    prisma.transcriptNameSuggestion.findMany.mockResolvedValue([
      {
        id: 'sugg-1',
        segmentId: 'seg-1',
        checkId: 'check-1',
        status: 'pending',
        start: 16,
        end: 20,
        original: 'Skar',
        replacement: 'Oscar',
      },
    ]);
    (prisma as unknown as { transcriptSegment: { findMany: jest.Mock } }).transcriptSegment = {
      findMany: jest.fn().mockResolvedValue([
        { id: 'seg-1', rev: 7, text: 'They called him Skar yesterday.', startMs: 0, ordinal: 1 },
      ]),
    };
    editing.applyOperations.mockResolvedValue({ version: 4, summary: 'x', speakers: [], segments: [], merges: [] });

    await service.apply(TRANSCRIPT_ID, 'check-1', { suggestionIds: ['sugg-1'] } as never, USER);

    const options = editing.applyOperations.mock.calls[0][3];
    expect(options.summary).toBe('Applied 1 AI name correction');
  });
});

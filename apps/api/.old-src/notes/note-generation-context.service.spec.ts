import { NotFoundException } from '@nestjs/common';
import type { NoteGeneration } from '@prisma/client';

import { NOTE_NOT_FOUND_MESSAGE } from './access/note-access.service';
import {
  NO_GENERATION_REASON,
  NoteGenerationContextService,
  redactSourceMaterial,
  SOURCE_WITHHELD_NOTICE,
} from './note-generation-context.service';

// =============================================================================
// NoteGenerationContextService (issue #307)
// =============================================================================
//
// Two seams matter here beyond the happy path:
//
//   • `stored: false` — a row written before this feature — must rebuild the
//     system prompt from the template AS IT STANDS TODAY, never re-read the
//     source, and never fabricate a `userContent`.
//   • `sourceRedacted` — the caller lost access to the source since the
//     generation ran — must cut `userContent` at the exact `Source material:`
//     boundary, computed from the row's own `contextText` rather than
//     searched for, because the user's own Context can itself contain those
//     words.
// =============================================================================

const NOTE_ID = 'note-1';
const OWNER_ID = 'owner-1';
const GENERATION_ID = 'gen-1';
const TEMPLATE_ID = 'template-1';

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID,
    ownerId: OWNER_ID,
    currentGenerationId: GENERATION_ID,
    sourceType: 'transcript',
    sourceTranscriptId: 'transcript-1',
    sourceNoteId: null,
    sourceObjectId: null,
    deletedAt: null,
    ...overrides,
  };
}

function generationRow(overrides: Record<string, unknown> = {}): NoteGeneration {
  return {
    id: GENERATION_ID,
    noteId: NOTE_ID,
    kind: 'create',
    status: 'succeeded',
    templateId: TEMPLATE_ID,
    templateNameSnapshot: 'Meeting notes',
    contextText: null,
    sourceType: 'transcript',
    sourceTranscriptId: 'transcript-1',
    sourceNoteId: null,
    sourceObjectId: null,
    providerId: 'openai',
    model: 'gpt-4o',
    content: 'the note body',
    lastEventId: 3,
    systemPrompt: 'You write meeting notes.',
    userContent: 'Source material:\nAna: we ship on Friday.',
    sourceVersion: 7,
    contextCapturedAt: new Date('2026-09-01T10:00:00.000Z'),
    promptTokens: 120,
    completionTokens: 40,
    startedAt: new Date(),
    completedAt: new Date(),
    errorClass: null,
    errorDetail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as NoteGeneration;
}

const template = {
  id: TEMPLATE_ID,
  instructions: 'Write meeting notes.',
  outputFormat: 'Meeting notes',
  structure: ['Overview'],
  tone: null,
  length: null,
};

function harness(options: {
  note?: Record<string, unknown> | null;
  generation?: NoteGeneration | null;
  sourceReadable?: boolean;
  template?: Record<string, unknown> | null;
} = {}) {
  const access = {
    require: jest.fn().mockImplementation(async () => {
      const note = options.note === undefined ? noteRow() : options.note;

      if (!note) throw new NotFoundException(NOTE_NOT_FOUND_MESSAGE);

      return { note, role: 'owner' as const };
    }),
  };

  const sourceNames = {
    resolveOne: jest
      .fn()
      .mockResolvedValue(options.sourceReadable === false ? null : 'Kestrel weekly'),
  };

  const prisma = {
    noteGeneration: {
      findUnique: jest.fn().mockResolvedValue(
        options.generation === undefined ? generationRow() : options.generation,
      ),
    },
    noteTemplate: {
      findUnique: jest.fn().mockResolvedValue(
        options.template === undefined ? template : options.template,
      ),
    },
  };

  const service = new NoteGenerationContextService(
    prisma as never,
    access as never,
    sourceNames as never,
  );

  return { service, access, sourceNames, prisma };
}

const user = { id: OWNER_ID, permissions: ['notes:read', 'notes:write'] } as never;

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe('NoteGenerationContextService.forNote — happy path', () => {
  it('maps every stored field onto the response, with provider taken from providerId', async () => {
    const { service } = harness();

    const result = await service.forNote(user, NOTE_ID);

    expect(result).toMatchObject({
      generationId: GENERATION_ID,
      kind: 'create',
      status: 'succeeded',
      stored: true,
      capturedAt: '2026-09-01T10:00:00.000Z',
      templateId: TEMPLATE_ID,
      templateNameSnapshot: 'Meeting notes',
      provider: 'openai',
      model: 'gpt-4o',
      contextText: null,
      sourceType: 'transcript',
      sourceVersion: 7,
      sourceRedacted: false,
      systemPrompt: 'You write meeting notes.',
      userContent: 'Source material:\nAna: we ship on Friday.',
      promptTokens: 120,
      completionTokens: 40,
    });
  });

  it('reads the note\'s CURRENT generation when no generationId is given', async () => {
    const { service, prisma } = harness();

    await service.forNote(user, NOTE_ID);

    expect(prisma.noteGeneration.findUnique).toHaveBeenCalledWith({
      where: { id: GENERATION_ID },
    });
  });

  it('reads a NAMED generation instead, when one is given', async () => {
    const { service, prisma } = harness();
    prisma.noteGeneration.findUnique.mockResolvedValue(generationRow({ id: 'gen-2' }));

    await service.forNote(user, NOTE_ID, 'gen-2');

    expect(prisma.noteGeneration.findUnique).toHaveBeenCalledWith({ where: { id: 'gen-2' } });
  });
});

// -----------------------------------------------------------------------------
// 404s
// -----------------------------------------------------------------------------

describe('NoteGenerationContextService.forNote — 404s', () => {
  it('404s with details.reason "no_generation" for a note with none', async () => {
    const { service } = harness({ note: noteRow({ currentGenerationId: null }) });

    await expect(service.forNote(user, NOTE_ID)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ details: { reason: NO_GENERATION_REASON } }),
    });
  });

  it('404s for a generation belonging to a DIFFERENT note', async () => {
    const { service } = harness({
      generation: generationRow({ noteId: 'some-other-note' }),
    });

    await expect(service.forNote(user, NOTE_ID, GENERATION_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('404s for a generation id that does not exist at all', async () => {
    const { service } = harness({ generation: null });

    await expect(service.forNote(user, NOTE_ID, 'nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('propagates the access-service 404 for a note the caller cannot see (never 403)', async () => {
    const { service } = harness({ note: null });

    await expect(service.forNote(user, NOTE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

// -----------------------------------------------------------------------------
// `stored: false` — a pre-#307 row
// -----------------------------------------------------------------------------

describe('NoteGenerationContextService.forNote — stored: false (pre-#307 rows)', () => {
  it('rebuilds systemPrompt from the CURRENT template, and userContent stays null', async () => {
    const { service } = harness({
      generation: generationRow({ systemPrompt: null, userContent: null, contextCapturedAt: null }),
    });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.stored).toBe(false);
    expect(result.capturedAt).toBeNull();
    expect(result.userContent).toBeNull();
    expect(result.systemPrompt).toContain('Write meeting notes.');
  });

  it('systemPrompt is null when the template itself is gone', async () => {
    const { service } = harness({
      generation: generationRow({ systemPrompt: null, userContent: null }),
      template: null,
    });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.systemPrompt).toBeNull();
  });

  it('systemPrompt is null when the row carries no templateId at all', async () => {
    const { service } = harness({
      generation: generationRow({ systemPrompt: null, userContent: null, templateId: null }),
    });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.systemPrompt).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// sourceRedacted
// -----------------------------------------------------------------------------

describe('NoteGenerationContextService.forNote — sourceRedacted', () => {
  it('cuts userContent at "Source material:" and appends the notice when the source is unreadable', async () => {
    const { service } = harness({ sourceReadable: false });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.sourceRedacted).toBe(true);
    expect(result.userContent).toBe(`Source material:\n${SOURCE_WITHHELD_NOTICE}`);
  });

  it('preserves the Context text ahead of the cut', async () => {
    const { service } = harness({
      sourceReadable: false,
      generation: generationRow({
        contextText: 'Focus on action items.',
        userContent:
          'Context provided by the user:\nFocus on action items.\n\nSource material:\nAna: we ship on Friday.',
      }),
    });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.userContent).toBe(
      `Context provided by the user:\nFocus on action items.\n\nSource material:\n${SOURCE_WITHHELD_NOTICE}`,
    );
  });

  it('leaves userContent untouched when the source IS still readable', async () => {
    const { service } = harness({ sourceReadable: true });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.sourceRedacted).toBe(false);
    expect(result.userContent).toBe('Source material:\nAna: we ship on Friday.');
  });

  it('never redacts a generation with no stored userContent (stored: false) — there is nothing to cut', async () => {
    const { service } = harness({
      sourceReadable: false,
      generation: generationRow({ systemPrompt: null, userContent: null }),
    });

    const result = await service.forNote(user, NOTE_ID);

    expect(result.sourceRedacted).toBe(true);
    expect(result.userContent).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// redactSourceMaterial — the pure cutter, fail-closed
// -----------------------------------------------------------------------------

describe('redactSourceMaterial', () => {
  it('cuts at the heading and appends the notice, with no context text', () => {
    const result = redactSourceMaterial(
      'Source material:\nAna: we ship on Friday.',
      null,
    );

    expect(result).toBe(`Source material:\n${SOURCE_WITHHELD_NOTICE}`);
  });

  it('cuts after a preserved context block', () => {
    const result = redactSourceMaterial(
      'Context provided by the user:\nFocus on decisions.\n\nSource material:\nAna: we ship on Friday.',
      'Focus on decisions.',
    );

    expect(result).toBe(
      `Context provided by the user:\nFocus on decisions.\n\nSource material:\n${SOURCE_WITHHELD_NOTICE}`,
    );
  });

  it('fails CLOSED when the stored text does not start with the expected prefix', () => {
    // A row assembled by some other/future build, whose shape this build does
    // not recognise: withhold EVERYTHING after the heading rather than guess.
    const result = redactSourceMaterial(
      'Something else entirely, not the expected shape at all.',
      null,
    );

    expect(result).toBe(`Source material:\n${SOURCE_WITHHELD_NOTICE}`);
    expect(result).not.toContain('Something else entirely');
  });

  it('is not mis-cut when the CONTEXT itself contains the words "Source material:"', () => {
    // The cut point is COMPUTED from contextText, never searched for in
    // userContent — this is exactly why. A naive `indexOf('Source material:')`
    // would cut inside the user's own Context instead of at the real heading.
    const context = 'Please treat "Source material:" as a literal phrase, not a heading.';
    const userContent =
      `Context provided by the user:\n${context}\n\nSource material:\nAna: we ship on Friday.`;

    const result = redactSourceMaterial(userContent, context);

    expect(result).toBe(
      `Context provided by the user:\n${context}\n\nSource material:\n${SOURCE_WITHHELD_NOTICE}`,
    );
  });
});

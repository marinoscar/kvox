// =============================================================================
// A note is generated from the transcript AS THE USER CORRECTED IT (issue #49)
// =============================================================================
//
// THE ASSERTION THAT MATTERS MOST in this file: the transcript branch goes
// through `TranscriptMaterializeService.materialize`, and the text that reaches
// the prompt is the CORRECTED state — not the provider's original result. That
// is the entire premise of building notes on top of epic #19, and it is
// invisible in a diff: a version of this service that read the raw provider
// result object would look perfectly reasonable and would generate confident
// notes containing names the user already fixed.
// =============================================================================

import { AiInputError } from '../../ai/ai-errors';
import { MarkdownTranscriptExporter } from '../../transcripts/export/markdown.exporter';
import { TranscriptExporterRegistry } from '../../transcripts/export/transcript-exporter.interface';
import { NoteSourceService, readExtractedObjectId } from './note-source.service';

const CORRECTED = 'Ana Rivera confirmed the Kestrel launch date.';
const AI_ORIGINAL = 'Anna River confirmed the Kestrel lunch date.';

/** The state `materialize()` returns — the corrected one, by construction. */
const correctedState = {
  speakers: [
    { id: 'spk-1', label: 'A', displayName: 'Ana Rivera', colorIndex: 0, rev: 4 },
  ],
  segments: [
    {
      id: 'seg-1',
      speakerId: 'spk-1',
      startMs: 0,
      endMs: 4_000,
      ordinal: 1_000,
      text: CORRECTED,
      words: [],
      wordsAlignment: 'exact' as const,
      confidence: null,
      origin: 'ai' as const,
      rev: 4,
    },
  ],
};

describe('NoteSourceService', () => {
  let prisma: {
    transcript: { findUnique: jest.Mock };
    transcriptVersion: { findUnique: jest.Mock };
    note: { findUnique: jest.Mock };
    storageObject: { findUnique: jest.Mock };
  };
  let materialize: { materialize: jest.Mock };
  let objects: { downloadBuffer: jest.Mock };
  let service: NoteSourceService;

  beforeEach(() => {
    prisma = {
      transcript: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'transcript-1',
          title: 'Kestrel weekly',
          language: 'en',
          durationMs: 4_000,
          currentVersion: 7,
          deletedAt: null,
        }),
      },
      transcriptVersion: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ createdAt: new Date('2026-09-01T10:00:00.000Z') }),
      },
      note: { findUnique: jest.fn() },
      storageObject: { findUnique: jest.fn() },
    };

    materialize = {
      materialize: jest
        .fn()
        .mockResolvedValue({ transcriptId: 'transcript-1', version: 7, state: correctedState }),
    };

    objects = { downloadBuffer: jest.fn() };

    service = new NoteSourceService(
      prisma as never,
      materialize as never,
      new MarkdownTranscriptExporter(new TranscriptExporterRegistry()),
      objects as never,
    );
  });

  const transcriptSelector = {
    sourceType: 'transcript' as const,
    sourceTranscriptId: 'transcript-1',
    sourceNoteId: null,
    sourceObjectId: null,
  };

  describe('transcript', () => {
    it('materializes the CURRENT version and renders the corrected text', async () => {
      const resolved = await service.resolve(transcriptSelector);

      expect(materialize.materialize).toHaveBeenCalledWith('transcript-1', 7);
      expect(resolved.text).toContain(CORRECTED);
      expect(resolved.text).not.toContain(AI_ORIGINAL);
    });

    it('renders the corrected speaker name, not the diarization letter', async () => {
      const resolved = await service.resolve(transcriptSelector);

      expect(resolved.text).toContain('Ana Rivera');
    });

    it('is deterministic — two renders of the same transcript are byte-identical', async () => {
      const first = await service.resolve(transcriptSelector);
      const second = await service.resolve(transcriptSelector);

      // ⚠ This is what forbids `exportedAt: new Date()` in the projection: an
      // assembled prompt must not differ between the request-time budget check
      // and the job-time one for no reason but the passage of time.
      expect(second.text).toBe(first.text);
    });

    it('refuses a deleted transcript with a domain error', async () => {
      prisma.transcript.findUnique.mockResolvedValue({
        id: 'transcript-1',
        title: 'Gone',
        language: null,
        durationMs: null,
        currentVersion: 1,
        deletedAt: new Date(),
      });

      await expect(service.resolve(transcriptSelector)).rejects.toBeInstanceOf(AiInputError);
    });

    it('refuses a transcript that has not been transcribed yet', async () => {
      prisma.transcript.findUnique.mockResolvedValue({
        id: 'transcript-1',
        title: 'Still uploading',
        language: null,
        durationMs: null,
        currentVersion: 0,
        deletedAt: null,
      });

      await expect(service.resolve(transcriptSelector)).rejects.toBeInstanceOf(AiInputError);
      expect(materialize.materialize).not.toHaveBeenCalled();
    });
  });

  describe('note', () => {
    const selector = {
      sourceType: 'note' as const,
      sourceTranscriptId: null,
      sourceNoteId: 'note-2',
      sourceObjectId: null,
    };

    it('reads the live body — the denormalized copy of the current version', async () => {
      prisma.note.findUnique.mockResolvedValue({
        id: 'note-2',
        title: 'Kestrel summary',
        body: '# Kestrel\n\nWe ship Friday.',
        deletedAt: null,
      });

      const resolved = await service.resolve(selector);

      expect(resolved.text).toBe('# Kestrel\n\nWe ship Friday.');
    });

    it('refuses an empty source note rather than generating from nothing', async () => {
      prisma.note.findUnique.mockResolvedValue({
        id: 'note-2',
        title: 'Empty',
        body: '   ',
        deletedAt: null,
      });

      await expect(service.resolve(selector)).rejects.toBeInstanceOf(AiInputError);
    });
  });

  describe('document (issue #51)', () => {
    const selector = {
      sourceType: 'document' as const,
      sourceTranscriptId: null,
      sourceNoteId: null,
      sourceObjectId: 'object-1',
    };

    it('reads the EXTRACTED TEXT object, never the raw uploaded bytes', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        name: 'contract.pdf',
        metadata: { extractedObjectId: 'object-2' },
      });
      objects.downloadBuffer.mockResolvedValue(Buffer.from('The extracted contract text.'));

      const resolved = await service.resolve(selector);

      expect(resolved.text).toBe('The extracted contract text.');
      // The id it downloaded is the one recorded in the SOURCE object's
      // metadata — spec §4.7's whole contract in one assertion.
      expect(objects.downloadBuffer).toHaveBeenCalledWith('object-2');
      expect(objects.downloadBuffer).not.toHaveBeenCalledWith('object-1');
    });

    it('selects `name`, the column `storage_objects` actually has', async () => {
      // Regression guard: #49's seam selected `filename`, which is not a column
      // on this model — a runtime Prisma error rather than a type error, and
      // one no compiler in this repository would have caught.
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        name: 'brief.md',
        metadata: { extractedObjectId: 'object-2' },
      });
      objects.downloadBuffer.mockResolvedValue(Buffer.from('text'));

      await service.resolve(selector);

      expect(prisma.storageObject.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ select: { id: true, name: true, metadata: true } }),
      );
    });

    it('shows the RECORDED failure sentence for a scanned PDF, OCR statement included', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        name: 'scan.pdf',
        metadata: {
          noteSourceExtraction: {
            status: 'unextractable',
            reason: 'no_text_layer',
            message:
              'This PDF contains no extractable text, only images — OCR is not supported.',
            pageCount: 3,
          },
        },
      });

      await expect(service.resolve(selector)).rejects.toThrow(/only images/);
      await expect(service.resolve(selector)).rejects.toThrow(/OCR is not supported/);
      expect(objects.downloadBuffer).not.toHaveBeenCalled();
    });

    it('says extraction has not finished when nothing has been recorded yet', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        name: 'brief.txt',
        metadata: null,
      });

      await expect(service.resolve(selector)).rejects.toBeInstanceOf(AiInputError);
      await expect(service.resolve(selector)).rejects.toThrow(/still being read/);
    });

    it('refuses when the extracted text object has gone', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        name: 'contract.pdf',
        metadata: { extractedObjectId: 'object-2' },
      });
      objects.downloadBuffer.mockResolvedValue(null);

      await expect(service.resolve(selector)).rejects.toBeInstanceOf(AiInputError);
      await expect(service.resolve(selector)).rejects.toThrow(/no longer available/);
    });

    it('NEVER returns an empty string as "the document had no text"', async () => {
      prisma.storageObject.findUnique.mockResolvedValue({
        id: 'object-1',
        name: 'contract.pdf',
        metadata: { extractedObjectId: 'object-2' },
      });
      objects.downloadBuffer.mockResolvedValue(Buffer.from('   \n  \n '));

      // An empty source generates a fluent note about nothing, with nothing
      // anywhere reporting a failure. That is the invisible failure this branch
      // exists to make impossible.
      await expect(service.resolve(selector)).rejects.toBeInstanceOf(AiInputError);
    });
  });
});

describe('readExtractedObjectId', () => {
  it('reads the key #51 writes', () => {
    expect(readExtractedObjectId({ extractedObjectId: 'object-2' })).toBe('object-2');
  });

  it('is total over metadata written by another module and another build', () => {
    expect(readExtractedObjectId(null)).toBeNull();
    expect(readExtractedObjectId('object-2')).toBeNull();
    expect(readExtractedObjectId(['object-2'])).toBeNull();
    expect(readExtractedObjectId({ extractedObjectId: 42 })).toBeNull();
    expect(readExtractedObjectId({ extractedObjectId: '' })).toBeNull();
  });
});

// =============================================================================
// An `ExportDocument` builder for the exporter tests (issue #28, epic #19)
// =============================================================================
//
// Every exporter test needs a document and none of them needs a realistic one,
// so the noise stays here: fixed dates (so a rendered file is comparable across
// runs), readable ids, and speakers whose talk time is computed from the
// segments exactly as `buildExportDocument` computes it.
//
// The default document deliberately contains a speaker named **"José Núñez"**
// and text carrying Markdown specials. Both are load-bearing: issue #28's
// acceptance list requires a Unicode speaker name to render in the PDF, and the
// Markdown exporter's whole job is to not let `*` and `#` through as markup.
// Putting them in the DEFAULT fixture rather than in one special-case test
// means every exporter is exercised against them, not just the one whose test
// remembered to.
// =============================================================================

import { buildExportDocument, type ExportDocument } from '../export-document';
import type { EditableSegment, EditableSpeaker } from '../../editing';
import { ORDINAL_GAP } from '../../editing';

/** A fixed rendering instant, so two runs produce the same bytes. */
export const FIXED_EXPORTED_AT = new Date('2026-09-14T12:00:00.000Z');
export const FIXED_CREATED_AT = new Date('2026-09-10T15:04:22.000Z');

export function fixtureSpeaker(
  id: string,
  displayName: string,
  colorIndex: number,
): EditableSpeaker {
  return { id, label: id.toUpperCase(), displayName, colorIndex, rev: 1 };
}

export function fixtureSegment(
  id: string,
  speakerId: string,
  text: string,
  startMs: number,
  endMs: number,
  ordinal = ORDINAL_GAP,
): EditableSegment {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((token, index, all) => {
      const span = (endMs - startMs) / Math.max(1, all.length);

      return {
        t: token,
        s: startMs + index * span,
        e: startMs + (index + 1) * span,
        c: 0.94,
      };
    });

  return {
    id,
    speakerId,
    startMs,
    endMs,
    ordinal,
    text,
    words,
    wordsAlignment: 'exact' as const,
    confidence: 0.96,
    origin: 'ai' as const,
    rev: 1,
  };
}

/** The default document: two speakers, four segments, Unicode and markup. */
export function fixtureDocument(overrides: Partial<ExportDocument> = {}): ExportDocument {
  const speakers = [
    fixtureSpeaker('spk_a', 'José Núñez', 0),
    fixtureSpeaker('spk_b', 'Priya *Patel*', 1),
  ];

  const segments: EditableSegment[] = [
    fixtureSegment('seg_1', 'spk_a', "Let's get started — thanks everyone.", 0, 4_000, ORDINAL_GAP),
    fixtureSegment('seg_2', 'spk_a', '# Not a heading, just speech.', 4_000, 8_000, ORDINAL_GAP * 2),
    fixtureSegment('seg_3', 'spk_b', 'I have a *note* about the _budget_.', 8_000, 20_000, ORDINAL_GAP * 3),
    fixtureSegment('seg_4', 'spk_b', 'And a [link] with `code` in it.', 20_000, 24_000, ORDINAL_GAP * 4),
  ];

  return {
    ...buildExportDocument({
      transcriptId: 'tr_fixture',
      title: 'Weekly sync — Sept 10',
      language: 'en',
      durationMs: 24_000,
      version: 4,
      createdAt: FIXED_CREATED_AT,
      exportedAt: FIXED_EXPORTED_AT,
      author: { displayName: 'Oscar Marin', email: 'oscar@example.test' },
      provider: { id: 'assemblyai', model: 'best' },
      state: { speakers, segments },
    }),
    ...overrides,
  };
}

/** A long document, for the PDF's multi-page assertions. */
export function longDocument(turns = 120): ExportDocument {
  const speakers = [
    fixtureSpeaker('spk_a', 'José Núñez', 0),
    fixtureSpeaker('spk_b', 'Priya Patel', 1),
  ];

  const segments = Array.from({ length: turns }, (_, index) =>
    fixtureSegment(
      `seg_${index}`,
      index % 2 === 0 ? 'spk_a' : 'spk_b',
      `Turn ${index}: the quick brown fox jumps over the lazy dog, repeatedly and at length, ` +
        'so that this paragraph wraps across several lines of the rendered page.',
      index * 5_000,
      index * 5_000 + 4_500,
      ORDINAL_GAP * (index + 1),
    ),
  );

  return buildExportDocument({
    transcriptId: 'tr_long',
    title: 'A very long conversation',
    language: 'en',
    durationMs: turns * 5_000,
    version: 4,
    createdAt: FIXED_CREATED_AT,
    exportedAt: FIXED_EXPORTED_AT,
    author: null,
    provider: { id: 'assemblyai', model: null },
    state: { speakers, segments },
  });
}

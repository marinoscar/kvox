// =============================================================================
// The speaker palette (issue #28, epic #19, spec §8.4)
// =============================================================================
//
// `transcript_speakers.color_index` is a stable integer per speaker (spec §3.2)
// and every surface that draws a speaker is meant to reach for the SAME colour
// from it — spec §8.4 says the PDF's speaker names mirror "the same colour a
// speaker gets in the web viewer".
//
// ⚠ THIS FILE IS THE MIRROR, NOT THE SOURCE. The palette is chosen in
// `apps/web/src/utils/transcriptDisplay.ts`; this list copies its
// `SPEAKER_COLORS_LIGHT` constant, value for value, in the same order. A change
// starts there and is brought here — never the other way round, and never here
// alone.
//
// The web viewer ships TWO mode-specific lists (`SPEAKER_COLORS_LIGHT` and
// `SPEAKER_COLORS_DARK`) because it renders a speaker on two different grounds
// and one list cannot clear WCAG AA on both. A PDF has only one ground — ink on
// white paper — so this file mirrors the LIGHT list specifically. The dark list
// has no counterpart here and should not acquire one: there is no surface in
// this package for it to be correct on.
//
// ⚠ THE TWO FILES MUST BE CHANGED TOGETHER. This duplication is forced by the
// package boundary — `apps/api` cannot import from `apps/web`, and there is no
// shared package between them — so nothing but this comment and review keeps
// them in step. If the lists drift, a speaker is drawn teal in the web viewer
// and orange in the PDF exported from it: the same person, the same
// `color_index`, two different colours, which is precisely the failure spec
// §8.4 exists to rule out.
//
// ⚠ THE LIST IS CYCLIC AND MUST STAY SO. `color_index` is assigned at ingest
// and is not bounded by the palette's length — a recording of a twelve-person
// meeting has indices past 7. `speakerColor` takes a modulus rather than
// clamping or falling back to black, so a ninth speaker repeats the first
// colour instead of becoming indistinguishable from the body text.
//
// The eight values are dark enough to read as TEXT on white at 10pt, which is
// the constraint this surface adds on top of the web viewer's own: a palette
// tuned for filled chips (which is what a speaker colour usually is on screen)
// contains mid-tones that are perfectly legible as a background and marginal as
// ink. Measured as ink on white, in list order, they are 5.36, 6.04, 5.02,
// 5.18, 6.98, 5.93, 4.92 and 7.58 to 1 — every one of them past the 4.5:1 AA
// floor. `apps/web`'s own `src/__tests__/theme/tokens.test.ts` recomputes these
// on every run against the constant this file mirrors.
//
// ⚠ ORDER IS LOAD-BEARING. `color_index` is persisted per speaker, so a colour
// may be replaced IN PLACE and colours may be APPENDED, but nothing may move:
// reordering this list silently recolours every existing transcript and every
// PDF exported from one before the change.
// =============================================================================

/** Eight colours, cycled. See the header for why these and why cyclic. */
export const SPEAKER_PALETTE = [
  '#0e7490',
  '#be185d',
  '#15803d',
  '#c2410c',
  '#7e22ce',
  '#0369a1',
  '#a16207',
  '#475569',
] as const;

/** The colour for a speaker's `colorIndex`. Total over any integer. */
export function speakerColor(colorIndex: number): string {
  if (!Number.isFinite(colorIndex)) return SPEAKER_PALETTE[0];

  const index = Math.abs(Math.trunc(colorIndex)) % SPEAKER_PALETTE.length;

  return SPEAKER_PALETTE[index] ?? SPEAKER_PALETTE[0];
}

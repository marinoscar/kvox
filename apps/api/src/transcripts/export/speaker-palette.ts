// =============================================================================
// The speaker palette (issue #28, epic #19, spec §8.4)
// =============================================================================
//
// `transcript_speakers.color_index` is a stable integer per speaker (spec §3.2)
// and every surface that draws a speaker is meant to reach for the SAME colour
// from it — spec §8.4 says the PDF's speaker names mirror "the same colour a
// speaker gets in the web viewer".
//
// This is the canonical list, and it lives here because the PDF exporter is the
// first thing in this repository that actually needs to resolve an index to a
// colour: nothing renders a speaker in colour yet, so there is no existing
// palette to import and inventing one in `apps/web` for the API to copy would
// put the definition in the package that cannot be imported by the one that
// needs it first. Issue #31's transcript viewer should mirror these eight
// values rather than pick its own.
//
// ⚠ THE LIST IS CYCLIC AND MUST STAY SO. `color_index` is assigned at ingest
// and is not bounded by the palette's length — a recording of a twelve-person
// meeting has indices past 7. `speakerColor` takes a modulus rather than
// clamping or falling back to black, so a ninth speaker repeats the first
// colour instead of becoming indistinguishable from the body text.
//
// The eight values are dark enough to read as TEXT on white at 10pt. That is
// the constraint that picked them: a palette tuned for filled chips (which is
// what a speaker colour usually is on screen) contains mid-tones that are
// perfectly legible as a background and marginal as ink.
// =============================================================================

/** Eight colours, cycled. See the header for why these and why cyclic. */
export const SPEAKER_PALETTE = [
  '#1565c0',
  '#ad1457',
  '#2e7d32',
  '#ef6c00',
  '#6a1b9a',
  '#00695c',
  '#c62828',
  '#4e342e',
] as const;

/** The colour for a speaker's `colorIndex`. Total over any integer. */
export function speakerColor(colorIndex: number): string {
  if (!Number.isFinite(colorIndex)) return SPEAKER_PALETTE[0];

  const index = Math.abs(Math.trunc(colorIndex)) % SPEAKER_PALETTE.length;

  return SPEAKER_PALETTE[index] ?? SPEAKER_PALETTE[0];
}

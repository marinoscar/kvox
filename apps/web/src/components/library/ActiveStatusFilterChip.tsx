/**
 * The chip that replaces the library's status `<Select>` — issue #193, epic #162.
 *
 * =============================================================================
 * WHY THE DROPDOWN WENT, AND WHY THIS IS NOT JUST A SMALLER DROPDOWN
 * =============================================================================
 *
 * Both library views carried a permanent `Status` `<Select>` beside the search
 * box, and it read "Any status" essentially always. A status is a property of a
 * row that the row's own chip already states — it is not a question users
 * arrive at the library asking. It cost a permanent control, a second piece of
 * filter state, and on a phone a full-width row above the feed that pushed the
 * first card below the fold. Epic #162's criterion is exact: **the filter bar
 * is one search box.**
 *
 * The CAPABILITY is not deleted, only moved. `?status=failed` is still a real,
 * bookmarkable, linkable filtered view — the home counts strip (#170, epic
 * #166) links straight into it — and when one is active this chip is what says
 * so and offers the way out.
 *
 * =============================================================================
 * A CHIP, NOT A RESTORED CONTROL
 * =============================================================================
 *
 * The asymmetry is the point and is worth stating so nobody "finishes the job"
 * by turning it back into a picker:
 *
 *  - It renders ONLY when a filter is active. An unfiltered library shows
 *    nothing here at all, which is the state the `<Select>` spent its life in.
 *  - It offers exactly one action — remove. There is no way to SET a status
 *    from inside the library, because arriving at a filtered library is
 *    something another surface sends you to, not something you assemble here.
 *  - Dismissing it must also clear the URL parameter, not only the state.
 *    `?status=` SEEDS the view (see `transcriptsLibraryFilters.ts`), so a chip
 *    that cleared state alone would be undone by the next remount — and #168
 *    makes remounts routine, because the feed now survives a drill-down and
 *    comes back to the same page.
 *
 * ⚠ The dismissal is a `replace`, never a `push`. Removing an entry point is
 * not a step in the user's history, and a `push` would make Back reapply the
 * filter they just dismissed — the exact "walk backwards through your own
 * filter edits" failure `transcriptsLibraryFilters.ts` rejects two-way binding
 * over.
 */

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';

export function ActiveStatusFilterChip({
  label,
  onClear,
}: {
  /** The offered filter's own label — "Failed", never the raw API value. */
  label: string;
  onClear: () => void;
}) {
  return (
    <Box sx={{ mb: 2 }}>
      <Chip
        label={`Status: ${label}`}
        /* BOTH handlers, same function, and that is not redundant.
           `onDelete` alone draws the ✕ and wires it, but leaves the chip's
           BODY inert — a user who clicks the words rather than the small icon
           gets nothing, which on a phone is most of them. `onClick` makes the
           root a real `role="button"` with Enter/Space and a tab stop. One
           interactive element, two places to hit it. */
        onClick={onClear}
        onDelete={onClear}
        /* ⚠ MUI's OWN delete icon, and NOTHING nested inside the chip.
           A `Chip` with `onDelete` makes its ROOT the interactive element —
           focusable, and deletable with Backspace/Delete — so an `IconButton`
           placed in `deleteIcon` is a button inside a button: invalid HTML,
           an axe `nested-interactive` failure, and a keyboard user tabbing to
           a control their reader has just described as part of something else.
           That is the same trap `TranscriptRow` documents at its own action
           area, arrived at from a different direction, and the axe pass in
           `TranscriptsPage.test.tsx` is what catches a regression back to it.

           So the NAME goes on the root, which is the thing that is actually
           interactive. It OPENS with the visible text — WCAG 2.5.3 wants a
           control's accessible name to contain its visible label, so that
           somebody using voice control can say what they can see. */
        aria-label={`Status: ${label} — clear this filter`}
        size="small"
        variant="outlined"
        color="primary"
      />
    </Box>
  );
}

export default ActiveStatusFilterChip;

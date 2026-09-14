// =============================================================================
// Gap-based ordinals, and the LOCAL renumber when the gap runs out
// (issue #27, epic #19, spec §3.4)
// =============================================================================
//
// Segments are numbered 1000, 2000, 3000, … so that splitting one only needs
// the midpoint between its two neighbours — 1500 between 1000 and 2000 — and
// touches no other row. The alternative, a dense integer sequence, makes every
// split an `UPDATE` over every later segment in the transcript, forever.
//
// -----------------------------------------------------------------------------
// THE FLOAT RUNS OUT, AND THE ANSWER IS A NEIGHBOURHOOD, NOT THE DOCUMENT
// -----------------------------------------------------------------------------
//
// Repeatedly splitting at the same seam halves the gap each time; after a few
// dozen rounds the midpoint stops being distinguishable from its neighbours in
// double precision. Spec §3.4's answer is explicit and it is the one
// implemented here: widen the gap by renumbering only the SMALL NEIGHBOURHOOD
// around the insertion point, never the whole transcript — so the cost of a
// write stays bounded by "how many segments sit in this one neighbourhood",
// not by "how many segments this transcript has".
//
// `planInsertion` returns both halves of that answer: the ordinal to give the
// new segment, and the (usually empty) list of neighbours whose ordinals had to
// move to make room.
//
// ⚠ A RENUMBERED NEIGHBOUR DOES NOT GET ITS `rev` BUMPED. `rev` is the
// optimistic-concurrency counter for CONTENT a user edited (spec §5); an
// ordinal that moved from 2000 to 2400 so that somebody else's split had room
// is a mechanical bookkeeping change nobody asked for and nobody can see.
// Bumping it would hand a 409 to a second editor who was quietly correcting a
// typo three lines away — a conflict invented by the numbering scheme rather
// than by the two edits, which is the opposite of what per-entity `rev` exists
// for. The ordinal is still WRITTEN, of course; it is only the counter that
// stays put.
// =============================================================================

/**
 * The gap between consecutive segment ordinals at ingest: 1000, 2000, 3000, …
 *
 * Also the gap a renumbered neighbourhood is spread back out to, and the
 * distance past the last segment a new trailing segment is placed at.
 */
export const ORDINAL_GAP = 1000;

/**
 * The smallest gap this scheme will tolerate between two adjacent ordinals.
 *
 * Well above double precision's actual resolution at these magnitudes (~1e-13
 * near 1000), because the point is not to wait for arithmetic to break — it is
 * to renumber while the numbers are still comfortably distinguishable by
 * everything that reads them, `ORDER BY` and a JSON round trip included.
 */
export const MIN_ORDINAL_GAP = 1e-4;

/** An ordinal that has to move so an insertion has room. */
export interface OrdinalRenumber {
  id: string;
  ordinal: number;
}

/** Where a new segment goes, and who had to shuffle for it. */
export interface InsertionPlan {
  ordinal: number;
  renumbered: OrdinalRenumber[];
}

/**
 * Place a new segment immediately after `index` in an ordinal-sorted list.
 *
 * The ordinary answer is the midpoint and an empty `renumbered`. The
 * exceptional answer widens an ever-larger window around the insertion point
 * until the segments in it can be spread at `MIN_ORDINAL_GAP` or better, and
 * reports every ordinal that moved.
 *
 * DETERMINISTIC, and that is load-bearing: `materialize()` replays a
 * `segment.split` against the same state and must land on the same ordinals,
 * or a replayed version would order its segments differently from the live
 * tables it is supposed to equal (spec §4.4).
 */
export function planInsertion(
  segments: ReadonlyArray<{ id: string; ordinal: number }>,
  index: number,
): InsertionPlan {
  const before = segments[index];

  if (!before) {
    throw new Error(`planInsertion: no segment at index ${index}`);
  }

  const after = segments[index + 1];

  // The common case: there is room, and nobody moves.
  if (!after) {
    return { ordinal: before.ordinal + ORDINAL_GAP, renumbered: [] };
  }

  const midpoint = (before.ordinal + after.ordinal) / 2;

  if (midpoint - before.ordinal >= MIN_ORDINAL_GAP && after.ordinal - midpoint >= MIN_ORDINAL_GAP) {
    return { ordinal: midpoint, renumbered: [] };
  }

  // The exceptional case. Grow a window outward from the seam until the slots
  // it contains — its current members plus the one being inserted — fit at
  // `MIN_ORDINAL_GAP`, then respread them evenly between the anchors just
  // outside it. The loop terminates at the whole list, where the anchors
  // become synthetic (`ORDINAL_GAP` past each end) and the span is therefore
  // unbounded.
  let low = index;
  let high = index + 1;

  for (;;) {
    const anchorLow = low > 0 ? segments[low - 1].ordinal : segments[0].ordinal - ORDINAL_GAP;
    const anchorHigh =
      high < segments.length - 1
        ? segments[high + 1].ordinal
        : segments[segments.length - 1].ordinal + ORDINAL_GAP;

    // Slots inside the window: its current members, plus the newcomer.
    const slots = high - low + 1 + 1;
    const step = (anchorHigh - anchorLow) / (slots + 1);

    if (step >= MIN_ORDINAL_GAP) {
      const renumbered: OrdinalRenumber[] = [];
      let slot = 1;
      let inserted = 0;

      for (let i = low; i <= high; i += 1) {
        const ordinal = anchorLow + step * slot;
        slot += 1;

        if (segments[i].ordinal !== ordinal) {
          renumbered.push({ id: segments[i].id, ordinal });
        }

        if (i === index) {
          inserted = anchorLow + step * slot;
          slot += 1;
        }
      }

      return { ordinal: inserted, renumbered };
    }

    if (low === 0 && high === segments.length - 1) {
      // Unreachable in practice: with synthetic anchors the span grows by
      // `2 * ORDINAL_GAP` while the slot count grows by the list length, so a
      // list long enough to defeat this is longer than Postgres will hold.
      throw new Error('planInsertion: cannot widen the ordinal gap any further');
    }

    if (low > 0) low -= 1;
    if (high < segments.length - 1) high += 1;
  }
}

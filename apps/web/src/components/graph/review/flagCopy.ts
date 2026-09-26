/**
 * The chip copy for every proposal-item flag (#367; #363's `PROPOSAL_ITEM_FLAGS`).
 *
 * A `Record` over the whole union, so a flag added to `services/graph.ts`
 * without a sentence here fails the type check. `known` and
 * `previously_rejected` have copy too, but render as the group's collapsed
 * disclosures rather than as chips (`HIDDEN_AS_CHIP`).
 */

import { PROPOSAL_ITEM_FLAGS } from '../../../services/graph';
import type { ProposalItemFlag } from '../../../services/graph';

export const FLAG_COPY: Record<ProposalItemFlag, string> = {
  known: 'Already in your graph',
  possible_duplicate: 'Possible duplicate',
  supersedes: 'Replaces an earlier fact',
  overlaps: 'Overlaps an existing period',
  unordered: 'Start date unknown — check the order',
  closing_affects_commitments: 'Affects open commitments',
  sensitive: 'Sensitive',
  ambiguous: 'Several close matches',
  type_changed: 'Type changed',
  previously_rejected: 'Rejected before',
  quote_not_located: 'Quote not found — whole line cited',
  model_claimed_match: "AI says it's someone you know",
  stale_ontology: 'Made with an older ontology',
  imported: 'Imported',
};

/** Shown by the group's collapsed disclosures instead of a chip. */
export const HIDDEN_AS_CHIP: ReadonlySet<string> = new Set<ProposalItemFlag>(['known', 'previously_rejected']);

/** Flags that deserve a warning colour rather than a neutral one. */
const WARNING_FLAGS: ReadonlySet<string> = new Set<ProposalItemFlag>([
  'sensitive',
  'possible_duplicate',
  'ambiguous',
  'overlaps',
  'unordered',
  'closing_affects_commitments',
  'model_claimed_match',
]);

export function isKnownFlag(flag: string): flag is ProposalItemFlag {
  return (PROPOSAL_ITEM_FLAGS as readonly string[]).includes(flag);
}

export interface FlagChip {
  key: string;
  label: string;
  tone: 'warning' | 'default';
}

/** The chips a row draws, in the order the server sent the flags. Unknown → raw key. */
export function flagChips(flags: readonly string[]): FlagChip[] {
  return flags
    .filter((flag) => !HIDDEN_AS_CHIP.has(flag))
    .map((flag) => ({
      key: flag,
      label: isKnownFlag(flag) ? FLAG_COPY[flag] : flag,
      tone: WARNING_FLAGS.has(flag) ? 'warning' : 'default',
    }));
}

// =============================================================================
// The account owner's own node: pure helpers (#778)
// =============================================================================
//
// PURE: no Nest, no Prisma. `GraphSelfService` loads the rows; these decide.
// =============================================================================

import { normalizeAlias } from '../write/normalize.js';

/** The Person the owner chose as themselves, resolved and ready to use. */
export interface ResolvedSelf {
  readonly entityId: string;
  readonly label: string;
  /** The alias strings other than the label. */
  readonly aliases: readonly string[];
}

/** A normalized name, or null when it has no letter or digit. */
export function selfName(name: string): string | null {
  try {
    return normalizeAlias(name);
  } catch {
    return null;
  }
}

/** The set of normalized names that mean the owner: the label and every alias. */
export function selfNames(self: Pick<ResolvedSelf, 'label' | 'aliases'>): Set<string> {
  const out = new Set<string>();
  for (const name of [self.label, ...self.aliases]) {
    const normalized = selfName(name);
    if (normalized !== null) out.add(normalized);
  }
  return out;
}

/** Whether a mention (its label or any alias) names the owner. */
export function mentionsSelf(
  self: Pick<ResolvedSelf, 'label' | 'aliases'>,
  mention: { label: string; aliases: readonly string[] },
): boolean {
  const names = selfNames(self);
  return [mention.label, ...mention.aliases].some((name) => {
    const normalized = selfName(name);
    return normalized !== null && names.has(normalized);
  });
}

/** How far a chain of merges is followed before giving up (a cycle guard). */
export const SELF_MERGE_HOPS = 8;

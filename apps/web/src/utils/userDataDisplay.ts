/**
 * Display helpers for the Danger Zone (`/settings/danger-zone`, issue #80).
 *
 * A `utils/` module rather than functions on the page, for the reason
 * `pages/Admin/dbBackupTable.tsx` is a module beside `DbBackupPage` rather than
 * inside it: both the page and the confirmation dialog need this, the dialog is
 * a child of the page, and a helper living on the page would make the child
 * import its own parent — a cycle. Named after `utils/transcriptDisplay.ts`,
 * which is the same idea for the same reason one feature over.
 *
 * Everything here is PURE and takes its data as arguments: no hooks, no
 * `services/`, no React. That is what lets the inventory sentence — the one
 * piece of copy in this feature that states numbers rather than categories — be
 * tested exhaustively over the scope × summary matrix without rendering a
 * dialog or faking a request.
 */

import { formatBytes } from './transcriptDisplay';
import { USER_DATA_CATEGORIES, scopeIncludes, scopeIsCompound } from '../services/userData';
import type { UserDataCategory, UserDataScope, UserDataSummary } from '../services/userData';

/**
 * A byte count from this API, rendered for a person.
 *
 * The API sends decimal STRINGS because it sums Postgres `BIGINT` columns (see
 * `services/userData.ts`'s header). `formatBytes` is reused rather than
 * reimplemented — a third copy of the unit loop in this repository is not worth
 * avoiding one `Number()` call — and the parse is the only thing added: a value
 * that is absent or unparseable renders as an em dash rather than a confident
 * "0 B", because a zero here would read as "you have nothing stored" next to a
 * button that deletes something.
 *
 * ⚠ The `Number()` can lose integer precision above 2^53, and that is accepted
 * deliberately: the loss lands far below the one significant decimal a
 * human-readable "9.2 EB" shows, and this value is never sent back, compared or
 * summed — it is formatted and discarded. Summation happens in `BigInt` below,
 * before this is ever called.
 */
export function formatDataSize(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  return formatBytes(bytes);
}

/**
 * One countable thing a scope destroys, singular and plural.
 *
 * `credentials` is deliberately absent: it is not one noun but two independent
 * counts (`aiKeys`, `accessTokens`), each worth naming in full, so it is
 * handled separately below rather than being forced into this shape.
 */
const CATEGORY_NOUNS: Record<
  Exclude<UserDataCategory, 'credentials'>,
  [singular: string, plural: string]
> = {
  transcripts: ['recording', 'recordings'],
  notes: ['note', 'notes'],
  noteTemplates: ['note template', 'note templates'],
  files: ['file', 'files'],
};

/** "1 note" / "4 notes" — never a bare number, never a bare noun. */
function countPhrase(count: number, [singular, plural]: [string, string]): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * "a", "a and b", "a, b and c" — no Oxford comma, matching the prose
 * everywhere else in this feature.
 */
function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * What a scope is about to destroy, in numbers, right now.
 *
 * =============================================================================
 * WHY THIS SENTENCE EXISTS
 * =============================================================================
 *
 * A confirmation for an irreversible action should state what is actually going
 * to be destroyed, and "every recording, note, note template and uploaded file"
 * states a CATEGORY, not a quantity. Four things and four thousand things are
 * different decisions, and the page's own inventory — which does show the
 * numbers — is behind the modal at the exact instant the user is making that
 * decision. So the numbers come with the dialog.
 *
 * =============================================================================
 * DERIVED FROM `scopeIncludes`, NEVER FROM A LIST OF CATEGORIES PER SCOPE
 * =============================================================================
 *
 * ⚠ Do not "simplify" this by writing out which categories `content` and
 * `everything` cover. That is the same rule the server owns, respelled inside a
 * component, where nothing connects it to the function that actually decides —
 * which is precisely how this feature's earlier "deleting notes also deletes
 * your templates" copy came to be wrong and had to be reversed. Every question
 * this function asks about scope membership goes through `scopeIncludes`, and
 * whether a scope gets a sentence at all goes through `scopeIsCompound`, so a
 * change on the server is a change to one mirrored `switch` and this sentence
 * follows it.
 *
 * Returns `null` — no sentence at all — in the two cases where one would be
 * noise or a lie:
 *
 *   • A NARROW SCOPE. It names one category, whose count the user just read on
 *     the row they clicked; restating it in the dialog adds nothing.
 *   • NO SUMMARY. A confirmation that stated counts it could not read would be
 *     worse than one that states none.
 *
 * ZERO-COUNT CATEGORIES ARE OMITTED rather than printed as "0 notes": a list of
 * zeroes buries the one number that is not zero, and "0 notes" invites the
 * reader to check whether it means "none" or "not counted".
 */
export function buildDeletionInventory(
  scope: UserDataScope,
  summary: UserDataSummary | null,
): string | null {
  if (!summary) return null;
  if (!scopeIsCompound(scope)) return null;

  const parts: string[] = [];
  // `BigInt`, not `+`: these are `BIGINT` sums on the wire precisely because a
  // large media library exceeds the safe integer range, and adding three of
  // them as doubles would reintroduce the rounding the string representation
  // exists to avoid. The single lossy step is `formatDataSize`, at the end,
  // where the loss is far below the one decimal it prints.
  let totalBytes = 0n;

  for (const category of USER_DATA_CATEGORIES) {
    if (!scopeIncludes(scope, category)) continue;

    if (category === 'credentials') {
      // Two independent counts, each named in full. For `everything` these are
      // the single thing that scope adds over `content`, and a count is the
      // clearest possible statement of it — "2 personal access tokens" says
      // what "your credentials" cannot.
      const { aiKeys, accessTokens } = summary.credentials;
      if (aiKeys > 0) {
        parts.push(countPhrase(aiKeys, ['AI provider key', 'AI provider keys']));
      }
      if (accessTokens > 0) {
        parts.push(
          countPhrase(accessTokens, ['personal access token', 'personal access tokens']),
        );
      }
      continue;
    }

    const entry = summary[category];
    if (entry.count <= 0) continue;
    parts.push(countPhrase(entry.count, CATEGORY_NOUNS[category]));

    // Note templates are rows of text with no storage object behind them, so
    // the summary reports no `bytes` for them at all. The total is therefore
    // genuinely the total of everything that has a size, with nothing silently
    // excluded from it.
    if ('bytes' in entry) {
      try {
        totalBytes += BigInt(entry.bytes);
      } catch {
        // An unparseable count is dropped from the TOTAL rather than being
        // allowed to throw and take the whole sentence — including the item
        // counts, which are still perfectly good — down with it.
      }
    }
  }

  if (parts.length === 0) {
    return 'There is nothing stored for your account right now.';
  }

  const size = totalBytes > 0n ? ` (${formatDataSize(totalBytes.toString())} in total)` : '';
  return `Right now that is ${joinPhrases(parts)}${size}.`;
}

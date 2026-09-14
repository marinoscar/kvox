/**
 * The Notes tab's status filter options — issue #57, epic #45.
 *
 * A SEPARATE MODULE from the view, exactly like `transcriptsLibraryFilters.ts`,
 * so a test can assert the list without mounting anything and so the "Any"
 * sentinel is defined once. `'all'` is a UI value the API knows nothing about:
 * `GET /api/notes` filters by OMITTING `status`, never by a magic value, so the
 * view translates rather than forwarding it.
 *
 * `draft` is deliberately absent as a user-facing choice and `deleting`
 * deliberately present. `draft` is the API's word for "created, never generated
 * even once" — a state a note passes through in the seconds between pressing
 * Generate and the first token, which nobody would ever filter FOR and which
 * "Generating" already covers in the only way a reader means it. `deleting` is
 * a state a note genuinely sits in while its purge job runs, and a user who has
 * just deleted something and wants to know whether it is gone has nowhere else
 * to look — the same argument `transcriptsLibraryFilters.ts` makes for offering
 * it there.
 */

import type { NoteStatus } from '../services/notes';

export interface NoteStatusFilterOption {
  value: NoteStatus | 'all';
  label: string;
}

export const NOTE_STATUS_FILTERS: readonly NoteStatusFilterOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'generating', label: 'Generating' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed', label: 'Failed' },
  { value: 'deleting', label: 'Deleting' },
];

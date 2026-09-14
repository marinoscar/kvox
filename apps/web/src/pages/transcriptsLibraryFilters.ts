/**
 * The library's status filter options — issue #30, epic #19.
 *
 * A SEPARATE MODULE from the page, so a test can assert the list without
 * mounting the page, and so the "Any" sentinel is defined once. `'all'` is a
 * UI value the API knows nothing about: `GET /api/transcripts` filters by
 * OMITTING `status`, never by a magic value, so the page translates rather than
 * forwarding it.
 *
 * `deleting` is deliberately offered. It is a real, visible state a transcript
 * can sit in for minutes while its purge job removes multi-gigabyte objects,
 * and a user who just deleted something and wants to know whether it is gone
 * has nowhere else to look.
 */

import type { TranscriptStatus } from '../services/transcripts';

export interface TranscriptStatusFilterOption {
  value: TranscriptStatus | 'all';
  label: string;
}

export const TRANSCRIPT_STATUS_FILTERS: readonly TranscriptStatusFilterOption[] = [
  { value: 'all', label: 'Any status' },
  { value: 'uploading', label: 'Uploading' },
  { value: 'processing', label: 'Processing' },
  { value: 'ready', label: 'Ready' },
  { value: 'failed', label: 'Failed' },
  { value: 'deleting', label: 'Deleting' },
];

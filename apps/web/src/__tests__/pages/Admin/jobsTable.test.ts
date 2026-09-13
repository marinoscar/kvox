/**
 * Admin → Operations → Jobs: the column contract and its pure helpers
 * (issue #266, epic #254).
 *
 * These are asserted WITHOUT mounting the page, which is the whole reason
 * `jobsTable.tsx` is a sibling module rather than columns inlined in
 * `JobsPage.tsx`: the column list is the table's public shape, and the rules it
 * encodes — what the endpoint can serve, what a `none` duration must render as,
 * which two filters cannot coexist — are decidable from the declaration alone.
 *
 * The page test covers the same exclusivity rule once more THROUGH THE UI, so
 * this file proves the rule and that one proves it is wired.
 */

import { describe, it, expect } from 'vitest';
import type { DataTableFilterModel } from '../../../components/datatable';
import {
  PROCESSED_WITHIN_COLUMN_ID,
  SCHEDULED_COLUMN_ID,
  SCHEDULED_FILTER_VALUE,
  STATUS_COLUMN_ID,
  TABLE_ID,
  TYPE_COLUMN_ID,
  asJobStatus,
  asProcessedWithin,
  buildJobColumns,
  enforceExclusiveJobFilters,
  formatDuration,
  readIsFilter,
} from '../../../pages/Admin/jobsTable';

const TYPE_OPTIONS = [
  { value: 'image.thumbnail', label: 'Thumbnail' },
  { value: 'email.send', label: 'Send email' },
];

function columns() {
  return buildJobColumns(TYPE_OPTIONS);
}

function columnById(id: string) {
  return columns().find((column) => column.id === id);
}

function filter(columnId: string, value: string) {
  return { columnId, operator: 'is' as const, value };
}

describe('jobsTable — what the endpoint can actually serve', () => {
  it('declares NO sortable column, because GET /api/admin/jobs has no sortBy', () => {
    // `job-admin.service.ts` orders by `createdAt DESC` and offers nothing
    // else. A sortable header would be a control the server cannot honour —
    // the same failure as a filter it cannot answer, and the reason this is
    // asserted rather than left to a comment.
    expect(columns().filter((column) => column.sortable)).toEqual([]);
  });

  it('declares NO searchable column, because the endpoint has no free-text parameter', () => {
    expect(columns().filter((column) => column.searchable)).toEqual([]);
  });

  it('offers a filter on exactly the four query parameters the page sends', () => {
    const filterable = columns()
      .filter((column) => column.filterable)
      .map((column) => column.id);

    expect(filterable.sort()).toEqual(
      [
        PROCESSED_WITHIN_COLUMN_ID,
        SCHEDULED_COLUMN_ID,
        STATUS_COLUMN_ID,
        TYPE_COLUMN_ID,
      ].sort(),
    );
  });

  it('offers the statuses the API enum accepts, and no others', () => {
    expect(columnById(STATUS_COLUMN_ID)?.enumValues?.map((entry) => entry.value)).toEqual([
      'pending',
      'running',
      'succeeded',
      'failed',
    ]);
  });

  it('builds the type filter from the deployment’s own job types', () => {
    // Taken from `GET /stats`'s `byType`, never hardcoded: a fixed list would
    // offer filters for types that have never run and omit the ones that have.
    expect(columnById(TYPE_COLUMN_ID)?.enumValues).toEqual(TYPE_OPTIONS);
  });

  it('keeps `scheduled` and `processedWithin` filterOnly — they are query bounds, not row properties', () => {
    expect(columnById(SCHEDULED_COLUMN_ID)?.filterOnly).toBe(true);
    expect(columnById(PROCESSED_WITHIN_COLUMN_ID)?.filterOnly).toBe(true);
  });

  it('offers `scheduled` ONE value, because scheduled=false means the same as no filter', () => {
    expect(columnById(SCHEDULED_COLUMN_ID)?.enumValues).toEqual([
      { value: SCHEDULED_FILTER_VALUE, label: 'Waiting out a backoff' },
    ]);
  });

  it('omits `all` from processedWithin — it is the API default, not a constraint', () => {
    const values = columnById(PROCESSED_WITHIN_COLUMN_ID)?.enumValues?.map((e) => e.value);
    expect(values).toEqual(['4h', '24h', '7d', '30d']);
    expect(values).not.toContain('all');
  });

  it('pins the first primary column visible, since it names every row control', () => {
    const [first] = columns();
    expect(first.id).toBe(TYPE_COLUMN_ID);
    expect(first.priority).toBe('primary');
    expect(first.hideable).toBe(false);
  });

  it('gives each row a UNIQUE accessible name, not just its job type', () => {
    // Two jobs of one type are the normal case in a queue. A scalar of
    // "Thumbnail" alone would name a screenful of buttons identically.
    const [first] = columns();
    const a = first.value?.({ id: 'aaaaaaaa-1111', typeLabel: 'Thumbnail' } as never);
    const b = first.value?.({ id: 'bbbbbbbb-2222', typeLabel: 'Thumbnail' } as never);

    expect(a).not.toEqual(b);
    expect(a).toContain('Thumbnail');
    expect(a).toContain('aaaaaaaa');
  });

  it('uses a storage-key table id that is not derived from the route', () => {
    expect(TABLE_ID).toBe('admin-jobs');
  });
});

describe('jobsTable — narrowing values that came from stored JSON', () => {
  it('accepts the four real statuses and rejects anything else', () => {
    expect(asJobStatus('failed')).toBe('failed');
    expect(asJobStatus('sideways')).toBeUndefined();
    expect(asJobStatus(undefined)).toBeUndefined();
  });

  it('accepts the four real windows, and rejects `all` — which is sent as nothing', () => {
    expect(asProcessedWithin('24h')).toBe('24h');
    expect(asProcessedWithin('all')).toBeUndefined();
    expect(asProcessedWithin('99y')).toBeUndefined();
  });

  it('reads an `is` filter as a scalar, ignoring other operators on the same column', () => {
    const model: DataTableFilterModel = [
      { columnId: STATUS_COLUMN_ID, operator: 'isNot', value: 'failed' },
      filter(STATUS_COLUMN_ID, 'running'),
    ];
    expect(readIsFilter(model, STATUS_COLUMN_ID)).toBe('running');
    expect(readIsFilter(model, TYPE_COLUMN_ID)).toBeUndefined();
  });
});

/**
 * The rule that keeps the filter chips honest. `scheduled=true` OVERRIDES
 * `status` on the server, so with both applied the chip bar would advertise a
 * constraint that was never applied.
 */
describe('enforceExclusiveJobFilters', () => {
  it('drops `status` when `scheduled` is the filter just added', () => {
    const previous: DataTableFilterModel = [filter(STATUS_COLUMN_ID, 'failed')];
    const next: DataTableFilterModel = [
      filter(STATUS_COLUMN_ID, 'failed'),
      filter(SCHEDULED_COLUMN_ID, SCHEDULED_FILTER_VALUE),
    ];

    expect(enforceExclusiveJobFilters(next, previous)).toEqual([
      filter(SCHEDULED_COLUMN_ID, SCHEDULED_FILTER_VALUE),
    ]);
  });

  it('drops `scheduled` when `status` is the filter just added', () => {
    const previous: DataTableFilterModel = [
      filter(SCHEDULED_COLUMN_ID, SCHEDULED_FILTER_VALUE),
    ];
    const next: DataTableFilterModel = [
      filter(SCHEDULED_COLUMN_ID, SCHEDULED_FILTER_VALUE),
      filter(STATUS_COLUMN_ID, 'failed'),
    ];

    expect(enforceExclusiveJobFilters(next, previous)).toEqual([
      filter(STATUS_COLUMN_ID, 'failed'),
    ]);
  });

  it('leaves every other combination untouched, including type + one of the two', () => {
    const previous: DataTableFilterModel = [];
    const next: DataTableFilterModel = [
      filter(TYPE_COLUMN_ID, 'email.send'),
      filter(PROCESSED_WITHIN_COLUMN_ID, '24h'),
      filter(STATUS_COLUMN_ID, 'failed'),
    ];

    expect(enforceExclusiveJobFilters(next, previous)).toEqual(next);
  });

  it('is a no-op when neither of the two exclusive filters is present', () => {
    const next: DataTableFilterModel = [filter(TYPE_COLUMN_ID, 'email.send')];
    expect(enforceExclusiveJobFilters(next, [])).toBe(next);
  });
});

describe('formatDuration', () => {
  it('renders an em dash for a null, never a zero', () => {
    // The API's nullable durations mean "no succeeded jobs to measure". A "0
    // ms" would state a measurement that was never taken.
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });

  it('renders a real zero as a real zero', () => {
    expect(formatDuration(0)).toBe('0 ms');
  });

  it('steps up through ms, seconds, minutes, hours and days', () => {
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_600_000 + 900_000)).toBe('1h 15m');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
  });
});

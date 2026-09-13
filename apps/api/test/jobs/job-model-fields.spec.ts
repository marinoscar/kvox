// =============================================================================
// Locks down the generated `Job` scalar field name set (issue #255, epic #254)
// =============================================================================
//
// #260's claim query (`src/jobs/job-claim.service.ts`) `RETURNING`s every one
// of these columns under a camelCase alias, so its rows type-match the
// generated `Job` with no remapping step. This spec is what that alias list
// is checked against, so a field getting renamed (or the set changing at all)
// is caught here — as a KEY SET mismatch naming the field — rather than as a
// silently `undefined` property discovered somewhere downstream.
// `Prisma.JobScalarFieldEnum` is generated straight from
// `prisma/schema.prisma` by `prisma generate` — asserting against it, not a
// hand-copied list read off the schema file, is what makes this spec fail
// the moment the two actually disagree.
//
// Note the division of labour with the claim service itself: `JOB_CLAIM_COLUMNS`
// is typed `Record<keyof Job, string>`, so a missing or stale key is already a
// COMPILE error. This spec adds the half a type cannot check — that the map's
// keys are the same set the generated field enum reports, and that no column
// was quietly mapped to the wrong physical name.
// =============================================================================

import { Prisma } from '@prisma/client';

import { JOB_CLAIM_COLUMNS } from '../../src/jobs/job-claim.service';

describe('Prisma.JobScalarFieldEnum', () => {
  it('has exactly the field names Job is documented to have', () => {
    const expected = [
      'id',
      'type',
      'subjectType',
      'subjectId',
      'dedupKey',
      'status',
      'reason',
      'priority',
      'providerKey',
      'modelVersion',
      'payload',
      'attempts',
      'lastError',
      'createdAt',
      'startedAt',
      'finishedAt',
      'scheduledFor',
      'rateLimitedAt',
      'rateLimitHits',
      'claimedByNodeId',
      'leaseExpiresAt',
      'executor',
    ].sort();

    const actual = Object.keys(Prisma.JobScalarFieldEnum).sort();

    expect(actual).toEqual(expected);
  });

  it('maps every field name to itself, matching how Prisma builders reference it', () => {
    for (const field of Object.keys(Prisma.JobScalarFieldEnum)) {
      expect(Prisma.JobScalarFieldEnum[field as keyof typeof Prisma.JobScalarFieldEnum]).toBe(
        field
      );
    }
  });
});

describe("JOB_CLAIM_COLUMNS (the claim query's RETURNING aliases)", () => {
  it('covers exactly the generated Job field set — no field missing, none invented', () => {
    // The claim's `RETURNING` clause is derived from this map, so this is the
    // assertion that a schema change cannot drift past: add a column to `Job`
    // without adding it here and the sets differ; the failure names the field.
    expect(Object.keys(JOB_CLAIM_COLUMNS).sort()).toEqual(
      Object.keys(Prisma.JobScalarFieldEnum).sort()
    );
  });

  it('maps every field to a non-empty snake_case-or-identical column name', () => {
    // A cheap guard against the one mistake the key-set check above cannot
    // see: a right-hand side that is empty, or that has camelCase left in it
    // (`subjectType` instead of `subject_type`), which would produce SQL that
    // fails at run time rather than at compile time.
    for (const [field, column] of Object.entries(JOB_CLAIM_COLUMNS)) {
      expect(column).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(column.replace(/_/g, '')).toBe(field.toLowerCase());
    }
  });
});

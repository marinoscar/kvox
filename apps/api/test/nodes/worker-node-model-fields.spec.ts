// =============================================================================
// Locks down the generated `WorkerNode` / `NodeCredential` scalar field name
// sets (issue #267, epic #254)
// =============================================================================
//
// This is the schema-only half of #267 — the service, the guard's `nod_`
// branch, and the `/api/node-credentials` endpoints all arrive in the
// backend half of the same issue, and the node control plane that actually
// mutates `WorkerNode` rows is #268. What can be locked down here, before any
// of that exists, is the field set itself: a column renamed or dropped on
// either model should fail loudly, here, naming the field — not surface
// later as a silently `undefined` property in the service #268 builds on top
// of this schema. Same purpose and same technique as
// `test/jobs/job-model-fields.spec.ts`, asserted against
// `Prisma.WorkerNodeScalarFieldEnum` / `Prisma.NodeCredentialScalarFieldEnum`
// (generated straight from `prisma/schema.prisma` by `prisma generate`)
// rather than a hand-copied list read off the schema file, so this spec
// fails the moment the two actually disagree.
// =============================================================================

import { NodeStatus, Prisma } from '@prisma/client';

import { OWNER_SELECT } from '../../src/nodes/nodes-admin.service';
import { CREDENTIAL_OWNER_SELECT } from '../../src/nodes/node-credential.service';

describe('Prisma.WorkerNodeScalarFieldEnum', () => {
  it('has exactly the field names WorkerNode is documented to have', () => {
    const expected = [
      'id',
      'name',
      'hostname',
      'platform',
      'cliVersion',
      'eligibleTypes',
      'concurrency',
      'status',
      'capabilities',
      'registeredAt',
      'lastHeartbeatAt',
      'createdById',
    ].sort();

    const actual = Object.keys(Prisma.WorkerNodeScalarFieldEnum).sort();

    expect(actual).toEqual(expected);
  });

  it('maps every field name to itself, matching how Prisma builders reference it', () => {
    for (const field of Object.keys(Prisma.WorkerNodeScalarFieldEnum)) {
      expect(
        Prisma.WorkerNodeScalarFieldEnum[field as keyof typeof Prisma.WorkerNodeScalarFieldEnum]
      ).toBe(field);
    }
  });
});

describe('Prisma.NodeCredentialScalarFieldEnum', () => {
  it('has exactly the field names NodeCredential is documented to have', () => {
    // Deliberately mirrors PersonalAccessToken minus the duration bookkeeping
    // (durationValue/durationUnit) — see the block comment above
    // `NodeCredential` in prisma/schema.prisma for why `expiresAt` is
    // nullable here even though it is required on PersonalAccessToken.
    const expected = [
      'id',
      'userId',
      'name',
      'tokenHash',
      'tokenPrefix',
      'expiresAt',
      'lastUsedAt',
      'createdAt',
      'revokedAt',
    ].sort();

    const actual = Object.keys(Prisma.NodeCredentialScalarFieldEnum).sort();

    expect(actual).toEqual(expected);
  });

  it('maps every field name to itself, matching how Prisma builders reference it', () => {
    for (const field of Object.keys(Prisma.NodeCredentialScalarFieldEnum)) {
      expect(
        Prisma.NodeCredentialScalarFieldEnum[
          field as keyof typeof Prisma.NodeCredentialScalarFieldEnum
        ]
      ).toBe(field);
    }
  });

  it('does NOT carry PersonalAccessToken\'s duration bookkeeping columns', () => {
    // The one deliberate structural divergence from PersonalAccessToken,
    // asserted directly so a future "just copy the PAT shape" edit is caught.
    const fields = Object.keys(Prisma.NodeCredentialScalarFieldEnum);
    expect(fields).not.toContain('durationValue');
    expect(fields).not.toContain('durationUnit');
  });
});

// =============================================================================
// The admin owner joins select real `User` columns (issue #340 regression)
// =============================================================================
//
// `NodesAdminService`/`NodeCredentialService` join `User` on three admin read
// paths (`GET /admin/nodes`, `GET /admin/nodes/:id`,
// `GET /admin/nodes/credentials`) with an explicit `select`, the same
// allowlist-select pattern used everywhere else in this file. #340 was that
// select naming `name` — a column `User` has never had; the real column is
// `displayName` (`@map("display_name")`). Every existing test for this area
// mocked `PrismaService`, so the invalid select sailed through mocks and only
// broke against the real client. Asserting the select's keys against
// `Prisma.UserScalarFieldEnum` — generated from `schema.prisma`, not a
// hand-copied list — is what makes this fail the moment a select and the
// schema disagree again, without needing a database.
// =============================================================================

describe('Prisma.UserScalarFieldEnum', () => {
  it('contains displayName and does NOT contain name — the exact fact #340 got wrong', () => {
    const fields = Object.keys(Prisma.UserScalarFieldEnum);

    expect(fields).toContain('displayName');
    expect(fields).not.toContain('name');
  });
});

describe('admin owner selects', () => {
  const userFields = new Set(Object.keys(Prisma.UserScalarFieldEnum));

  it('NodesAdminService.OWNER_SELECT names only real User scalar columns', () => {
    const keys = Object.keys(OWNER_SELECT.select);

    expect(keys.length).toBeGreaterThan(0);
    const invalid = keys.filter((key) => !userFields.has(key));
    expect(invalid).toEqual([]);
    // Restated directly: this is the column #340 got wrong.
    expect(keys).not.toContain('name');
  });

  it('NodeCredentialService.CREDENTIAL_OWNER_SELECT names only real User scalar columns', () => {
    const keys = Object.keys(CREDENTIAL_OWNER_SELECT.select);

    expect(keys.length).toBeGreaterThan(0);
    const invalid = keys.filter((key) => !userFields.has(key));
    expect(invalid).toEqual([]);
    expect(keys).not.toContain('name');
  });
});

describe('NodeStatus enum', () => {
  it('has exactly the four documented states', () => {
    expect(Object.keys(NodeStatus).sort()).toEqual(
      ['online', 'draining', 'offline', 'disabled'].sort()
    );
  });

  it('maps every member to itself, matching how Prisma builders reference it', () => {
    for (const key of Object.keys(NodeStatus)) {
      expect(NodeStatus[key as keyof typeof NodeStatus]).toBe(key);
    }
  });
});

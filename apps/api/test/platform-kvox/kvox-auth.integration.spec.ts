// =============================================================================
// @KvoxAuth through the real guard stack (issue #490, epic #486)
// =============================================================================
//
// A probe controller beside the full `AppModule`, with the real identity slice, the real
// `PlatformKvoxIdentityAdapter` over `JwtAuthGuard`, and the app's real role graph (a
// Viewer holds `transcripts:read` and no `storage:write`; a Contributor holds both).
// Three outcomes, per the issue: 401 with no token, 403 for a caller who lacks the
// permission, 200 otherwise. And the permissionless route: `@KvoxAuth()` with no
// permission must still hand the handler a principal. The platform's own
// `PermissionsGuard` attaches its normalised user only when a route declares a
// permission, so an adapter that read that field would give such a route an EMPTY
// principal; this spec is what fails if the adapter ever does.
// =============================================================================

import { Controller, Get } from '@nestjs/common';
import request from 'supertest';

import { CurrentKvoxPrincipal, KvoxAuth } from '@marinoscar/kvox-api/core';
import type { KvoxPrincipal } from '@marinoscar/kvox-api/ports';

import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import { createMembershipContributor, createMembershipViewer } from '../helpers/membership-user.helper';
import { TestContext, closeTestApp, createTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';

@Controller('kvox-probe')
class KvoxProbeController {
  @Get('read')
  @KvoxAuth('transcripts:read')
  read(@CurrentKvoxPrincipal() who: KvoxPrincipal) {
    return who.userId;
  }

  @Get('write')
  @KvoxAuth('storage:write')
  write(@CurrentKvoxPrincipal() who: KvoxPrincipal) {
    return who.userId;
  }

  @Get('anyone')
  @KvoxAuth()
  anyone(@CurrentKvoxPrincipal() who: KvoxPrincipal) {
    return {
      userId: who.userId,
      orgId: who.orgId,
      roles: who.roles,
      permissions: [...who.permissions].sort(),
      isSet: who.permissions instanceof Set,
    };
  }
}

describe('@KvoxAuth through the real guard stack', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ controllers: [KvoxProbeController] });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
  });

  const get = (path: string) => request(context.app.getHttpServer()).get(`/api/kvox-probe/${path}`);

  it('answers 401 without a token', async () => {
    await get('read').expect(401);
    await get('anyone').expect(401);
  });

  it('answers 401 for a malformed token', async () => {
    await get('read').set(authHeader('malformed.token.here')).expect(401);
  });

  it('answers 403 naming the permission a Viewer lacks', async () => {
    const viewer = await createMembershipViewer(context);

    const response = await get('write').set(authHeader(viewer.accessToken)).expect(403);

    expect(response.body.message).toContain('storage:write');
  });

  it('answers 200 for a Viewer on a permission a Viewer holds', async () => {
    const viewer = await createMembershipViewer(context);

    const response = await get('read').set(authHeader(viewer.accessToken)).expect(200);

    expect(JSON.stringify(response.body)).toContain(viewer.id);
  });

  it('answers 200 for a Contributor on the permission the Viewer lacked', async () => {
    const contributor = await createMembershipContributor(context);

    await get('write').set(authHeader(contributor.accessToken)).expect(200);
  });

  it('gives a permissionless route a full principal, not an empty one', async () => {
    const viewer = await createMembershipViewer(context);

    const response = await get('anyone').set(authHeader(viewer.accessToken)).expect(200);
    const principal = response.body.data ?? response.body;

    expect(principal.userId).toBe(viewer.id);
    expect(principal.isSet).toBe(true);
    expect(principal.orgId).toBe('org-default');
    expect(principal.roles).toContain('viewer');
    expect(principal.permissions).toEqual(expect.arrayContaining(['transcripts:read', 'notes:read']));
    expect(principal.permissions).not.toContain('storage:write');
  });
});

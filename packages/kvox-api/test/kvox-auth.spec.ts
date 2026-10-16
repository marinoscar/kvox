import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  CurrentKvoxPrincipal,
  KVOX_PERMISSIONS_KEY,
  KVOX_PRINCIPAL_REQUEST_KEY,
  KvoxAuth,
  KvoxAuthGuard,
} from '../src/core/index.js';
import type { KvoxIdentityPort } from '../src/ports/index.js';
import {
  createFakeKvoxExecutionContext,
  createFakeKvoxIdentity,
  kvoxPrincipal,
} from '../src/testing/index.js';

// A handler decorated for real, so the guard reads real metadata.
class Controller {
  @KvoxAuth('things:read', 'things:write')
  both(): void {}

  @KvoxAuth()
  anyone(): void {}
}

function contextFor(method: 'both' | 'anyone', headers: Record<string, string>) {
  const context = createFakeKvoxExecutionContext(headers);
  (context as unknown as { getHandler: () => unknown }).getHandler = () => Controller.prototype[method];
  (context as unknown as { getClass: () => unknown }).getClass = () => Controller;
  return context;
}

describe('KvoxAuthGuard', () => {
  const guardFor = (identity: KvoxIdentityPort) => new KvoxAuthGuard(identity, new Reflector());

  it('records the permissions KvoxAuth declared', () => {
    expect(Reflect.getMetadata(KVOX_PERMISSIONS_KEY, Controller.prototype.both)).toEqual(['things:read', 'things:write']);
    expect(Reflect.getMetadata(KVOX_PERMISSIONS_KEY, Controller.prototype.anyone)).toEqual([]);
  });

  it('answers 401 when the identity port returns no principal', async () => {
    const guard = guardFor(createFakeKvoxIdentity());
    await expect(guard.canActivate(contextFor('anyone', {}))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 403 naming the missing permission', async () => {
    const guard = guardFor(createFakeKvoxIdentity({ principal: kvoxPrincipal({ permissions: ['things:read'] }) }));
    const error = await guard.canActivate(contextFor('both', { authorization: 'Bearer x' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as Error).message).toContain('things:write');
  });

  it('admits a principal that holds every permission and stores it on the request', async () => {
    const principal = kvoxPrincipal({ permissions: ['things:read', 'things:write'] });
    const guard = guardFor(createFakeKvoxIdentity({ principal }));
    const context = contextFor('both', { authorization: 'Bearer x' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    const request = context.switchToHttp().getRequest<Record<symbol, unknown>>();
    expect(request[KVOX_PRINCIPAL_REQUEST_KEY]).toBe(principal);
  });

  it('admits an authenticated caller on a route that declares no permission', async () => {
    // The permissionless-route trap: the port normalises the principal, so a route
    // with no permission still gets one.
    const guard = guardFor(createFakeKvoxIdentity({ principal: kvoxPrincipal() }));
    await expect(guard.canActivate(contextFor('anyone', { authorization: 'Bearer x' }))).resolves.toBe(true);
  });

  it('never reads permissions off a raw request user', async () => {
    const identity: KvoxIdentityPort = {
      authenticate: async () => kvoxPrincipal({ permissions: [] }),
      hasPermission: async () => false,
    };
    const context = contextFor('both', { authorization: 'Bearer x' });
    const request = context.switchToHttp().getRequest<Record<string, unknown>>();
    request.user = { permissions: ['things:read', 'things:write'] };
    await expect(guardFor(identity).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CurrentKvoxPrincipal', () => {
  it('is a parameter decorator factory', () => {
    expect(typeof CurrentKvoxPrincipal()).toBe('function');
  });
});

import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ROLES } from '../constants/roles.constants';
import type { MaintenanceModeService, MaintenanceStatus } from './maintenance-mode.service';
import {
  MAINTENANCE_ERROR_MARKER,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  MaintenanceGuard,
  OPAQUE_BEARER_PREFIXES,
} from './maintenance.guard';
import { NODE_TOKEN_PREFIX } from '../../nodes/node-credential.service';

const SECRET = 'guard-spec-secret-guard-spec-secret';

describe('MaintenanceGuard', () => {
  const jwtService = new JwtService({ secret: SECRET });

  let reflector: { getAllAndOverride: jest.Mock };
  let maintenance: { resolve: jest.Mock };
  let guard: MaintenanceGuard;

  const status = (overrides: Partial<MaintenanceStatus> = {}): MaintenanceStatus =>
    ({
      enabled: true,
      message: 'Down for maintenance',
      allowAdmins: true,
      startedAt: null,
      startedById: null,
      source: 'persisted',
      layers: {
        env: { present: false, enabled: null },
        memory: { present: false, override: null },
        persisted: {
          readable: true,
          value: {
            enabled: true,
            message: 'Down for maintenance',
            allowAdmins: true,
            startedAt: null,
            startedById: null,
          },
        },
      },
      ...overrides,
    }) as MaintenanceStatus;

  /** A context whose request carries `authorization`, and a spyable reply. */
  const makeContext = (authorization?: string) => {
    const request: { headers: Record<string, string>; user?: unknown } = {
      headers: authorization ? { authorization } : {},
    };
    const response = { header: jest.fn() };

    const context = {
      getType: () => 'http',
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;

    return { context, request, response };
  };

  const bearer = (payload: Record<string, unknown>, options = {}) =>
    `Bearer ${jwtService.sign(payload, options)}`;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    maintenance = { resolve: jest.fn().mockResolvedValue(status()) };
    guard = new MaintenanceGuard(
      reflector as unknown as Reflector,
      maintenance as unknown as MaintenanceModeService,
      jwtService,
    );
  });

  describe('when no window is open', () => {
    it('lets everything through without looking at the request', async () => {
      maintenance.resolve.mockResolvedValue(status({ enabled: false }));
      const { context } = makeContext();

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('exemptions', () => {
    it('lets an @AllowDuringMaintenance() route through', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const { context } = makeContext();

      await expect(guard.canActivate(context)).resolves.toBe(true);
      // Not merely allowed — the state is never even resolved, so an exempt
      // route costs nothing and cannot fail on an unreadable database.
      expect(maintenance.resolve).not.toHaveBeenCalled();
    });

    it('reads the flag from the handler AND the controller', async () => {
      const { context } = makeContext();
      await guard.canActivate(context).catch(() => undefined);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        'allowDuringMaintenance',
        [expect.any(Function), expect.any(Function)],
      );
    });

    it('exempts an opaque bearer too — the exemption is checked FIRST', async () => {
      // Why this ordering matters operationally: it is what lets an already
      // logged-in CLI (a `pat_` holder) close a window it is otherwise blocked
      // by, without a browser. Documented in
      // docs/runbooks/maintenance-mode.md §6.
      reflector.getAllAndOverride.mockReturnValue(true);
      const { context } = makeContext('Bearer pat_0123456789abcdef');

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('does not interfere with non-HTTP contexts', async () => {
      const context = {
        getType: () => 'rpc',
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
      } as unknown as ExecutionContext;

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });
  });

  describe('the 503 it throws', () => {
    it('carries the stable marker under `details`, where the filter keeps it', async () => {
      const { context } = makeContext();

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      try {
        await guard.canActivate(context);
      } catch (error) {
        const body = (error as ServiceUnavailableException).getResponse() as {
          message: string;
          details: Record<string, unknown>;
        };
        expect(body.message).toBe('Down for maintenance');
        expect(body.details).toMatchObject({
          reason: MAINTENANCE_ERROR_MARKER,
          retryAfterSeconds: MAINTENANCE_RETRY_AFTER_SECONDS,
          allowAdmins: true,
        });
      }
    });

    it('sets Retry-After on the reply before it throws', async () => {
      const { context, response } = makeContext();

      await expect(guard.canActivate(context)).rejects.toThrow();

      expect(response.header).toHaveBeenCalledWith(
        'Retry-After',
        String(MAINTENANCE_RETRY_AFTER_SECONDS),
      );
    });

    it('shows the operator’s message rather than a generic one', async () => {
      maintenance.resolve.mockResolvedValue(
        status({ message: 'Upgrading the database, back at 03:00 UTC' }),
      );
      const { context } = makeContext();

      await expect(guard.canActivate(context)).rejects.toThrow(
        'Upgrading the database, back at 03:00 UTC',
      );
    });
  });

  describe('the admin bypass, which this guard resolves itself', () => {
    const adminToken = () =>
      bearer({ sub: 'user-1', email: 'a@example.com', roles: [ROLES.ADMIN] });

    it('admits a verified admin JWT while allowAdmins is true', async () => {
      const { context } = makeContext(adminToken());

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('NEVER populates request.user', async () => {
      // A global guard that authenticated would be a second front door into
      // every route in the application, bypassing the disabled-user check and
      // the PAT lookup that `JwtAuthGuard` performs. This guard answers one
      // yes/no question and gets out of the way; `JwtAuthGuard` still runs.
      const { context, request } = makeContext(adminToken());

      await guard.canActivate(context);

      expect(request.user).toBeUndefined();
      expect('user' in request).toBe(false);
    });

    it('blocks an admin when allowAdmins is false', async () => {
      maintenance.resolve.mockResolvedValue(status({ allowAdmins: false }));
      const { context } = makeContext(adminToken());

      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('blocks a verified non-admin', async () => {
      const { context } = makeContext(
        bearer({ sub: 'user-2', roles: [ROLES.VIEWER, ROLES.CONTRIBUTOR] }),
      );

      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it.each([
      ['a token signed with another key', `Bearer ${new JwtService({ secret: 'other-secret-other-secret-other' }).sign({ roles: [ROLES.ADMIN] })}`],
      ['an expired token', undefined],
      ['a token that is not a JWT at all', 'Bearer not-a-jwt'],
      ['a malformed header', 'Basic abc'],
      ['an empty bearer', 'Bearer '],
      ['no header at all', undefined],
    ])('treats %s as "not an admin", never as a rejection', async (label, header) => {
      const authorization =
        label === 'an expired token'
          ? bearer({ roles: [ROLES.ADMIN] }, { expiresIn: '-1s' })
          : header;
      const { context } = makeContext(authorization);

      // The distinction that matters: a 503 (which is TRUE — the application
      // is out of service) rather than a 401, which would change the status
      // every unauthenticated caller sees on every route the moment a window
      // opens.
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('enumerates the SAME `nod_` prefix the node credential service mints', () => {
      // A LINKING ASSERTION, not a tautology. `NodeCredentialService` mints
      // the prefix, `JwtAuthGuard` routes on it, and this guard refuses it
      // the admin bypass — three files that must agree. Renaming the family
      // in one of them would not break a compile: the token would simply
      // stop matching here and silently regain the bypass it is supposed to
      // be denied. Comparing against the exported constant is what turns
      // that into a test failure.
      expect(OPAQUE_BEARER_PREFIXES).toContain(NODE_TOKEN_PREFIX);
    });

    it.each(['pat_', 'nod_'])(
      'never grants the bypass to a %s bearer',
      async (prefix) => {
        // Opaque credentials: no claims to read, a database round trip to
        // resolve, and they belong to unattended clients — which are exactly
        // the callers a window is asking to back off.
        const { context } = makeContext(`Bearer ${prefix}abcdef0123456789`);

        await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
          ServiceUnavailableException,
        );
      },
    );

    it('does not grant the bypass to a JWT whose roles claim is not an array', async () => {
      const { context } = makeContext(bearer({ sub: 'u', roles: 'admin' }));

      await expect(guard.canActivate(context)).rejects.toThrow();
    });

    it('does not grant the bypass to a JWT with no roles claim', async () => {
      const { context } = makeContext(bearer({ sub: 'u' }));

      await expect(guard.canActivate(context)).rejects.toThrow();
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard, NODE_ROUTE_PREFIX } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PatService } from '../../pat/pat.service';
import { NodeCredentialService } from '../../nodes/node-credential.service';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: jest.Mocked<Reflector>;
  let patService: jest.Mocked<PatService>;
  let nodeCredentialService: jest.Mocked<NodeCredentialService>;

  beforeEach(async () => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    patService = {
      validateToken: jest.fn(),
    } as any;

    nodeCredentialService = {
      validateToken: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        { provide: Reflector, useValue: reflector },
        { provide: PatService, useValue: patService },
        { provide: NodeCredentialService, useValue: nodeCredentialService },
      ],
    }).compile();

    guard = module.get<JwtAuthGuard>(JwtAuthGuard);

    // Mock super.canActivate to avoid Passport initialization
    jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createMockContext(authorizationHeader?: string, url?: string): ExecutionContext {
    const request: any = {};
    if (authorizationHeader !== undefined) {
      request.headers = { authorization: authorizationHeader };
    }
    // `url` is what `isNodeRoute` reads (via `originalUrl ?? url`). Left
    // undefined by default so the pre-#267 cases below exercise exactly the
    // request shape they always did.
    if (url !== undefined) {
      request.url = url;
    }
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({
          code: jest.fn().mockReturnThis(),
          send: jest.fn(),
        }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as any;
  }

  describe('canActivate', () => {
    it('should return true for routes marked with @Public() decorator', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockContext();

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });

    it('should call super.canActivate() for protected routes', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
      expect(superSpy).toHaveBeenCalledWith(context);
    });

    it('should skip JWT validation when isPublic is true', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      const result = await guard.canActivate(context);

      // Should return true without calling super.canActivate
      expect(result).toBe(true);
      expect(reflector.getAllAndOverride).toHaveBeenCalled();
      expect(superSpy).not.toHaveBeenCalled();
    });

    it('should check both handler and class for @Public() decorator', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();

      guard.canActivate(context);

      // getAllAndOverride is called with both handler and class targets
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
      const callArgs = reflector.getAllAndOverride.mock.calls[0][1];
      expect(callArgs).toHaveLength(2); // Handler and class
    });
  });

  describe('Public decorator precedence', () => {
    it('should handle undefined isPublic metadata', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      // undefined means not public, should call super.canActivate
      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalled();
    });

    it('should handle null isPublic metadata', () => {
      reflector.getAllAndOverride.mockReturnValue(null);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      // null means not public, should call super.canActivate
      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalled();
    });

    it('should handle false isPublic metadata explicitly', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate');

      guard.canActivate(context);

      expect(superSpy).toHaveBeenCalled();
    });
  });

  describe('Reflector metadata retrieval', () => {
    it('should use getAllAndOverride to check decorator precedence', () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const context = createMockContext();

      guard.canActivate(context);

      // getAllAndOverride checks handler first, then class
      // This ensures method-level @Public() takes precedence over class-level
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });

    it('should pass correct metadata key to reflector', () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const context = createMockContext();

      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.any(Array));
    });
  });

  // ============================================================================
  // PAT handling: Bearer pat_... tokens
  // ============================================================================

  describe('PAT token handling', () => {
    it('should route Bearer pat_... tokens to PatService.validateToken', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        isActive: true,
        userRoles: [],
      };
      patService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer pat_abc123def456');
      const request = context.switchToHttp().getRequest();

      const result = await guard.canActivate(context);

      expect(patService.validateToken).toHaveBeenCalledWith('pat_abc123def456');
      expect(result).toBe(true);
      expect(request.user).toBe(mockUser);
    });

    it('should set request.user to the AuthenticatedUser returned by PatService', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const mockUser = {
        id: 'user-456',
        email: 'user@example.com',
        isActive: true,
        userRoles: [
          {
            role: {
              name: 'contributor',
              rolePermissions: [],
            },
          },
        ],
      };
      patService.validateToken.mockResolvedValue(mockUser as any);

      const context = createMockContext('Bearer pat_mytoken123');
      const request = context.switchToHttp().getRequest();

      await guard.canActivate(context);

      expect(request.user).toEqual(mockUser);
    });

    it('should throw UnauthorizedException when PAT is invalid (validateToken returns null)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      patService.validateToken.mockResolvedValue(null);

      const context = createMockContext('Bearer pat_invalidtoken');

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow(
        'Invalid or expired personal access token',
      );
    });

    it('should NOT route non-PAT Bearer tokens to PatService', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);

      const context = createMockContext('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');

      await guard.canActivate(context);

      expect(patService.validateToken).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalledWith(context);
    });

    it('should NOT route requests without Authorization header to PatService', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const superSpy = jest.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate').mockReturnValue(true);

      const context = createMockContext(undefined);

      await guard.canActivate(context);

      expect(patService.validateToken).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalledWith(context);
    });

    it('should NOT invoke PatService for @Public() routes even with pat_ token', async () => {
      reflector.getAllAndOverride.mockReturnValue(true); // route is public

      const context = createMockContext('Bearer pat_sometoken');

      const result = await guard.canActivate(context);

      expect(patService.validateToken).not.toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should pass the full raw token (with pat_ prefix) to validateToken', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const mockUser = { id: 'user-789', email: 'x@x.com', isActive: true, userRoles: [] };
      patService.validateToken.mockResolvedValue(mockUser as any);

      const rawToken = 'pat_0011223344556677889900aabbccddeeff00112233445566778899aabbccddee';
      const context = createMockContext(`Bearer ${rawToken}`);

      await guard.canActivate(context);

      expect(patService.validateToken).toHaveBeenCalledWith(rawToken);
    });
  });

  // ============================================================================
  // Node credential handling: Bearer nod_... tokens (#267, epic #254)
  // ============================================================================
  //
  // These cases are a PRIVILEGE BOUNDARY, not feature coverage. A `nod_` token
  // resolves to a real `AuthenticatedUser` — and, because `nodes:write` is
  // admin-only in `prisma/seed-data.ts`, that user is an admin. The ONLY thing
  // standing between a leaked worker credential and full administrative
  // authority over this deployment is the route allowlist asserted below, so
  // the negative cases here carry more weight than the positive one.
  // ============================================================================

  describe('Node credential handling', () => {
    const NODE_TOKEN = 'nod_0011223344556677889900aabbccddeeff';

    const nodeUser = {
      id: 'node-owner-1',
      email: 'owner@example.com',
      isActive: true,
      userRoles: [],
    };

    it('routes a nod_ token on /api/nodes to NodeCredentialService.validateToken', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(nodeUser as any);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, NODE_ROUTE_PREFIX);
      const request = context.switchToHttp().getRequest();

      const result = await guard.canActivate(context);

      expect(nodeCredentialService.validateToken).toHaveBeenCalledWith(NODE_TOKEN);
      expect(result).toBe(true);
      expect(request.user).toBe(nodeUser);
      // A nod_ token must never fall through to the PAT branch or to Passport.
      expect(patService.validateToken).not.toHaveBeenCalled();
    });

    it('accepts a path UNDER /api/nodes/', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(nodeUser as any);

      const context = createMockContext(
        `Bearer ${NODE_TOKEN}`,
        '/api/nodes/11111111-1111-4111-8111-111111111111/heartbeat',
      );

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('accepts /api/nodes?x=1 — the query string is not part of route identity', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(nodeUser as any);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, '/api/nodes?x=1');

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(nodeCredentialService.validateToken).toHaveBeenCalledWith(NODE_TOKEN);
    });

    // -------------------------------------------------------------------------
    // The allowlist is a PREFIX-BOUNDARY match, not `startsWith('/api/nodes')`
    // -------------------------------------------------------------------------
    // Each of these paths begins with the literal characters `/api/nodes` and
    // MUST STILL BE REFUSED. A naive `startsWith` passes all three, which is
    // precisely why they are enumerated rather than left to a single case.
    it.each([
      ['/api/nodesX'],
      ['/api/nodes-other'],
      ['/api/nodescrape'],
      ['/api/node-credentials'],
      ['/api/node-credentials/11111111-1111-4111-8111-111111111111'],
      ['/api/users'],
      ['/api/admin/jobs'],
    ])('refuses a nod_ token on %s with 403', async (url) => {
      reflector.getAllAndOverride.mockReturnValue(false);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, url);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('refuses BEFORE validating — no lookup, and therefore no lastUsedAt stamp', async () => {
      // THE ORDERING ASSERTION. `validateToken` is what stamps `lastUsedAt`
      // fire-and-forget, so a refused request that reached it would (a) hand
      // an attacker a liveness oracle in the operator's own credential
      // listing and (b) corrupt the "is this node alive?" signal with probe
      // traffic. Spying on the service is the only way to see the difference:
      // both orderings return the same 403 to the caller.
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(nodeUser as any);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, '/api/users');

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);

      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('refuses a nod_ token on a request with no resolvable URL (fails closed)', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);

      // No `url` at all — the classifier cannot answer, so the allowlist must
      // deny rather than assume.
      const context = createMockContext(`Bearer ${NODE_TOKEN}`);

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('prefers originalUrl over url when both are present', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(nodeUser as any);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, '/api/nodes');
      const request = context.switchToHttp().getRequest();
      // Express-style rewrite: `url` looks allowed, the real path is not.
      request.originalUrl = '/api/users';

      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('throws 401 (not 403) when an allowlisted route carries an invalid credential', async () => {
      // Unknown, revoked, expired and inactive-owner all arrive here as the
      // same `null` from the service, and all become the same 401 — the guard
      // deliberately cannot tell the caller which.
      reflector.getAllAndOverride.mockReturnValue(false);
      nodeCredentialService.validateToken.mockResolvedValue(null);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, NODE_ROUTE_PREFIX);

      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
      await expect(guard.canActivate(context)).rejects.toThrow('Invalid or expired node credential');
    });

    it('does not invoke NodeCredentialService for @Public() routes', async () => {
      reflector.getAllAndOverride.mockReturnValue(true);

      const context = createMockContext(`Bearer ${NODE_TOKEN}`, '/api/users');

      // Public wins over both the allowlist and validation: a route that needs
      // no authentication is not made LESS reachable by presenting a token.
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('leaves the pat_ branch untouched: a PAT still works on a non-node route', async () => {
      // Regression guard for the boundary between the two opaque families —
      // #267 must not have narrowed the PAT's documented universality.
      reflector.getAllAndOverride.mockReturnValue(false);
      patService.validateToken.mockResolvedValue(nodeUser as any);

      const context = createMockContext('Bearer pat_something', '/api/users');

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
    });

    it('does not treat a JWT on a node route as a node credential', async () => {
      reflector.getAllAndOverride.mockReturnValue(false);
      const superSpy = jest
        .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
        .mockReturnValue(true);

      const context = createMockContext('Bearer eyJhbGciOiJIUzI1NiJ9.x.y', NODE_ROUTE_PREFIX);

      await guard.canActivate(context);

      expect(nodeCredentialService.validateToken).not.toHaveBeenCalled();
      expect(superSpy).toHaveBeenCalledWith(context);
    });
  });

  describe('Integration with Passport (tested via integration tests)', () => {
    it('should delegate JWT validation to Passport strategy', () => {
      // The actual JWT validation is done by Passport and the JwtStrategy
      // This is tested in integration tests with real HTTP requests
      // Unit tests focus on the @Public() decorator logic and PAT handling
      expect(true).toBe(true);
    });

    it('should throw UnauthorizedException for invalid tokens (integration)', () => {
      // Invalid tokens, expired tokens, and missing tokens are handled
      // by Passport's AuthGuard and tested in integration tests
      expect(true).toBe(true);
    });
  });
});

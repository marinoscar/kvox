import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { DeviceCodeStatus } from '@prisma/client';

/**
 * Issue #153: `POST /api/auth/device/token` must answer RFC 8628 §3.5 poll
 * errors with the literal `{ error, error_description }` body, not the
 * shared `{ statusCode, code, message, timestamp, path }` envelope.
 *
 * This is deliberately an INTEGRATION spec, driving the real Nest/Fastify
 * HTTP stack via supertest. The pre-#153 defect was invisible to unit tests
 * (which assert the thrown exception, before `HttpExceptionFilter` ever
 * runs) and to the existing device-auth integration spec (which never
 * exercised the poll error paths) — see `device-auth.integration.spec.ts`,
 * whose only `/device/token` case is a validation 400. Asserting the actual
 * response body here is the gap that let the bug through.
 */
describe('Device Auth Token Poll Errors (Integration, #153)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  /**
   * Each poll error case below uses ITS OWN, unique `deviceCode` string.
   * `DeviceAuthService` rate-limits polls in an in-memory `Map` keyed by a
   * hash of the literal device code the client sends, and that map is not
   * reset between test cases (it lives on the singleton service instance,
   * not in the Prisma mock). Reusing a device code across two unrelated
   * tests would make the second one observe `slow_down` instead of the
   * outcome it is trying to assert.
   */
  function futureDate(minutes = 15): Date {
    return new Date(Date.now() + minutes * 60 * 1000);
  }

  describe('RFC 8628 error codes each produce their own body', () => {
    it('returns authorization_pending verbatim while the user has not acted', async () => {
      context.prismaMock.deviceCode.findUnique.mockResolvedValue({
        id: 'dc-pending',
        deviceCode: 'hashed',
        userCode: 'PEND-0001',
        userId: null,
        user: null,
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: futureDate(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode: 'device-code-authorization-pending' })
        .expect(400);

      expect(response.body.error).toBe('authorization_pending');
      expect(response.body).toHaveProperty('error_description');
    });

    it('returns access_denied verbatim when the user clicked Deny', async () => {
      context.prismaMock.deviceCode.findUnique.mockResolvedValue({
        id: 'dc-denied',
        deviceCode: 'hashed',
        userCode: 'DENY-0001',
        userId: null,
        user: null,
        status: DeviceCodeStatus.denied,
        clientInfo: {},
        scopes: [],
        expiresAt: futureDate(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode: 'device-code-access-denied' })
        .expect(400);

      expect(response.body.error).toBe('access_denied');
      expect(response.body).toHaveProperty('error_description');
    });

    it('returns expired_token verbatim once the code has timed out', async () => {
      context.prismaMock.deviceCode.findUnique.mockResolvedValue({
        id: 'dc-expired',
        deviceCode: 'hashed',
        userCode: 'EXPD-0001',
        userId: null,
        user: null,
        status: DeviceCodeStatus.expired,
        clientInfo: {},
        scopes: [],
        expiresAt: futureDate(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode: 'device-code-expired-token' })
        .expect(400);

      expect(response.body.error).toBe('expired_token');
      expect(response.body).toHaveProperty('error_description');
    });

    it('returns slow_down verbatim when polled faster than the configured interval', async () => {
      context.prismaMock.deviceCode.findUnique.mockResolvedValue({
        id: 'dc-slowdown',
        deviceCode: 'hashed',
        userCode: 'SLOW-0001',
        userId: null,
        user: null,
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: futureDate(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const deviceCode = 'device-code-slow-down';

      // First poll: not yet rate-limited, comes back as authorization_pending.
      const first = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode })
        .expect(400);
      expect(first.body.error).toBe('authorization_pending');

      // Second poll, immediately after: the default 5s
      // (`DEVICE_CODE_POLL_INTERVAL`) has not elapsed, so this must be
      // classified as slow_down rather than authorization_pending again.
      const second = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode })
        .expect(400);

      expect(second.body.error).toBe('slow_down');
      expect(second.body).toHaveProperty('error_description');
    });
  });

  describe('invalid_grant deliberately deviates from RFC 6749 §5.2 status', () => {
    it('returns invalid_grant with HTTP 401, not 400', async () => {
      // No matching record => the device code is unknown to the server.
      context.prismaMock.deviceCode.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode: 'device-code-invalid-grant' })
        .expect(401);

      expect(response.body.error).toBe('invalid_grant');
      expect(response.body).toHaveProperty('error_description');

      // Pinned deliberately: RFC 6749 §5.2 specifies 400 for invalid_grant,
      // and `device-token-error.exception.ts` documents 401 as an existing,
      // intentional deviation. If this ever flips back to 400 it must be a
      // conscious, test-breaking decision — not a silent side effect of
      // touching something else in the error path.
    });
  });

  describe('the verbatim body carries no envelope leakage', () => {
    it('contains no statusCode, timestamp, or path keys', async () => {
      context.prismaMock.deviceCode.findUnique.mockResolvedValue({
        id: 'dc-verbatim-shape',
        deviceCode: 'hashed',
        userCode: 'SHAPE001',
        userId: null,
        user: null,
        status: DeviceCodeStatus.pending,
        clientInfo: {},
        scopes: [],
        expiresAt: futureDate(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({ deviceCode: 'device-code-verbatim-shape' })
        .expect(400);

      expect(response.body).not.toHaveProperty('statusCode');
      expect(response.body).not.toHaveProperty('timestamp');
      expect(response.body).not.toHaveProperty('path');
      expect(response.body).not.toHaveProperty('code');

      // The body is exactly the RFC pair, and nothing else — a strict
      // OAuth/RFC 8628 client is entitled to reject a body that is "mostly
      // the spec plus some envelope leakage".
      expect(Object.keys(response.body).sort()).toEqual([
        'error',
        'error_description',
      ]);
    });
  });

  describe('the envelope opt-out is per-exception, not per-route', () => {
    it('still returns the normal envelope for an unauthenticated request to another endpoint', async () => {
      const response = await request(context.app.getHttpServer())
        .get('/api/auth/device/sessions')
        .expect(401);

      expect(response.body).toMatchObject({
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path', '/api/auth/device/sessions');
      // Not the RFC shape.
      expect(response.body).not.toHaveProperty('error');
      expect(response.body).not.toHaveProperty('error_description');
    });

    it('still returns the normal envelope for a validation failure on the SAME /device/token route', async () => {
      // Missing `deviceCode` fails DeviceTokenRequestSchema before the
      // service (and deviceTokenError()) is ever reached — only the
      // specific RFC error exceptions opt out, not the whole route.
      const response = await request(context.app.getHttpServer())
        .post('/api/auth/device/token')
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({
        statusCode: 400,
        code: 'BAD_REQUEST',
      });
      expect(response.body).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path', '/api/auth/device/token');
      expect(response.body).not.toHaveProperty('error');
      expect(response.body).not.toHaveProperty('error_description');
    });
  });
});

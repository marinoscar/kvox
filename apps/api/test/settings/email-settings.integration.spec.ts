import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { CredentialsService } from '../../src/credentials/credentials.service';
import { SesEmailProvider } from '../../src/email/providers/ses-email.provider';
import { SmtpEmailProvider } from '../../src/email/providers/smtp-email.provider';

// =============================================================================
// Email Settings Integration (issue #124, epic #109)
// =============================================================================
//
// HTTP-level coverage for the three `/api/email-settings*` endpoints and the
// contract points that only mean something at the transport boundary:
//
//   * the password never appears ANYWHERE in a serialised response, checked
//     by grepping the whole JSON body rather than trusting named fields
//   * `POST /test` answers HTTP 200 even when the send failed — the single
//     most likely thing a later "fix" gets wrong
//   * the test endpoint is gated on system_settings:WRITE, not :read
//   * a stored-but-invalid row degrades the GET to 200 + defaults, never 500
//
// `CredentialsService`, `SesEmailProvider` and `SmtpEmailProvider` are
// overridden with controllable stubs so this suite drives the provider
// outcome directly, while `EmailSettingsController`, `EmailSettingsService`
// and `EmailTestSendService` are the REAL classes wired by `AppModule` — the
// same boundary a production request crosses.
// =============================================================================

const mockCredentials = {
  describe: jest.fn(),
  setSecret: jest.fn(),
  getSecret: jest.fn(() => {
    throw new Error('the email-settings surface must never read the SMTP plaintext');
  }),
};

const mockSes = { send: jest.fn() };
const mockSmtp = { send: jest.fn() };

describe('Email Settings Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: CredentialsService, useValue: mockCredentials },
        { provide: SesEmailProvider, useValue: mockSes },
        { provide: SmtpEmailProvider, useValue: mockSmtp },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    mockCredentials.describe.mockReset().mockResolvedValue(null);
    mockCredentials.setSecret.mockReset().mockResolvedValue(undefined);
    mockSes.send.mockReset();
    mockSmtp.send.mockReset();

    context.prismaMock.auditEvent.create.mockResolvedValue({} as any);
  });

  /** A user holding ONLY `system_settings:read` — no write. */
  async function createReadOnlyUser(): Promise<{ accessToken: string; email: string }> {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'read-only-admin';
    const email = 'read-only-admin@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'Read Only Admin',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [
          {
            role: {
              id: 'role-readonly',
              name: 'readonly',
              description: 'Read-only settings access',
              rolePermissions: [
                {
                  permission: {
                    id: 'perm-ssr',
                    name: 'system_settings:read',
                    description: 'Read system settings',
                  },
                },
              ],
            },
          },
        ],
      };
    });

    const accessToken = jwtService.sign({ sub: id, email, roles: ['readonly'] });
    return { accessToken, email };
  }

  // ==========================================================================
  // GET /api/email-settings
  // ==========================================================================

  describe('GET /api/email-settings', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer()).get('/api/email-settings').expect(401);
    });

    it('returns 403 for a user without system_settings:read', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });

    it('reports smtpPasswordStatus.configured: true when a password is stored', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        version: 2,
        updatedAt: new Date(),
        updatedByUser: { id: admin.id, email: admin.email },
        value: { provider: 'smtp', enabled: true, smtpHost: 'smtp.example.com' },
      });
      mockCredentials.describe.mockResolvedValue({
        purpose: 'smtp',
        name: 'default',
        hint: '••••x9fQ',
        label: 'SMTP password',
        updatedByUserId: admin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.smtpPasswordStatus.configured).toBe(true);
      expect(response.body.data.smtpPasswordStatus.hint).toBe('••••x9fQ');
    });

    it('reports smtpPasswordStatus.configured: false when nothing is stored', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.systemSettings.findUnique.mockResolvedValue(null);
      mockCredentials.describe.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.smtpPasswordStatus.configured).toBe(false);
    });

    it('degrades a stored-but-invalid row to HTTP 200 with defaults and settingsError, never a 500', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        version: 5,
        updatedAt: new Date(),
        updatedByUser: null,
        value: { provider: 'not-a-real-provider', enabled: 'not-a-boolean' },
      });
      mockCredentials.describe.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.settingsError).toEqual(expect.any(String));
      expect(response.body.data.provider).toBeNull();
      expect(response.body.data.enabled).toBe(false);
    });

    it('the password never appears anywhere in the serialised response', async () => {
      const admin = await createMockAdminUser(context);
      const knownPlaintext = 'get-response-must-not-contain-this-Xk9!';
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        version: 1,
        updatedAt: new Date(),
        updatedByUser: { id: admin.id, email: admin.email },
        value: { provider: 'smtp', enabled: true, smtpHost: 'smtp.example.com' },
      });
      // The mock's `describe` cannot literally return the plaintext (its real
      // implementation has no field capable of it), but the assertion below
      // does not rely on that — it greps the raw response text.
      mockCredentials.describe.mockResolvedValue({
        purpose: 'smtp',
        name: 'default',
        hint: '••••3!q2',
        label: 'SMTP password',
        updatedByUserId: admin.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(knownPlaintext);
      expect(mockCredentials.getSecret).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // PUT /api/email-settings
  // ==========================================================================

  describe('PUT /api/email-settings', () => {
    function stubWrite(version = 0) {
      context.prismaMock.systemSettings.findUnique.mockResolvedValue(
        version === 0 ? null : ({ version } as any),
      );
      context.prismaMock.systemSettings.upsert.mockImplementation(async ({ create, update }: any) => ({
        id: 'settings-email',
        key: 'email',
        version: version + 1,
        updatedAt: new Date(),
        updatedByUserId: create?.updatedByUserId ?? update?.updatedByUserId,
        updatedByUser: { id: 'admin-user-id', email: 'admin@example.com' },
        value: create?.value ?? update?.value,
      }));
    }

    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .send({ provider: null, enabled: false })
        .expect(401);
    });

    it('returns 403 for a user without system_settings:write', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(viewer.accessToken))
        .send({ provider: null, enabled: false })
        .expect(403);
    });

    it('a blank password ("") leaves the stored credential untouched', async () => {
      const admin = await createMockAdminUser(context);
      stubWrite(1);

      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .send({
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          smtpPassword: '',
        })
        .expect(200);

      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
    });

    it('a blank password (key absent) leaves the stored credential untouched', async () => {
      const admin = await createMockAdminUser(context);
      stubWrite(1);

      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .send({ provider: 'smtp', enabled: true, smtpHost: 'smtp.example.com' })
        .expect(200);

      expect(mockCredentials.setSecret).not.toHaveBeenCalled();
    });

    it('a non-blank password is written through to the credential store', async () => {
      const admin = await createMockAdminUser(context);
      stubWrite(1);

      await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .send({
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          smtpPassword: 'a-real-new-password',
        })
        .expect(200);

      expect(mockCredentials.setSecret).toHaveBeenCalledWith(
        'smtp',
        'default',
        'a-real-new-password',
        expect.objectContaining({ updatedByUserId: admin.id }),
      );
    });

    it('the submitted password never appears anywhere in the serialised response', async () => {
      const admin = await createMockAdminUser(context);
      stubWrite(1);
      const submittedPlaintext = 'put-response-must-not-contain-this-Xk9!q2';

      const response = await request(context.app.getHttpServer())
        .put('/api/email-settings')
        .set(authHeader(admin.accessToken))
        .send({
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          smtpPassword: submittedPlaintext,
        })
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain(submittedPlaintext);
    });
  });

  // ==========================================================================
  // POST /api/email-settings/test
  // ==========================================================================

  describe('POST /api/email-settings/test', () => {
    beforeEach(() => {
      context.prismaMock.systemSettings.findUnique.mockResolvedValue({
        value: {
          provider: 'smtp',
          enabled: true,
          smtpHost: 'smtp.example.com',
          fromAddress: 'no-reply@example.com',
        },
      });
    });

    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer()).post('/api/email-settings/test').expect(401);
    });

    it('is gated on system_settings:WRITE — a read-only user gets 403', async () => {
      const readOnly = await createReadOnlyUser();

      await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(readOnly.accessToken))
        .expect(403);
    });

    it('returns HTTP 200 with success: true when the provider accepts the message', async () => {
      const admin = await createMockAdminUser(context);
      mockSmtp.send.mockResolvedValue({ success: true, messageId: 'msg-123' });

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.success).toBe(true);
      expect(response.body.data.sentTo).toBe(admin.email);
    });

    it('returns HTTP 200 (not 4xx/5xx) with success: false when the provider REJECTS the message, and preserves its error text verbatim', async () => {
      const admin = await createMockAdminUser(context);
      mockSmtp.send.mockResolvedValue({
        success: false,
        error: 'SMTP: 535 Authentication failed',
      });

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.success).toBe(false);
      expect(response.body.data.error).toBe('SMTP: 535 Authentication failed');
    });

    it('a pre-flight failure (no provider configured) is still HTTP 200 with success: false, in the same shape', async () => {
      const admin = await createMockAdminUser(context);
      context.prismaMock.systemSettings.findUnique.mockResolvedValue(null);

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.success).toBe(false);
      expect(response.body.data.providerKind).toBeNull();
      expect(typeof response.body.data.error).toBe('string');
      expect(mockSmtp.send).not.toHaveBeenCalled();
    });

    it('always sends to the authenticated caller, ignoring any recipient-shaped field in the body', async () => {
      const admin = await createMockAdminUser(context);
      mockSmtp.send.mockResolvedValue({ success: true, messageId: 'msg-1' });

      const response = await request(context.app.getHttpServer())
        .post('/api/email-settings/test')
        .set(authHeader(admin.accessToken))
        // There is no recipient field on the DTO; sending one proves it is
        // silently ignored rather than accidentally wired up.
        .send({ to: 'attacker@evil.example', recipient: 'attacker@evil.example' })
        .expect(200);

      expect(response.body.data.sentTo).toBe(admin.email);
      const [message] = mockSmtp.send.mock.calls[0];
      expect(message.to).toBe(admin.email);
    });
  });
});

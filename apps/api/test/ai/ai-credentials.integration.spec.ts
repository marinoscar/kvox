import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { OPENAI_FETCH } from '../../src/ai/providers/openai.provider';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';

// =============================================================================
// Per-user AI credentials over the wire (issue #47, epic #45)
// =============================================================================
//
// HTTP-level coverage for the contracts a client actually meets, driven through
// the REAL `AppModule` — the global `ZodValidationPipe`, the guards, the
// controllers and the real `secret-cipher.ts`. Only `PrismaService` and the
// provider's `fetch` are replaced.
//
// THE FOUR THINGS THAT MATTER MOST HERE, all of them issue #47 acceptance
// criteria:
//
//   1. **NO RESPONSE BODY ON ANY ROUTE EVER CONTAINS THE SECRET**, asserted
//      against the SERIALIZED body (`res.text`) rather than the parsed DTO.
//      That distinction is the whole point: a DTO assertion checks the fields a
//      test author thought to name, while a substring search over the raw bytes
//      catches a secret that arrived somewhere nobody thought to look — a
//      nested error `cause`, an echoed request body, a field added later.
//
//   2. `POST /api/ai-credentials/test` answers **200** `{ ok: false }` for a
//      REFUSED key, and works on a key that has NOT been saved. A refused probe
//      is a successful diagnosis.
//
//   3. One user cannot read, replace or delete another's credential **by any
//      route** — which here is proved by what reaches Prisma, because the
//      routes carry no user parameter at all.
//
//   4. `GET /api/ai/config` is reachable by a **Viewer** and reports
//      `keyConfigured: false` before a key is saved.
//
// The CASCADE criterion is deliberately NOT here: "deleting a user removes
// their `user_ai_credentials` row" is a property of a foreign key, and
// asserting it against a mock whose `deleteMany` returns whatever the test told
// it to would be asserting the test's own arrangement. It lives in
// `user-ai-credential-schema.db.spec.ts`, against real rows.
// =============================================================================

// `secret-cipher.ts` caches its master key at module scope on first use, so
// this must be set before the first encrypt — which happens inside a request,
// never at import time. Restored below so it cannot leak into another spec
// sharing this worker.
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const ORIGINAL_KEY_ENV = process.env.SECRETS_ENCRYPTION_KEY;
process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

afterAll(() => {
  if (ORIGINAL_KEY_ENV === undefined) {
    delete process.env.SECRETS_ENCRYPTION_KEY;
  } else {
    process.env.SECRETS_ENCRYPTION_KEY = ORIGINAL_KEY_ENV;
  }
});

const CREDENTIALS = '/api/ai-credentials';
const CONFIG = '/api/ai/config';

/** A key with an obvious, greppable shape. Never a real one. */
const RAW_KEY = 'sk-proj-INTEGRATION-TEST-SECRET-abcd1234';

/** The mask `deriveHint` produces for {@link RAW_KEY}. */
const EXPECTED_HINT = '••••1234';

/** What the settings row holds when a deployment has enabled AI properly. */
const ENABLED_AI_SETTINGS = {
  ...DEFAULT_SYSTEM_SETTINGS,
  ai: {
    ...DEFAULT_SYSTEM_SETTINGS.ai,
    enabled: true,
    providers: {
      openai: {
        ...DEFAULT_SYSTEM_SETTINGS.ai.providers.openai,
        allowedModels: ['gpt-4o', 'gpt-4o-mini'],
        defaultModel: 'gpt-4o',
      },
    },
  },
};

/** One stored row, as `STATUS_SELECT` projects it. Carries no ciphertext. */
const statusRow = (overrides: Record<string, unknown> = {}) => ({
  provider: 'openai',
  hint: EXPECTED_HINT,
  label: 'work',
  lastUsedAt: null,
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

describe('AI credentials integration', () => {
  let context: TestContext;
  /** Replaces the provider's `fetch`. Reassigned per test. */
  let openAiFetch: jest.Mock;

  beforeAll(async () => {
    openAiFetch = jest.fn();

    context = await createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        {
          provide: OPENAI_FETCH,
          // Indirected through the closure so a test can swap the behaviour
          // without rebuilding the whole application.
          useValue: (url: string, init?: unknown) => openAiFetch(url, init),
        },
      ],
    });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    jest.clearAllMocks();

    prismaMock.auditEvent.create.mockResolvedValue({} as never);
    prismaMock.systemSettings.findUnique.mockResolvedValue({
      key: 'global',
      value: ENABLED_AI_SETTINGS,
      version: 3,
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedByUser: null,
    } as never);

    // Nothing stored, unless a test says otherwise.
    prismaMock.userAiCredential.findUnique.mockResolvedValue(null as never);
    prismaMock.userAiCredential.findMany.mockResolvedValue([] as never);
    prismaMock.userAiCredential.upsert.mockResolvedValue({} as never);
    prismaMock.userAiCredential.update.mockResolvedValue({} as never);
    prismaMock.userAiCredential.deleteMany.mockResolvedValue({ count: 1 } as never);
  });

  // ==========================================================================
  // PUT then GET
  // ==========================================================================

  describe('PUT /api/ai-credentials', () => {
    it('stores the key encrypted and answers with a hint, never the key', async () => {
      const user = await createMockTestUser(context);

      // The row the service re-reads after the upsert to build its response.
      prismaMock.userAiCredential.findUnique
        .mockResolvedValueOnce(null as never) // the "does a row exist?" check
        .mockResolvedValueOnce(statusRow() as never); // the describe() read

      const res = await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', apiKey: RAW_KEY, label: 'work' })
        .expect(200);

      expect(res.body.data).toMatchObject({
        provider: 'openai',
        configured: true,
        hint: EXPECTED_HINT,
        label: 'work',
      });

      // ⚠ AGAINST THE SERIALIZED BODY. See the file header for why this is not
      // the same assertion as checking `res.body.apiKey` is undefined.
      expect(res.text).not.toContain(RAW_KEY);

      // What actually reached the database: a ciphertext, not the key.
      const written = prismaMock.userAiCredential.upsert.mock.calls[0][0];
      expect(written.create.secret).not.toContain(RAW_KEY);
      expect(written.create.secret).not.toBe(RAW_KEY);
      expect(written.create.hint).toBe(EXPECTED_HINT);
      expect(written.where).toEqual({
        userId_provider: { userId: user.id, provider: 'openai' },
      });
    });

    it('is scoped to the caller — the body cannot name another user', async () => {
      const user = await createMockTestUser(context);

      prismaMock.userAiCredential.findUnique
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(statusRow() as never);

      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        // A hostile body naming somebody else. The global ZodValidationPipe
        // strips unknown keys, and there is no parameter for one anyway.
        .send({ provider: 'openai', apiKey: RAW_KEY, userId: 'somebody-else' })
        .expect(200);

      const written = prismaMock.userAiCredential.upsert.mock.calls[0][0];
      expect(written.where.userId_provider.userId).toBe(user.id);
      expect(written.create.userId).toBe(user.id);
    });

    it('records an audit event that says WHETHER the key changed, never what to', async () => {
      const user = await createMockTestUser(context);

      prismaMock.userAiCredential.findUnique
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce(statusRow() as never);

      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', apiKey: RAW_KEY })
        .expect(200);

      const audit = prismaMock.auditEvent.create.mock.calls[0][0].data;
      expect(audit.action).toBe('ai_credential:create');
      expect(audit.targetType).toBe('user_ai_credential');
      expect(audit.actorUserId).toBe(user.id);
      expect(audit.meta).toMatchObject({ provider: 'openai', apiKeyChanged: true });
      expect(JSON.stringify(audit)).not.toContain(RAW_KEY);
    });

    it('records a REPLACE when a row already existed', async () => {
      const user = await createMockTestUser(context);

      prismaMock.userAiCredential.findUnique
        .mockResolvedValueOnce({ id: 'cred-1' } as never)
        .mockResolvedValueOnce(statusRow() as never);

      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', apiKey: 'sk-a-different-key-5678' })
        .expect(200);

      expect(prismaMock.auditEvent.create.mock.calls[0][0].data.action).toBe(
        'ai_credential:replace',
      );
    });

    it('rejects a blank key when nothing is stored yet', async () => {
      const user = await createMockTestUser(context);

      // Blank PRESERVES rather than erases — but there is nothing to preserve,
      // and a 200 that changed nothing would be misleading on an endpoint whose
      // whole purpose is the key.
      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', apiKey: '' })
        .expect(400);

      expect(prismaMock.userAiCredential.upsert).not.toHaveBeenCalled();
    });

    it('preserves the stored key when the submission is blank (label-only edit)', async () => {
      const user = await createMockTestUser(context);

      prismaMock.userAiCredential.findUnique
        .mockResolvedValueOnce({ id: 'cred-1' } as never)
        .mockResolvedValueOnce(statusRow({ label: 'personal' }) as never);

      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', label: 'personal' })
        .expect(200);

      // Nothing re-encrypted, nothing re-hinted: the ciphertext is untouched.
      expect(prismaMock.userAiCredential.upsert).not.toHaveBeenCalled();
      expect(prismaMock.userAiCredential.update.mock.calls[0][0].data).toEqual({
        label: 'personal',
      });
    });

    it('rejects an unknown provider with a 400 naming the valid ids', async () => {
      const user = await createMockTestUser(context);

      const res = await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .send({ provider: 'not-a-vendor', apiKey: RAW_KEY })
        .expect(400);

      expect(res.text).toContain('openai');
      expect(res.text).not.toContain(RAW_KEY);
    });

    it('refuses an unauthenticated caller', async () => {
      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .send({ provider: 'openai', apiKey: RAW_KEY })
        .expect(401);
    });
  });

  // ==========================================================================
  // GET
  // ==========================================================================

  describe('GET /api/ai-credentials', () => {
    it('returns the hint and never the key', async () => {
      const user = await createMockTestUser(context);
      prismaMock.userAiCredential.findMany.mockResolvedValue([statusRow()] as never);

      const res = await request(context.app.getHttpServer())
        .get(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data.credentials).toEqual([
        expect.objectContaining({ provider: 'openai', hint: EXPECTED_HINT }),
      ]);
      expect(res.text).not.toContain(RAW_KEY);
      // Nothing that could hold ciphertext either.
      expect(res.text).not.toContain('secret');
    });

    it('reads only the caller\'s own rows, and does not select the ciphertext', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .get(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .expect(200);

      const query = prismaMock.userAiCredential.findMany.mock.calls[0][0];

      // ⚠ BOTH HALVES MATTER. The `where` is what makes one user's listing
      // unable to contain another's row; the absent `secret` in the projection
      // is what keeps the encrypted bytes inside Postgres for a read that has
      // no business decrypting them.
      expect(query.where).toEqual({ userId: user.id });
      expect(query.select.secret).toBeUndefined();
    });

    it('is empty rather than an error for a user who has set nothing up', async () => {
      const user = await createMockTestUser(context);

      const res = await request(context.app.getHttpServer())
        .get(CREDENTIALS)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(res.body.data).toEqual({ credentials: [] });
    });
  });

  // ==========================================================================
  // Cross-user isolation
  // ==========================================================================

  describe('one user cannot reach another user\'s credential', () => {
    it('by GET — the query is scoped to the caller, with no parameter to substitute', async () => {
      const alice = await createMockTestUser(context, { email: 'alice@example.test' });
      const bob = await createMockTestUser(context, { email: 'bob@example.test' });

      prismaMock.userAiCredential.findMany.mockResolvedValue([] as never);

      await request(context.app.getHttpServer())
        .get(CREDENTIALS)
        .set(authHeader(bob.accessToken))
        .expect(200);

      const where = prismaMock.userAiCredential.findMany.mock.calls[0][0].where;
      expect(where).toEqual({ userId: bob.id });
      expect(where.userId).not.toBe(alice.id);
    });

    it('by PUT — a replace can only ever land on the caller\'s own row', async () => {
      const alice = await createMockTestUser(context, { email: 'alice2@example.test' });
      const bob = await createMockTestUser(context, { email: 'bob2@example.test' });

      prismaMock.userAiCredential.findUnique
        .mockResolvedValueOnce({ id: 'cred-alice' } as never)
        .mockResolvedValueOnce(statusRow() as never);

      await request(context.app.getHttpServer())
        .put(CREDENTIALS)
        .set(authHeader(bob.accessToken))
        .send({ provider: 'openai', apiKey: RAW_KEY, userId: alice.id })
        .expect(200);

      expect(
        prismaMock.userAiCredential.upsert.mock.calls[0][0].where.userId_provider.userId,
      ).toBe(bob.id);
    });

    it('by DELETE — the delete is scoped by userId in the `where` itself', async () => {
      const alice = await createMockTestUser(context, { email: 'alice3@example.test' });
      const bob = await createMockTestUser(context, { email: 'bob3@example.test' });

      await request(context.app.getHttpServer())
        .delete(`${CREDENTIALS}/openai`)
        .set(authHeader(bob.accessToken))
        .expect(204);

      // ⚠ The route parameter is the PROVIDER, not a credential id — so there
      // is no identifier for a caller to substitute. This assertion pins that:
      // a refactor that matched on a row id and checked ownership afterwards
      // would be one mistake away from deleting Alice's key.
      expect(prismaMock.userAiCredential.deleteMany.mock.calls[0][0].where).toEqual({
        userId: bob.id,
        provider: 'openai',
      });
      expect(JSON.stringify(prismaMock.userAiCredential.deleteMany.mock.calls)).not.toContain(
        alice.id,
      );
    });

    it('by the config probe — keyConfigured describes the caller, nobody else', async () => {
      const bob = await createMockTestUser(context, { email: 'bob4@example.test' });

      await request(context.app.getHttpServer())
        .get(CONFIG)
        .set(authHeader(bob.accessToken))
        .expect(200);

      expect(
        prismaMock.userAiCredential.findUnique.mock.calls[0][0].where.userId_provider
          .userId,
      ).toBe(bob.id);
    });
  });

  // ==========================================================================
  // DELETE
  // ==========================================================================

  describe('DELETE /api/ai-credentials/:provider', () => {
    it('answers 204 and audits the erasure', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .delete(`${CREDENTIALS}/openai`)
        .set(authHeader(user.accessToken))
        .expect(204);

      const audit = prismaMock.auditEvent.create.mock.calls[0][0].data;
      expect(audit.action).toBe('ai_credential:delete');
      expect(audit.meta).toMatchObject({ provider: 'openai', existed: true });
    });

    it('is idempotent — removing a key that is not there succeeds', async () => {
      const user = await createMockTestUser(context);
      prismaMock.userAiCredential.deleteMany.mockResolvedValue({ count: 0 } as never);

      await request(context.app.getHttpServer())
        .delete(`${CREDENTIALS}/openai`)
        .set(authHeader(user.accessToken))
        .expect(204);

      expect(prismaMock.auditEvent.create.mock.calls[0][0].data.meta.existed).toBe(
        false,
      );
    });

    it('rejects an unknown provider', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .delete(`${CREDENTIALS}/not-a-vendor`)
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(prismaMock.userAiCredential.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /test
  // ==========================================================================

  describe('POST /api/ai-credentials/test', () => {
    it('answers 200 { ok: false } for a REFUSED key, not a 4xx', async () => {
      const user = await createMockTestUser(context);

      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{"error":{"message":"Incorrect API key provided"}}',
        json: async () => ({}),
      });

      // ⚠ 200, NOT 401. A refused probe is a successful diagnosis and is the
      // entire reason this endpoint exists — a 4xx here would make every client
      // that checks the status report "could not test your key" for the one
      // case it exists to report precisely.
      const res = await request(context.app.getHttpServer())
        .post(`${CREDENTIALS}/test`)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', apiKey: 'sk-a-revoked-key-0000' })
        .expect(200);

      expect(res.body.data.ok).toBe(false);
      expect(res.body.data.detail).toMatch(/401/);
      expect(res.text).not.toContain('sk-a-revoked-key-0000');
    });

    it('works on a key that has NOT been saved, and saves nothing', async () => {
      const user = await createMockTestUser(context);

      openAiFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({ data: [] }),
      });

      const res = await request(context.app.getHttpServer())
        .post(`${CREDENTIALS}/test`)
        .set(authHeader(user.accessToken))
        // Nothing is stored — `findUnique` returns null for every call in this
        // test — and the probe still works. That is the workflow: prove a key
        // before committing it.
        .send({ provider: 'openai', apiKey: RAW_KEY })
        .expect(200);

      expect(res.body.data.ok).toBe(true);
      expect(prismaMock.userAiCredential.upsert).not.toHaveBeenCalled();
      expect(prismaMock.userAiCredential.update).not.toHaveBeenCalled();

      // The supplied key reached the provider and nothing else.
      expect(openAiFetch.mock.calls[0][1].headers.authorization).toBe(
        `Bearer ${RAW_KEY}`,
      );
      expect(res.text).not.toContain(RAW_KEY);
    });

    it('falls back to the stored key when none is supplied', async () => {
      const user = await createMockTestUser(context);

      // The stored ciphertext, produced by the real cipher so the decrypt in
      // the service is exercised rather than stubbed.
      const { encryptSecret } = await import(
        '../../src/common/crypto/secret-cipher'
      );
      prismaMock.userAiCredential.findUnique.mockResolvedValue({
        secret: encryptSecret(RAW_KEY, 'ai-key'),
      } as never);

      openAiFetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({ data: [] }),
      });

      const res = await request(context.app.getHttpServer())
        .post(`${CREDENTIALS}/test`)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai' })
        .expect(200);

      expect(res.body.data.ok).toBe(true);
      expect(openAiFetch.mock.calls[0][1].headers.authorization).toBe(
        `Bearer ${RAW_KEY}`,
      );
      expect(res.text).not.toContain(RAW_KEY);
    });

    it('400s when no key is supplied and none is stored — not a failed probe', async () => {
      const user = await createMockTestUser(context);

      await request(context.app.getHttpServer())
        .post(`${CREDENTIALS}/test`)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai' })
        .expect(400);

      expect(openAiFetch).not.toHaveBeenCalled();
    });

    it('audits the outcome, never the key', async () => {
      const user = await createMockTestUser(context);

      openAiFetch.mockResolvedValue({
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => '{}',
        json: async () => ({}),
      });

      await request(context.app.getHttpServer())
        .post(`${CREDENTIALS}/test`)
        .set(authHeader(user.accessToken))
        .send({ provider: 'openai', apiKey: RAW_KEY })
        .expect(200);

      const audit = prismaMock.auditEvent.create.mock.calls[0][0].data;
      expect(audit.action).toBe('ai_credential:test');
      expect(audit.meta).toMatchObject({
        provider: 'openai',
        ok: false,
        usedSuppliedKey: true,
      });
      expect(JSON.stringify(audit)).not.toContain(RAW_KEY);
    });
  });

  // ==========================================================================
  // No secret in ANY response body
  // ==========================================================================

  it('never emits the secret on ANY route, asserted over the serialized bodies', async () => {
    const user = await createMockTestUser(context);

    prismaMock.userAiCredential.findUnique
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(statusRow() as never);

    openAiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{}',
      json: async () => ({ data: [] }),
    });

    const server = context.app.getHttpServer();

    const bodies = [
      (
        await request(server)
          .put(CREDENTIALS)
          .set(authHeader(user.accessToken))
          .send({ provider: 'openai', apiKey: RAW_KEY, label: 'work' })
      ).text,
      (await request(server).get(CREDENTIALS).set(authHeader(user.accessToken))).text,
      (
        await request(server)
          .post(`${CREDENTIALS}/test`)
          .set(authHeader(user.accessToken))
          .send({ provider: 'openai', apiKey: RAW_KEY })
      ).text,
      (await request(server).get(CONFIG).set(authHeader(user.accessToken))).text,
      (
        await request(server)
          .delete(`${CREDENTIALS}/openai`)
          .set(authHeader(user.accessToken))
      ).text,
    ];

    // ⚠ SERIALIZED BODIES, not DTOs. See the file header: this is a substring
    // search over the raw bytes precisely so it catches a secret arriving
    // somewhere nobody thought to name a field for.
    for (const body of bodies) {
      expect(body ?? '').not.toContain(RAW_KEY);
    }
  });
});

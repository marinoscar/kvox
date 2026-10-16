// =============================================================================
// Real-Postgres test: the stored settings shape survives the platform services
// (issue #466, epic #462)
// =============================================================================
//
// WHY THIS CANNOT BE A MOCK. #466 replaced KVox's own `SystemSettingsService` and
// `UserSettingsService` with the platform's. The promise is "no data migration":
// the `global` row and every `user_settings` row already in a deployment keep
// reading and writing as they did. That is a statement about what the platform
// service does to a REAL jsonb row on a read-modify-write: a namespace the
// registry composes wrongly (a field the platform declaration lacks and KVox
// stores) is dropped silently on the next PATCH, and only a database round trip
// shows it.
//
// What is pinned:
//   system_settings  a `global` row seeded with today's KVox JSON, all seven
//                    namespaces in the OLD key order (notifications, jobs, nodes,
//                    databaseBackup, transcription, maintenance, ai), is read,
//                    then PATCHed on `transcription`. Every other namespace, and
//                    every transcription field the patch did not name, is
//                    byte-for-byte what was seeded.
//   user_settings    `graph` and `onboarding` are returned when stored and are
//                    ABSENT (not `null`, not `{}`) when not stored, and a write to
//                    another field neither drops nor invents them.
//
// Postgres's jsonb does not keep key order (it sorts by length, then bytes), so
// "the old key order" describes what the seed is written in, and the assertions
// compare VALUES, never key order.
//
// THIS IS A `*.db.spec.ts` FILE: see `test/jobs/db-test-support.ts` for the
// run/skip mechanics. It restores the `global` row it replaces.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  SystemSettingsService,
  UserSettingsService,
  type SettingsProfileImages,
} from '@marinoscar/platform-api/settings';
import type { PrincipalCache } from '@marinoscar/platform-api/identity';

import '../../src/kvox.manifest';
import { normalizeProfileSettings } from '@marinoscar/platform-api/storage';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('stored-shape.db.spec');

const ROW_KEY = 'global';
const EMAIL_PREFIX = 'stored-shape-466';

/**
 * Today's KVox `global` row, written in the key order the deleted KVox service
 * stored (`transcription` BEFORE `maintenance`). Values deliberately differ from
 * the defaults so a service that rebuilt a namespace from defaults would show.
 */
const LEGACY_GLOBAL_VALUE = {
  notifications: { browserEnabled: false, disabledEvents: ['job.failed'] },
  jobs: { history: { retentionDays: 45, purgeEnabled: false }, stuckThresholdMinutes: 50 },
  nodes: {
    staleHeartbeatSeconds: 120,
    offlineStaleMultiplier: 6,
    offlineRetentionDays: 14,
    jobSecretBrokerEnabled: true,
  },
  databaseBackup: {
    enabled: true,
    frequency: 'weekly',
    dayOfWeek: 3,
    dayOfMonth: 1,
    timeOfDay: '04:30',
    timezone: 'America/Costa_Rica',
    retentionCount: 12,
    storageProvider: 's3',
    runStaleMinutes: 90,
    compressionLevel: 9,
    restoreRollbackMode: 'retain_database',
    oldDatabaseRetentionHours: 24,
    nodeOffloadEnabled: true,
  },
  transcription: {
    enabled: true,
    provider: 'assemblyai',
    providers: { assemblyai: { region: 'eu', speechModel: 'universal-2' } },
    audioDelivery: 'presigned_url',
    presignedUrlTtlMinutes: 120,
    deleteRemoteAfterIngest: false,
    defaultLanguage: 'es',
    transcodeNodeOffloadEnabled: false,
    abandonedUploadHours: 6,
    playback: { bitrateKbps: 96 },
  },
  maintenance: {
    enabled: true,
    message: 'Back soon.',
    allowAdmins: false,
    startedAt: '2026-01-02T03:04:05.000Z',
    startedById: null,
  },
  ai: {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        allowedModels: [{ id: 'gpt-5.4-mini' }],
        defaultModel: 'gpt-5.4-mini',
      },
    },
    maxInputTokens: 100000,
    maxOutputTokens: 8000,
    requestTimeoutMs: 300000,
    reasoningEffort: 'low',
    maxDocumentBytes: 10485760,
    taskModels: {},
    graphEnabled: true,
  },
} as const;

/** The `ai` fields the app extension keeps under their old names (#473): they read back as stored. */
const AI_KEPT_FIELDS = {
  enabled: true,
  maxInputTokens: 100000,
  maxOutputTokens: 8000,
  requestTimeoutMs: 300000,
  reasoningEffort: 'low',
  maxDocumentBytes: 10485760,
  taskModels: {},
  graphEnabled: true,
} as const;

const LEGACY_NAMESPACES = Object.keys(LEGACY_GLOBAL_VALUE) as Array<keyof typeof LEGACY_GLOBAL_VALUE>;

const GRAPH_PREFERENCES = {
  extraction: { autoExtract: false },
  resolution: { mode: 'review_all', autoLinkThreshold: 0.95, newThreshold: 0.5, adjudication: 'off' },
  domains: { work: true, personal: true },
} as const;

const ONBOARDING = {
  welcomeSeenAt: '2026-02-03T04:05:06.000Z',
  checklistDismissedAt: '2026-02-04T04:05:06.000Z',
  skipped: ['admin.smoke_test'],
} as const;

describeWithDb('stored settings shape through the platform services (db)', () => {
  let prisma: PrismaClient;
  let system: SystemSettingsService;
  let users: UserSettingsService;
  let actorId: string;
  let originalGlobal: { value: Prisma.JsonValue; version: number } | null;
  const createdUserIds: string[] = [];

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function seedGlobal(value: unknown): Promise<void> {
    await prisma.systemSettings.upsert({
      where: { key: ROW_KEY },
      create: { key: ROW_KEY, value: value as Prisma.InputJsonValue, version: 1 },
      update: { value: value as Prisma.InputJsonValue, version: 1 },
    });
  }

  async function storedGlobal(): Promise<Record<string, unknown>> {
    const row = await prisma.systemSettings.findUniqueOrThrow({ where: { key: ROW_KEY } });
    return row.value as Record<string, unknown>;
  }

  beforeAll(async () => {
    prisma = createDbClient();

    const profileImages: SettingsProfileImages = {
      normalize: normalizeProfileSettings,
      isUploadedAvatar: async () => false,
    };
    const principalCache = { invalidate: () => undefined } as unknown as PrincipalCache;

    system = new SystemSettingsService(prisma as never, new ConfigService({}), {
      systemRowKey: ROW_KEY,
      orgLayer: 'auto',
      imports: [],
    });
    users = new UserSettingsService(prisma as never, principalCache, profileImages);

    const existing = await prisma.systemSettings.findUnique({ where: { key: ROW_KEY } });
    originalGlobal = existing ? { value: existing.value, version: existing.version } : null;
    actorId = (await createUser('actor')).id;
  });

  afterAll(async () => {
    if (originalGlobal) {
      await prisma.systemSettings.update({
        where: { key: ROW_KEY },
        data: { value: originalGlobal.value as Prisma.InputJsonValue, version: originalGlobal.version },
      });
    } else {
      await prisma.systemSettings.deleteMany({ where: { key: ROW_KEY } });
    }
    await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  // ===========================================================================
  // system_settings
  // ===========================================================================

  describe('system_settings: the seeded KVox global row', () => {
    beforeEach(async () => {
      await seedGlobal(LEGACY_GLOBAL_VALUE);
    });

    it('reads every one of the seven KVox namespaces exactly as stored', async () => {
      const settings = await system.getSettings();

      for (const key of LEGACY_NAMESPACES.filter((k) => k !== 'ai')) {
        expect((settings as unknown as Record<string, unknown>)[key]).toEqual(LEGACY_GLOBAL_VALUE[key]);
      }
      // `ai` is the platform's namespace since #473: the fields this app kept read back unchanged,
      // the old provider block is the platform's slot shape (see the pre-upgrade test below).
      expect(settings.ai).toMatchObject(AI_KEPT_FIELDS);
    });

    it('a PATCH to transcription changes those fields and keeps every other transcription field', async () => {
      const result = await system.patchSettings(
        { transcription: { enabled: false, defaultLanguage: 'en' } } as never,
        actorId,
      );

      expect(result.transcription).toEqual({
        ...LEGACY_GLOBAL_VALUE.transcription,
        enabled: false,
        defaultLanguage: 'en',
      });
      const stored = await storedGlobal();
      expect(stored.transcription).toEqual({
        ...LEGACY_GLOBAL_VALUE.transcription,
        enabled: false,
        defaultLanguage: 'en',
      });
    });

    it('a PATCH to transcription leaves the six other stored namespaces untouched', async () => {
      await system.patchSettings({ transcription: { enabled: false } } as never, actorId);

      const stored = await storedGlobal();
      for (const key of LEGACY_NAMESPACES.filter((k) => k !== 'transcription' && k !== 'ai')) {
        expect(stored[key]).toEqual(LEGACY_GLOBAL_VALUE[key]);
      }
      // `ai` (#473): the kept fields and the not-yet-migrated old keys survive a write to another namespace.
      expect(stored.ai).toMatchObject({ ...AI_KEPT_FIELDS, provider: 'openai' });
      expect((stored.ai as { providers: { openai: Record<string, unknown> } }).providers.openai).toMatchObject({
        baseUrl: 'https://api.openai.com/v1',
      });
      // ⚠ KNOWN, UNTIL #474 MOVES THE DATA: the platform re-serializes every provider slot on ANY
      // system-settings write, and its openai slot has no `allowedModels` / `defaultModel`. A write
      // before the #474 migration therefore drops the old model list. The migration must run first.
      expect(
        (stored.ai as { providers: { openai: Record<string, unknown> } }).providers.openai.allowedModels,
      ).toBeUndefined();
      // Platform slices declare namespaces of their own (storage #469, telemetry #471); a PATCH writes
      // the composed row, so their defaults are added next to the seven stored namespaces.
      expect(Object.keys(stored).sort()).toEqual([...LEGACY_NAMESPACES, 'storage', 'telemetry'].sort());
    });

    it('a PATCH bumps the row version by one and records the actor', async () => {
      const before = await prisma.systemSettings.findUniqueOrThrow({ where: { key: ROW_KEY } });

      await system.patchSettings({ transcription: { abandonedUploadHours: 12 } } as never, actorId);

      const after = await prisma.systemSettings.findUniqueOrThrow({ where: { key: ROW_KEY } });
      expect(after.version).toBe(before.version + 1);
      expect(after.updatedByUserId).toBe(actorId);
    });

    it('a key the registry does not know is carried through a PATCH, not dropped', async () => {
      await seedGlobal({ ...LEGACY_GLOBAL_VALUE, legacyExperiment: { keepMe: true } });

      await system.patchSettings({ transcription: { enabled: false } } as never, actorId);

      const stored = await storedGlobal();
      expect(stored.legacyExperiment).toEqual({ keepMe: true });
      expect(stored.maintenance).toEqual(LEGACY_GLOBAL_VALUE.maintenance);
    });

    it('the namespace getters KVox services call read the stored values', async () => {
      await expect(system.getNamespace('transcription')).resolves.toEqual(LEGACY_GLOBAL_VALUE.transcription);
      await expect(system.getNamespace('ai')).resolves.toMatchObject(AI_KEPT_FIELDS);
      await expect(system.getNamespace('maintenance')).resolves.toEqual(LEGACY_GLOBAL_VALUE.maintenance);
    });
  });

  // ===========================================================================
  // user_settings
  // ===========================================================================

  describe('user_settings: graph and onboarding', () => {
    async function seedUserSettings(userId: string, value: Record<string, unknown>): Promise<void> {
      await prisma.userSettings.create({
        data: { userId, value: value as Prisma.InputJsonValue, version: 1 },
      });
    }

    const BASE = { theme: 'dark', profile: { imageSource: 'provider', imageObjectId: null } } as const;

    it('returns graph and onboarding when they are stored', async () => {
      const user = await createUser('present');
      await seedUserSettings(user.id, { ...BASE, graph: GRAPH_PREFERENCES, onboarding: ONBOARDING });

      const settings = (await users.getSettings(user.id)) as unknown as Record<string, unknown>;

      expect(settings.graph).toEqual(GRAPH_PREFERENCES);
      expect(settings.onboarding).toEqual(ONBOARDING);
      expect(settings.theme).toBe('dark');
    });

    it('omits graph and onboarding when they are absent (no null, no empty object)', async () => {
      const user = await createUser('absent');
      await seedUserSettings(user.id, { ...BASE });

      const settings = (await users.getSettings(user.id)) as unknown as Record<string, unknown>;

      expect(settings).not.toHaveProperty('graph');
      expect(settings).not.toHaveProperty('onboarding');
    });

    it('omits them for a user with no settings row at all, and does not store them', async () => {
      const user = await createUser('fresh');

      const settings = (await users.getSettings(user.id)) as unknown as Record<string, unknown>;

      expect(settings).not.toHaveProperty('graph');
      expect(settings).not.toHaveProperty('onboarding');
      const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(row.value).not.toHaveProperty('graph');
      expect(row.value).not.toHaveProperty('onboarding');
    });

    it('a theme PATCH keeps stored graph and onboarding', async () => {
      const user = await createUser('patch-present');
      await seedUserSettings(user.id, { ...BASE, graph: GRAPH_PREFERENCES, onboarding: ONBOARDING });

      await users.patchSettings(user.id, { theme: 'light' } as never);

      const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      const value = row.value as Record<string, unknown>;
      expect(value.theme).toBe('light');
      expect(value.graph).toEqual(GRAPH_PREFERENCES);
      expect(value.onboarding).toEqual(ONBOARDING);
    });

    it('a theme PATCH does not invent graph or onboarding when they are absent', async () => {
      const user = await createUser('patch-absent');
      await seedUserSettings(user.id, { ...BASE });

      await users.patchSettings(user.id, { theme: 'light' } as never);

      const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      expect(row.value).not.toHaveProperty('graph');
      expect(row.value).not.toHaveProperty('onboarding');
    });

    it('an onboarding PATCH is field-wise: it keeps the stored skipped list and graph', async () => {
      const user = await createUser('patch-onboarding');
      await seedUserSettings(user.id, { ...BASE, graph: GRAPH_PREFERENCES, onboarding: ONBOARDING });

      await users.patchSettings(user.id, { onboarding: { checklistDismissedAt: '2026-03-01T00:00:00.000Z' } } as never);

      const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId: user.id } });
      const value = row.value as Record<string, unknown>;
      expect(value.onboarding).toEqual({ ...ONBOARDING, checklistDismissedAt: '2026-03-01T00:00:00.000Z' });
      expect(value.graph).toEqual(GRAPH_PREFERENCES);
    });
  });
});

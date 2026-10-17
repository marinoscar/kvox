import { ModuleRef } from '@nestjs/core';
import {
  OnboardingService,
  assertOnboardingRegistries,
  onboardingFactRegistry,
  onboardingStepRegistry,
  type OnboardingDataPort,
} from '@marinoscar/platform-api/onboarding';
import { DoctorCheckRegistry, DoctorService } from '@marinoscar/platform-api/doctor';
import type { OnboardingResponse, OnboardingStep } from '@marinoscar/platform-contract/onboarding';

import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import { KVOX_AI } from '../../src/ai-port/kvox-ai';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TranscriptionConfigService } from '@marinoscar/kvox-api/transcription';

// =============================================================================
// This app's onboarding steps and facts on the platform slice (issue #481, epic #478)
// =============================================================================
//
// Lives under `test/` and not beside the steps: it names a domain service (the transcription
// probe's token), which base code under `src/platform/` may not import. Driven through the
// platform's real `OnboardingService` and the registries `kvox.manifest.ts` filled (the jest
// setup imports it), with the data port, the Doctor and the app providers a
// fact reads (`ModuleRef.get`) replaced by stubs. What this pins:
//
//   * the registry: exactly ONE `admin.ai`, this app's step ids, tiers, skippable flags and
//     order, and a fact for every fact id a step names;
//   * the statuses and blocked reasons the retired kvox service returned, in the platform's
//     vocabulary (`done`, `todo`, `blocked`);
//   * a Viewer's request never resolves an admin fact;
//   * each fact is resolved once per request, however many steps name it.
// =============================================================================

const ALL_PERMISSIONS = [
  'user_settings:read',
  'user_settings:write',
  PERMISSIONS.SYSTEM_SETTINGS_READ,
  PERMISSIONS.TRANSCRIPTS_WRITE,
  PERMISSIONS.NOTES_WRITE,
  'ai_config:read',
  'allowlist:read',
  'push:read',
  'db_backup:read',
  'storage_config:read',
];

const VIEWER_PERMISSIONS = [
  'user_settings:read',
  'user_settings:write',
  PERMISSIONS.TRANSCRIPTS_WRITE,
  PERMISSIONS.NOTES_WRITE,
];

interface World {
  transcriptionAvailable?: boolean;
  transcripts?: number;
  readyTranscripts?: number;
  notes?: number;
  ai?: { ok?: boolean; reason?: string | null; provider?: string | null; hasKey?: boolean };
  stored?: unknown;
  /** Doctor check statuses by id; unlisted checks pass. */
  doctor?: Record<string, 'pass' | 'fail' | 'skip'>;
}

function build(world: World = {}) {
  const ai = { ok: false, reason: 'ai_not_configured', provider: null, hasKey: false, ...world.ai };
  const getConfig = jest.fn(async () => ({ available: world.transcriptionAvailable ?? false }));
  const transcriptCount = jest.fn(async (args: { where: { status?: string } }) =>
    args.where.status === 'ready' ? (world.readyTranscripts ?? 0) : (world.transcripts ?? 0),
  );
  const noteCount = jest.fn(async () => world.notes ?? 0);
  const readiness = jest.fn(async () => ai);

  const providers = new Map<unknown, unknown>([
    [TranscriptionConfigService, { getConfig }],
    [PrismaService, { transcript: { count: transcriptCount }, note: { count: noteCount } }],
    [KVOX_AI, { readiness }],
  ]);
  const moduleRef = { get: (token: unknown) => providers.get(token) } as unknown as ModuleRef;

  const data = {
    readUserSettingsValue: jest.fn(async (_userId: string): Promise<unknown> => world.stored ?? null),
    countAllowlistEntriesExcept: jest.fn(async (_except: string | null) => 0),
    hasPushSubscription: jest.fn(async (_userId: string) => false),
    queryAggregate: jest.fn(async () => []),
  };

  const checkCategories = new Map<string, string>([
    ['storage.config', 'storage'],
    ['storage.bucket', 'storage'],
    ['email.config', 'email'],
    ['ai.enabled', 'ai'],
    ['ai.providers', 'ai'],
    ['push.vapid', 'push'],
    ['backup.schedule', 'backup'],
  ]);
  const checks = {
    get: (id: string) => (checkCategories.has(id) ? { id, category: checkCategories.get(id) } : undefined),
  } as unknown as DoctorCheckRegistry;
  const run = jest.fn(async ({ category }: { category: string }) => ({
    checks: [...checkCategories]
      .filter(([, cat]) => cat === category)
      .map(([id]) => ({
        id,
        status: world.doctor?.[id] ?? 'pass',
        detail: `${id} detail`,
        remedy: null,
      })),
  }));
  const doctor = { run } as unknown as DoctorService;

  const service = new OnboardingService(data as unknown as OnboardingDataPort, moduleRef, undefined, doctor, checks, undefined, undefined);

  return { service, data, getConfig, transcriptCount, noteCount, readiness, run };
}

function caller(permissions: string[]) {
  return { id: 'user-1', permissions, roles: [], activeOrgId: null };
}

function step(steps: readonly OnboardingStep[], id: string): OnboardingStep {
  const found = steps.find((s) => s.id === id);
  if (!found) throw new Error(`step ${id} is not in [${steps.map((s) => s.id).join(', ')}]`);
  return found;
}

async function read(world: World, permissions: string[]): Promise<OnboardingResponse & { _: ReturnType<typeof build> }> {
  const built = build(world);
  const response = await built.service.get(caller(permissions));
  return Object.assign(response as OnboardingResponse, { _: built });
}

describe('registry', () => {
  it('has exactly one admin.ai, and it is the platform step with the added model condition', () => {
    const matches = onboardingStepRegistry.list().filter((s) => s.id === 'admin.ai');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      tier: 'recommended',
      skippable: true,
      permission: 'ai_config:read',
      href: '/admin/settings/ai',
      doctorChecks: ['ai.enabled', 'ai.providers'],
    });
    expect(matches[0]!.facts).toContain('app.aiReadiness');
  });

  it('registers the five domain steps with their tier, skippable flag and permission', () => {
    const summary = Object.fromEntries(
      onboardingStepRegistry
        .list()
        .filter((s) => ['admin.transcription', 'admin.smoke_test', 'user.ai_key', 'user.first_transcript', 'user.first_note'].includes(s.id))
        .map((s) => [s.id, [s.audience, s.tier, s.skippable, s.permission ?? null]]),
    );
    expect(summary).toEqual({
      'admin.transcription': ['admin', 'required', false, 'system_settings:read'],
      'admin.smoke_test': ['admin', 'recommended', true, 'transcripts:write'],
      'user.ai_key': ['user', 'required', false, null],
      'user.first_transcript': ['user', 'required', false, 'transcripts:write'],
      'user.first_note': ['user', 'recommended', true, 'notes:write'],
    });
  });

  it('keeps the platform built-ins that replace this app\'s duplicates, each once', () => {
    const ids = onboardingStepRegistry.list().map((s) => s.id);
    for (const id of [
      'admin.storage',
      'admin.email',
      'admin.access',
      'admin.push',
      'admin.backup',
      'admin.org-invite',
      'user.profile',
      'user.notifications',
    ]) {
      expect(ids.filter((candidate) => candidate === id)).toHaveLength(1);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names only registered facts', () => {
    expect(() => assertOnboardingRegistries()).not.toThrow();
    for (const id of [
      'app.transcriptionAvailable',
      'app.ownTranscriptCount',
      'app.ownReadyTranscriptCount',
      'app.ownNoteCount',
      'app.aiReadiness',
    ]) {
      expect(onboardingFactRegistry.has(id)).toBe(true);
    }
  });

  it('gives the two funnel steps the activation SQL', () => {
    const funnel = Object.fromEntries(
      onboardingStepRegistry
        .list()
        .filter((s) => s.funnelSql !== undefined && s.id.startsWith('user.first_'))
        .map((s) => [s.id, s.funnelSql]),
    );
    expect(funnel['user.first_transcript']).toContain('FROM transcripts');
    expect(funnel['user.first_note']).toContain('FROM notes');
  });

  it('orders the activation steps ahead of the platform profile steps, and email before access', () => {
    const order = (id: string) => onboardingStepRegistry.list().find((s) => s.id === id)!.order;
    expect(order('user.ai_key')).toBeLessThan(order('user.first_transcript'));
    expect(order('user.first_transcript')).toBeLessThan(order('user.first_note'));
    expect(order('user.first_note')).toBeLessThan(order('user.profile'));
    expect(order('admin.email')).toBeLessThan(order('admin.access'));
    expect(order('admin.storage')).toBeLessThan(order('admin.transcription'));
  });
});

describe('the user checklist (a Viewer)', () => {
  it('lists the three activation steps with the retired statuses on a fresh deployment', async () => {
    const response = await read(
      { ai: { ok: false, reason: 'ai_key_missing', provider: 'openai', hasKey: false } },
      VIEWER_PERMISSIONS,
    );
    const ids = response.user.steps.map((s) => s.id);

    expect(ids).toEqual(['user.ai_key', 'user.first_transcript', 'user.first_note', 'user.profile', 'user.notifications']);
    expect(step(response.user.steps, 'user.ai_key')).toMatchObject({ status: 'todo', blockedReason: null });
    expect(step(response.user.steps, 'user.first_transcript')).toMatchObject({ status: 'blocked' });
    expect(step(response.user.steps, 'user.first_transcript').blockedReason).toContain('administrator');
    // The deployment is usable once the user adds a key, so the note step asks for the key.
    expect(step(response.user.steps, 'user.first_note').blockedReason).toBe(
      'Add your own AI provider key first — notes are generated with it.',
    );
    expect(response.admin).toBeNull();
  });

  it('omits user.ai_key while no provider slot is on, and blames the administrator for notes', async () => {
    const response = await read({}, VIEWER_PERMISSIONS);

    expect(response.user.steps.map((s) => s.id)).not.toContain('user.ai_key');
    expect(step(response.user.steps, 'user.first_note').blockedReason).toBe(
      'Your administrator has not finished setting up AI generation for this deployment yet.',
    );
  });

  it('marks the steps done from the caller\'s own rows', async () => {
    const response = await read(
      {
        transcriptionAvailable: true,
        transcripts: 2,
        notes: 1,
        ai: { ok: true, reason: null, provider: 'openai', hasKey: true },
      },
      VIEWER_PERMISSIONS,
    );

    for (const id of ['user.ai_key', 'user.first_transcript', 'user.first_note']) {
      expect(step(response.user.steps, id).status).toBe('done');
    }
  });

  it('asks for the transcript, not for a provider, once transcription works', async () => {
    const response = await read({ transcriptionAvailable: true }, VIEWER_PERMISSIONS);

    expect(step(response.user.steps, 'user.first_transcript')).toMatchObject({ status: 'todo', blockedReason: null });
  });

  it('omits a step whose permission the caller lacks, and answers 200 shape for no permissions at all', async () => {
    const response = await read({}, ['user_settings:read']);
    const ids = response.user.steps.map((s) => s.id);

    expect(ids).not.toContain('user.first_transcript');
    expect(ids).not.toContain('user.first_note');
    expect(ids).toEqual(expect.arrayContaining(['user.profile', 'user.notifications']));
  });

  it('never resolves an admin fact, nor runs the Doctor, for a caller without the admin permission', async () => {
    const response = await read({}, VIEWER_PERMISSIONS);

    expect(response._.run).not.toHaveBeenCalled();
    expect(response._.data.countAllowlistEntriesExcept).not.toHaveBeenCalled();
  });

  it('keeps a skipped step skipped, and dismissed state in the stored shape', async () => {
    const response = await read(
      {
        stored: {
          onboarding: {
            welcomeSeenAt: '2026-01-01T00:00:00.000Z',
            checklistDismissedAt: '2026-01-02T00:00:00.000Z',
            skipped: ['user.first_note', 'admin.smoke_test'],
          },
        },
      },
      VIEWER_PERMISSIONS,
    );

    expect(response.settings.checklistDismissedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(step(response.user.steps, 'user.first_note').skipped).toBe(true);
    expect(response.settings.skipped).toEqual(['user.first_note', 'admin.smoke_test']);
  });
});

describe('the admin checklist', () => {
  it('lists transcription, the smoke test and exactly one admin.ai, with the retired statuses', async () => {
    const response = await read({}, ALL_PERMISSIONS);
    const admin = response.admin!.steps;

    expect(admin.filter((s) => s.id === 'admin.ai')).toHaveLength(1);
    expect(step(admin, 'admin.transcription')).toMatchObject({ status: 'todo', tier: 'required' });
    expect(step(admin, 'admin.smoke_test')).toMatchObject({ status: 'blocked', skippable: true, tier: 'recommended' });
    expect(step(admin, 'admin.smoke_test').blockedReason).toContain('transcription provider');
  });

  it('turns the smoke test to todo once transcription works, and done once a transcript is ready', async () => {
    const connected = await read({ transcriptionAvailable: true }, ALL_PERMISSIONS);
    expect(step(connected.admin!.steps, 'admin.transcription').status).toBe('done');
    expect(step(connected.admin!.steps, 'admin.smoke_test').status).toBe('todo');

    const proven = await read({ transcriptionAvailable: true, readyTranscripts: 1 }, ALL_PERMISSIONS);
    expect(step(proven.admin!.steps, 'admin.smoke_test').status).toBe('done');
  });

  it('keeps a skipped smoke test skipped', async () => {
    const response = await read(
      { stored: { onboarding: { skipped: ['admin.smoke_test'] } } },
      ALL_PERMISSIONS,
    );

    expect(step(response.admin!.steps, 'admin.smoke_test').skipped).toBe(true);
  });

  describe('admin.ai', () => {
    const ready = { ok: true, reason: null, provider: 'openai', hasKey: false } as const;

    it('is done when AI is on, the slot is on and a model is enabled', async () => {
      const response = await read({ ai: ready }, ALL_PERMISSIONS);

      expect(step(response.admin!.steps, 'admin.ai').status).toBe('done');
    });

    it('is still done when only the caller\'s own key is missing: that is the user\'s step', async () => {
      const response = await read(
        { ai: { ok: false, reason: 'ai_key_missing', provider: 'openai', hasKey: false } },
        ALL_PERMISSIONS,
      );

      expect(step(response.admin!.steps, 'admin.ai').status).toBe('done');
    });

    it('is todo, with a hint, when the provider is on but no model is enabled', async () => {
      const response = await read(
        { ai: { ok: false, reason: 'ai_not_configured', provider: 'openai', hasKey: false } },
        ALL_PERMISSIONS,
      );
      const ai = step(response.admin!.steps, 'admin.ai');

      expect(ai.status).toBe('todo');
      expect(ai.detail).toContain('model');
    });

    it('is todo with the Doctor\'s hint when AI is switched off (a skip is not a pass)', async () => {
      const response = await read({ doctor: { 'ai.enabled': 'skip', 'ai.providers': 'skip' } }, ALL_PERMISSIONS);

      expect(step(response.admin!.steps, 'admin.ai').status).toBe('todo');
    });

    it('is todo when the Doctor fails the providers check even though a model is enabled', async () => {
      const response = await read({ ai: ready, doctor: { 'ai.providers': 'fail' } }, ALL_PERMISSIONS);

      expect(step(response.admin!.steps, 'admin.ai').status).toBe('todo');
    });
  });

  it('resolves each fact once, however many steps and both checklists name it', async () => {
    const response = await read(
      { ai: { ok: true, reason: null, provider: 'openai', hasKey: true } },
      ALL_PERMISSIONS,
    );
    const { getConfig, readiness, transcriptCount, noteCount, data } = response._;

    // Named by admin.transcription, admin.smoke_test and user.first_transcript.
    expect(getConfig).toHaveBeenCalledTimes(1);
    // Named by admin.ai, user.ai_key and user.first_note.
    expect(readiness).toHaveBeenCalledTimes(1);
    // The two transcript counts differ by status; each is read once.
    expect(transcriptCount).toHaveBeenCalledTimes(2);
    expect(noteCount).toHaveBeenCalledTimes(1);
    expect(data.readUserSettingsValue).toHaveBeenCalledTimes(1);
  });

  it('writes nothing: the slice has no write path and the data port no write method', async () => {
    const response = await read({}, ALL_PERMISSIONS);

    expect(Object.keys(response._.data).sort()).toEqual(
      ['countAllowlistEntriesExcept', 'hasPushSubscription', 'queryAggregate', 'readUserSettingsValue'],
    );
  });
});

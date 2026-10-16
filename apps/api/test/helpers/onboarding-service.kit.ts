import type { ModuleRef } from '@nestjs/core';

import { PERMISSIONS } from '../../src/common/constants/roles.constants';
import type { RequestUser } from '@marinoscar/platform-api/identity';
import type { KvoxAi, KvoxAiReadiness } from '../../src/ai-port/kvox-ai';
import { notReadyReadiness, readyReadiness } from '../../src/ai-port/testing/fake-kvox-ai';
import type { EmailSettingsService } from '@marinoscar/platform-api/email';
import type { PushConfigService } from '@marinoscar/platform-api/notifications';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { SystemSettingsService, UserSettingsService } from '@marinoscar/platform-api/settings';
import type {
  OnboardingAdminContext,
  OnboardingUserContext,
} from '../../src/onboarding/onboarding-steps';
import { OnboardingService } from '../../src/onboarding/onboarding.service';
import type {
  OnboardingState,
  OnboardingStepState,
} from '../../src/onboarding/dto/onboarding-state.dto';

// =============================================================================
// A spec kit for OnboardingService (issue #460, step 7)
// =============================================================================
//
// Shared by `src/onboarding/onboarding.service.spec.ts` and the domain specs
// (`transcription.onboarding.spec.ts`, ...). It builds the real service over
// stubs for the BASE collaborators only, and a `ModuleRef` stand-in that resolves
// a fact's `inject` token from a map the spec fills (`kit.provide`). It imports
// no domain module, so the base spec stays free of domain imports; a domain spec
// supplies its own provider stubs.
//
// Every stub counts its calls into one total (`kit.reads()`), which is what makes
// the "a step never issues its own query" and "adding a step costs zero reads"
// assertions possible.
// =============================================================================

export interface KitFacts {
  ai?: Partial<OnboardingUserContext['ai']>;
  aiPolicy?: Partial<OnboardingAdminContext['aiPolicy']>;
  emailProvider?: 'smtp' | null;
  emailEnabled?: boolean;
  pushConfigured?: boolean;
  pushEnabled?: boolean;
  backupEnabled?: boolean;
  userCount?: number;
  allowedEmailCount?: number;
  displayName?: string | null;
  skipped?: string[];
}

export interface OnboardingKit {
  service: OnboardingService;
  /** Total reads performed by every counted stub since the last reset. */
  reads: () => number;
  resetReads: () => void;
  /** Wrap a value as a counted async stub body: `jest.fn(kit.counted(value))`. */
  counted: <T>(value: T) => () => Promise<T>;
  /** Register the stub `ModuleRef.get(token, { strict: false })` returns. */
  provide: (token: unknown, instance: unknown) => void;
  moduleRef: { get: jest.Mock };
  /** The `PrismaService` stub. A domain spec adds the models its facts count. */
  prisma: {
    user: { count: jest.Mock };
    allowedEmail: { count: jest.Mock };
    [model: string]: unknown;
  };
  emailSettings: { describeForAdmin: jest.Mock };
  pushConfig: { describeForAdmin: jest.Mock };
  systemSettings: { getDatabaseBackupPolicy: jest.Mock };
  userSettings: { getSettings: jest.Mock };
  /** The AI port: only `readiness` is read by the checklist. */
  ai: { readiness: jest.Mock };
}

export function buildOnboardingKit(facts: KitFacts = {}): OnboardingKit {
  let reads = 0;
  const counted =
    <T>(value: T) =>
    (): Promise<T> => {
      reads += 1;
      return Promise.resolve(value);
    };

  const prisma: OnboardingKit['prisma'] = {
    user: { count: jest.fn(counted(facts.userCount ?? 1)) },
    allowedEmail: { count: jest.fn(counted(facts.allowedEmailCount ?? 1)) },
  };

  // ⚠ `in`, not `??`: `provider` is legitimately `null` (no vendor chosen), and a
  // `??` default would turn that case back into the configured one.
  const provider = facts.ai && 'provider' in facts.ai ? (facts.ai.provider ?? null) : 'openai';
  const available = facts.ai?.available ?? true;
  const keyConfigured = facts.ai?.keyConfigured ?? true;
  const deploymentConfigured = facts.aiPolicy?.configured ?? true;

  /** The one `KvoxAi.readiness` answer both audiences' AI facts are derived from. */
  const readiness: KvoxAiReadiness = (() => {
    if (!available || !deploymentConfigured) {
      return { ...notReadyReadiness('ai_not_configured'), provider, hasKey: keyConfigured };
    }
    if (!keyConfigured) return { ...notReadyReadiness('ai_key_missing'), provider };
    return readyReadiness({ provider });
  })();

  const ai = { readiness: jest.fn(counted(readiness)) };

  // ⚠ `in`, not `??`: no display name set is legitimately `null`.
  const displayName =
    'displayName' in facts ? (facts.displayName ?? null) : 'Ada Lovelace';

  const userSettings = {
    getSettings: jest.fn(
      counted({
        profile: { displayName },
        ...(facts.skipped ? { onboarding: { skipped: facts.skipped } } : {}),
      }),
    ),
  };

  const systemSettings = {
    getDatabaseBackupPolicy: jest.fn(counted({ enabled: facts.backupEnabled ?? true })),
  };

  const emailSettings = {
    describeForAdmin: jest.fn(
      counted({
        provider: facts.emailProvider === undefined ? 'smtp' : facts.emailProvider,
        enabled: facts.emailEnabled ?? true,
      }),
    ),
  };

  const pushConfig = {
    describeForAdmin: jest.fn(
      counted({
        configured: facts.pushConfigured ?? true,
        enabled: facts.pushEnabled ?? true,
      }),
    ),
  };

  const providers = new Map<unknown, unknown>([[PrismaService, prisma]]);
  const moduleRef = {
    // Mirrors `ModuleRef.get`: an unresolvable token THROWS rather than
    // returning undefined, which is what the service must surface as a failure.
    get: jest.fn((token: unknown) => {
      if (!providers.has(token)) {
        throw new Error(`Nest could not find ${String(token)} element (this provider does not exist)`);
      }
      return providers.get(token);
    }),
  };

  const service = new OnboardingService(
    prisma as unknown as PrismaService,
    ai as unknown as KvoxAi,
    userSettings as unknown as UserSettingsService,
    systemSettings as unknown as SystemSettingsService,
    emailSettings as unknown as EmailSettingsService,
    pushConfig as unknown as PushConfigService,
    moduleRef as unknown as ModuleRef,
  );

  return {
    service,
    reads: () => reads,
    resetReads: () => {
      reads = 0;
      for (const stub of [
        prisma.user.count,
        prisma.allowedEmail.count,
        ai.readiness,
        userSettings.getSettings,
        systemSettings.getDatabaseBackupPolicy,
        emailSettings.describeForAdmin,
        pushConfig.describeForAdmin,
        moduleRef.get,
      ]) {
        stub.mockClear();
      }
    },
    counted,
    provide: (token, instance) => {
      providers.set(token, instance);
    },
    moduleRef,
    prisma,
    emailSettings,
    pushConfig,
    systemSettings,
    userSettings,
    ai,
  };
}

/** A caller holding every permission any step names, so nothing is filtered. */
export const OMNIPOTENT: RequestUser = {
  id: 'user-1',
  email: 'ada@example.com',
  roles: ['admin'],
  permissions: Object.values(PERMISSIONS),
  isActive: true,
};

export function callerWith(permissions: string[]): RequestUser {
  return { ...OMNIPOTENT, permissions };
}

export function stepOf(
  state: OnboardingState,
  key: string,
): OnboardingStepState | undefined {
  return state.steps.find((step) => step.key === key);
}

/** The step named, asserted present — so a typo in a key fails loudly. */
export function requireStep(state: OnboardingState, key: string): OnboardingStepState {
  const step = stepOf(state, key);
  if (!step) {
    throw new Error(`Expected step ${key} in the ${state.audience} checklist`);
  }
  return step;
}

/** Recursively `Object.freeze`, so a step mutating its context throws. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

import { describe, expect, it } from 'vitest';

import {
  COPILOT_CONSENT_VERSION,
  COPILOT_DEFAULT_SETTINGS,
  CopilotSettingsPatchSchema,
  CopilotSettingsSchema,
  CopilotSignInChallengeSchema,
  CopilotStatusSchema,
  type CopilotSettings,
} from '../../src/copilot/index.js';

const readyStatus = {
  enabled: true,
  signedIn: true,
  login: 'octocat',
  runtime: { state: 'ready', version: '1.0.98', progress: null },
  models: [{ id: 'gpt-5', label: 'GPT-5', structuredOutput: 'native' }],
  unavailableTasks: [{ task: 'ask', reason: 'needs_tool_calling' }],
};

describe('COPILOT_CONSENT_VERSION', () => {
  it('is the permanent string "1" for the first consent text', () => {
    expect(COPILOT_CONSENT_VERSION).toBe('1');
  });
});

describe('CopilotSettingsSchema', () => {
  it('defaults to off with no consent and no model', () => {
    expect(CopilotSettingsSchema.parse({})).toEqual({
      enabled: false,
      consentedAt: null,
      consentVersion: null,
      model: null,
    });
    expect(COPILOT_DEFAULT_SETTINGS).toEqual(CopilotSettingsSchema.parse({}));
  });

  it('exports a frozen default that cannot be mutated by a host', () => {
    expect(Object.isFrozen(COPILOT_DEFAULT_SETTINGS)).toBe(true);
  });

  it('accepts a full consented setting', () => {
    const value: CopilotSettings = {
      enabled: true,
      consentedAt: '2026-10-19T10:00:00.000Z',
      consentVersion: COPILOT_CONSENT_VERSION,
      model: 'gpt-5',
    };
    expect(CopilotSettingsSchema.parse(value)).toEqual(value);
  });

  it('rejects a consentedAt that is not an ISO date-time', () => {
    expect(CopilotSettingsSchema.safeParse({ consentedAt: 'yesterday' }).success).toBe(false);
  });

  it('rejects a non-boolean enabled', () => {
    expect(CopilotSettingsSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
});

describe('CopilotSettingsPatchSchema', () => {
  it('parses a model-only patch to exactly the keys sent, with no defaults added', () => {
    const parsed = CopilotSettingsPatchSchema.parse({ model: 'gpt-4.1' });
    expect(parsed).toEqual({ model: 'gpt-4.1' });
    expect(Object.keys(parsed)).toEqual(['model']);
  });

  it('documents the bug: CopilotSettingsSchema.partial() still applies the defaults to a model-only patch', () => {
    expect(CopilotSettingsSchema.partial().strict().parse({ model: 'gpt-4.1' })).toEqual({
      enabled: false,
      consentedAt: null,
      consentVersion: null,
      model: 'gpt-4.1',
    });
  });

  it('parses an empty patch to an empty object', () => {
    expect(CopilotSettingsPatchSchema.parse({})).toEqual({});
  });

  it('keeps every field it was sent, including false', () => {
    const patch = { enabled: false, consentedAt: '2026-10-19T10:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION, model: 'gpt-5' };
    expect(CopilotSettingsPatchSchema.parse(patch)).toEqual(patch);
    expect(CopilotSettingsPatchSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('passes null through for the nullable fields', () => {
    const patch = { consentedAt: null, consentVersion: null, model: null };
    const parsed = CopilotSettingsPatchSchema.parse(patch);
    expect(parsed).toEqual(patch);
    expect(Object.keys(parsed).sort()).toEqual(['consentVersion', 'consentedAt', 'model']);
  });

  it('rejects null for enabled', () => {
    expect(CopilotSettingsPatchSchema.safeParse({ enabled: null }).success).toBe(false);
  });

  it('rejects an unknown key (strict)', () => {
    expect(CopilotSettingsPatchSchema.safeParse({ model: 'gpt-5', extra: 1 }).success).toBe(false);
    expect(CopilotSettingsPatchSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('rejects a non-boolean enabled', () => {
    expect(CopilotSettingsPatchSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });

  it('rejects a consentedAt that is not an ISO date-time', () => {
    expect(CopilotSettingsPatchSchema.safeParse({ consentedAt: 'yesterday' }).success).toBe(false);
    expect(CopilotSettingsPatchSchema.safeParse({ consentedAt: '2026-10-19' }).success).toBe(false);
  });

  it('rejects a non-string model', () => {
    expect(CopilotSettingsPatchSchema.safeParse({ model: 5 }).success).toBe(false);
  });

  it('leaves CopilotSettingsSchema.parse({}) equal to COPILOT_DEFAULT_SETTINGS', () => {
    expect(CopilotSettingsSchema.parse({})).toEqual(COPILOT_DEFAULT_SETTINGS);
  });

  it.each(['enabled', 'consentedAt', 'consentVersion', 'model'] as const)(
    'gives %s the same description in the full and the patch schema',
    (field) => {
      const full = CopilotSettingsSchema.shape[field].description;
      const patch = CopilotSettingsPatchSchema.shape[field].description;
      expect(full).toEqual(expect.any(String));
      expect(full).not.toBe('');
      expect(patch).toBe(full);
    },
  );
});

describe('CopilotStatusSchema', () => {
  it('accepts a ready, signed-in status', () => {
    expect(CopilotStatusSchema.parse(readyStatus)).toEqual(readyStatus);
  });

  it('accepts a downloading runtime with progress and a signed-out account', () => {
    const status = {
      ...readyStatus,
      signedIn: false,
      login: null,
      runtime: { state: 'downloading', version: null, progress: 0.4 },
      models: [],
    };
    expect(CopilotStatusSchema.parse(status)).toEqual(status);
  });

  it.each(['missing', 'downloading', 'ready', 'error'])('accepts runtime state %s', (state) => {
    const status = { ...readyStatus, runtime: { state, version: null, progress: null } };
    expect(CopilotStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects an unknown runtime state', () => {
    const status = { ...readyStatus, runtime: { state: 'installing', version: null, progress: null } };
    expect(CopilotStatusSchema.safeParse(status).success).toBe(false);
  });

  it.each([-0.1, 1.1])('rejects progress %s outside 0..1', (progress) => {
    const status = { ...readyStatus, runtime: { state: 'downloading', version: null, progress } };
    expect(CopilotStatusSchema.safeParse(status).success).toBe(false);
  });

  it('rejects a model with an unknown structured-output mode', () => {
    const status = { ...readyStatus, models: [{ id: 'm', label: 'M', structuredOutput: 'maybe' }] };
    expect(CopilotStatusSchema.safeParse(status).success).toBe(false);
  });

  it('rejects an unavailable-task reason that is not known', () => {
    const status = { ...readyStatus, unavailableTasks: [{ task: 'ask', reason: 'because' }] };
    expect(CopilotStatusSchema.safeParse(status).success).toBe(false);
  });

  it('accepts both unavailable-task reasons', () => {
    const status = {
      ...readyStatus,
      unavailableTasks: [
        { task: 'ask', reason: 'needs_tool_calling' },
        { task: 'search.embed', reason: 'needs_embeddings' },
      ],
    };
    expect(CopilotStatusSchema.safeParse(status).success).toBe(true);
  });

  it('requires every top-level field', () => {
    const { login: _login, ...withoutLogin } = readyStatus;
    expect(CopilotStatusSchema.safeParse(withoutLogin).success).toBe(false);
  });
});

describe('CopilotSignInChallengeSchema', () => {
  it('accepts a device challenge', () => {
    const challenge = {
      kind: 'device',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresAt: '2026-10-19T10:15:00.000Z',
    };
    expect(CopilotSignInChallengeSchema.parse(challenge)).toEqual(challenge);
  });

  it('accepts a browser challenge', () => {
    const challenge = { kind: 'browser', url: 'https://github.com/login/oauth/authorize?client_id=x' };
    expect(CopilotSignInChallengeSchema.parse(challenge)).toEqual(challenge);
  });

  it('rejects a device challenge whose address is not a URL', () => {
    const challenge = { kind: 'device', userCode: 'A', verificationUri: 'not a url', expiresAt: 'x' };
    expect(CopilotSignInChallengeSchema.safeParse(challenge).success).toBe(false);
  });

  it('rejects a browser challenge without a url', () => {
    expect(CopilotSignInChallengeSchema.safeParse({ kind: 'browser' }).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(CopilotSignInChallengeSchema.safeParse({ kind: 'qr', url: 'https://github.com' }).success).toBe(false);
  });
});

import type { CopilotSettings, CopilotStatus } from '@marinoscar/kvox-contract/copilot';
import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';

export const NOW = '2026-10-19T10:00:00.000Z';

export function makeStatus(overrides: Partial<CopilotStatus> = {}): CopilotStatus {
  return {
    enabled: true,
    signedIn: false,
    login: null,
    runtime: { state: 'ready', version: '1.0.98', progress: null },
    models: [],
    unavailableTasks: [{ task: 'ask.respond', reason: 'needs_tool_calling' }],
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<CopilotSettings> = {}): CopilotSettings {
  return { enabled: false, consentedAt: null, consentVersion: null, model: null, ...overrides };
}

export function consentedSettings(overrides: Partial<CopilotSettings> = {}): CopilotSettings {
  return makeSettings({ enabled: true, consentedAt: NOW, consentVersion: COPILOT_CONSENT_VERSION, ...overrides });
}

export const SIGNED_IN: Partial<CopilotStatus> = {
  signedIn: true,
  login: 'octocat',
  models: [
    { id: 'gpt-5', label: 'GPT-5', structuredOutput: 'native' },
    { id: 'claude-sonnet', label: 'Claude Sonnet', structuredOutput: 'prompted' },
  ],
};

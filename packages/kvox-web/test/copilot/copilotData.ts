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
    // What Copilot reports since Ask runs on it (marinoscar/kvox#654): only search by meaning is unavailable.
    unavailableTasks: [
      { task: 'search.embed', reason: 'needs_embeddings' },
      { task: 'graph.embed', reason: 'needs_embeddings' },
    ],
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

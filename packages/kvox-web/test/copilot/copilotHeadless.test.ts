import { describe, expect, it } from 'vitest';

import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';

import {
  COPILOT_CONSENT_COPY,
  COPILOT_SIGN_IN_REASON_TEXT,
  buildCopilotCapabilities,
  copilotRuntimeDownloadNote,
  copilotSignInReasonText,
  hasCopilotConsent,
} from '../../src/copilot/headless/index.js';

describe('COPILOT_CONSENT_COPY', () => {
  it('is the text of the current consent version', () => {
    expect(COPILOT_CONSENT_COPY.version).toBe(COPILOT_CONSENT_VERSION);
  });

  it('links GitHub’s terms and the Copilot data and privacy page over https', () => {
    const hrefs = COPILOT_CONSENT_COPY.links.map((l) => l.href);
    expect(hrefs).toContain(
      'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot',
    );
    expect(hrefs).toContain('https://docs.github.com/en/copilot/responsible-use-of-github-copilot-features');
    expect(hrefs.every((h) => h.startsWith('https://'))).toBe(true);
  });

  it('says what is sent, that it is opt-in and off-able, and that Ask is unavailable', () => {
    const all = COPILOT_CONSENT_COPY.points.map((p) => `${p.heading} ${p.text}`).join('\n');
    expect(all).toMatch(/note and transcript text, is sent to GitHub Copilot/);
    expect(all).toMatch(/opt-in and off by default/);
    expect(all).toMatch(/turn it off at any time/);
    expect(all).toMatch(/Ask is not available with Copilot/);
    expect(all).toMatch(/Add an OpenAI key to keep Ask/);
  });
});

describe('copilotRuntimeDownloadNote', () => {
  it('states the given size, else the approximation', () => {
    expect(copilotRuntimeDownloadNote('151 MB')).toContain('151 MB');
    expect(copilotRuntimeDownloadNote()).toContain('about 130 to 175 MB');
  });
});

describe('copilotSignInReasonText', () => {
  it('words every permanent signInReason, on the error or its details', () => {
    for (const [reason, text] of Object.entries(COPILOT_SIGN_IN_REASON_TEXT)) {
      expect(copilotSignInReasonText({ details: { signInReason: reason } })).toBe(text);
      expect(copilotSignInReasonText({ signInReason: reason })).toBe(text);
    }
    expect(Object.keys(COPILOT_SIGN_IN_REASON_TEXT)).toHaveLength(7);
  });

  it('returns null for an unknown reason or a value without one', () => {
    expect(copilotSignInReasonText({ details: { signInReason: 'something_new' } })).toBeNull();
    expect(copilotSignInReasonText(new Error('x'))).toBeNull();
    expect(copilotSignInReasonText(null)).toBeNull();
    expect(copilotSignInReasonText('text')).toBeNull();
  });
});

describe('hasCopilotConsent', () => {
  it('needs a date and the current version', () => {
    expect(hasCopilotConsent({ consentedAt: null, consentVersion: null })).toBe(false);
    expect(hasCopilotConsent({ consentedAt: '2026-10-19T10:00:00.000Z', consentVersion: '0' })).toBe(false);
    expect(hasCopilotConsent({ consentedAt: null, consentVersion: COPILOT_CONSENT_VERSION })).toBe(false);
    expect(hasCopilotConsent({ consentedAt: '2026-10-19T10:00:00.000Z', consentVersion: COPILOT_CONSENT_VERSION })).toBe(
      true,
    );
  });
});

describe('buildCopilotCapabilities', () => {
  it('maps unavailableTasks onto the rows', () => {
    const rows = buildCopilotCapabilities({
      unavailableTasks: [
        { task: 'ask.respond', reason: 'needs_tool_calling' },
        { task: 'graph.embed', reason: 'needs_embeddings' },
      ],
    });
    expect(rows.map((r) => [r.label, r.available])).toEqual([
      ['Notes', true],
      ['Knowledge extraction', true],
      ['Name check', true],
      ['Ask', false],
      ['Search by meaning', false],
    ]);
    expect(rows[3]?.note).toMatch(/Add an OpenAI key to keep Ask/);
  });

  it('makes a row unavailable when any one of its tasks is', () => {
    const rows = buildCopilotCapabilities({
      unavailableTasks: [{ task: 'graph.digest', reason: 'needs_tool_calling' }],
    });
    expect(rows.find((r) => r.label === 'Knowledge extraction')?.available).toBe(false);
  });

  it('lists only the four always-on rows when nothing is unavailable', () => {
    expect(buildCopilotCapabilities({ unavailableTasks: [] }).map((r) => r.label)).toEqual([
      'Notes',
      'Knowledge extraction',
      'Name check',
      'Ask',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../../../branding.js';
import type { CertificateExpiry } from '../../../deploy/proxy.js';
import { RENEW_WITHIN_DAYS } from '../../../deploy/update.js';
import { CONFIRM_DEFAULT_INDEX, confirmChoices } from '../../components/index.js';
import {
  certificateActionTitle,
  certificateActions,
  certificateStatusOf,
  certificatesHints,
  certificatesModel,
  renewalOutcome,
} from './certificates-model.js';

// =============================================================================
// The certificates screen  (issue #132, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency (see ../status.test.ts), so this
// asserts the data. Two properties are worth protecting: the expiry thresholds
// are the SAME ones the deploy renews on (a screen with its own idea of "soon"
// would tell an operator a certificate is fine on the day `update` starts
// renewing it), and every action goes through a confirm whose default is no.
//
// Hostnames here are `.example.com` placeholders, never a real domain.
// =============================================================================

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-15T00:00:00.000Z');

function entry(domain: string, daysLeft: number | undefined): CertificateExpiry {
  if (daysLeft === undefined) return { domain };
  return { domain, notAfter: new Date(NOW + daysLeft * DAY), daysLeft };
}

describe('certificateStatusOf', () => {
  it('uses the same 30-day window the deploy renews inside', () => {
    expect(RENEW_WITHIN_DAYS).toBe(30);
    expect(certificateStatusOf(entry('app.example.com', 31)).status).toBe('valid');
    expect(certificateStatusOf(entry('app.example.com', 30)).status).toBe('expiring');
  });

  it('calls an expired certificate expired, and says for how long', () => {
    const { status, detail } = certificateStatusOf(entry('old.example.com', -4));

    expect(status).toBe('expired');
    expect(detail).toContain('EXPIRED 4 day(s) ago');
  });

  it('does not pretend to know an expiry openssl could not read', () => {
    const { status, detail } = certificateStatusOf(entry('mystery.example.com', undefined));

    expect(status).toBe('unknown');
    expect(detail).toBe('expiry could not be read');
  });
});

describe('certificatesModel', () => {
  const model = certificatesModel({
    entries: [
      entry('app.example.com', 74),
      entry('old.example.com', -2),
      entry('soon.example.com', 12),
    ],
    proxyRoot: '/opt/infra/proxy',
    renewal: 'certbot.timer is enabled',
    now: NOW,
  });

  it('gives each domain a colourable status rather than a plain table row', () => {
    expect(model.certificates.map((row) => [row.id, row.status])).toEqual([
      ['app.example.com', 'pass'],
      ['old.example.com', 'fail'],
      ['soon.example.com', 'warn'],
    ]);
  });

  it('shows the expiry per domain', () => {
    expect(model.certificates[0]?.detail).toContain('valid for 74 more day(s)');
    expect(model.certificates[2]?.detail).toContain('expires in 12 day(s)');
  });

  it('offers a remedy on everything that is not simply fine', () => {
    expect(model.certificates[0]?.remedy).toBeUndefined();
    expect(model.certificates[1]?.remedy).toContain(CLI_NAME);
    expect(model.certificates[2]?.remedy).toBeDefined();
  });

  it('reports the renewal as a first-class fact, not a footnote', () => {
    const renewal = model.facts.find((row) => row.key === 'Automatic renewal');

    expect(renewal?.value).toBe('certbot.timer is enabled');
    expect(model.renewalMissing).toBe(false);
    expect(model.anyExpired).toBe(true);
  });

  it('says what an unscheduled renewal actually costs', () => {
    const none = certificatesModel({
      entries: [entry('app.example.com', 74)],
      proxyRoot: '/opt/infra/proxy',
      now: NOW,
    });
    const renewal = none.facts.find((row) => row.key === 'Automatic renewal');

    expect(none.renewalMissing).toBe(true);
    expect(renewal?.value).toBe('not scheduled');
    // A certificate nobody renews is a 90-day timer on an outage.
    expect(renewal?.note).toContain('90 days');
  });

  it('is empty, not broken, when nothing has been issued yet', () => {
    const none = certificatesModel({ entries: [], proxyRoot: '/opt/infra/proxy', now: NOW });

    expect(none.empty).toBe(true);
    expect(none.certificates).toEqual([]);
    expect(none.facts.find((row) => row.key === 'Certificates')?.value).toBe('none found');
  });
});

describe('certificateActions', () => {
  const model = certificatesModel({
    entries: [entry('app.example.com', 74)],
    proxyRoot: '/opt/infra/proxy',
    now: NOW,
  });

  it('offers the dry run FIRST, so the rehearsal is the easy one to reach', () => {
    expect(certificateActions(model).map((action) => action.key)).toEqual([
      'dry-run',
      'renew',
      'install-cron',
    ]);
    expect(certificateActions(model)[0]?.label).toBe('Renew now (dry run)');
  });

  it('puts every action behind a confirm whose default answer is no', () => {
    for (const action of certificateActions(model)) {
      const choices = confirmChoices(action.confirm.confirmLabel, action.confirm.cancelLabel);
      expect(choices[CONFIRM_DEFAULT_INDEX]?.value, action.key).toBe(false);
      expect(action.confirm.detail.length, action.key).toBeGreaterThan(0);
    }
  });

  it('marks only the real renewal as dangerous', () => {
    const byKey = new Map(certificateActions(model).map((action) => [action.key, action]));

    expect(byKey.get('dry-run')?.confirm.danger).toBe(false);
    expect(byKey.get('renew')?.confirm.danger).toBe(true);
  });

  it('says the dry run spends no rate-limit budget', () => {
    expect(certificateActions(model)[0]?.confirm.detail.join(' ')).toContain('rate-limit');
  });

  it('offers the cron whether or not one exists, and names which', () => {
    const missing = certificateActions(model).find((action) => action.key === 'install-cron');
    const present = certificateActions(
      certificatesModel({
        entries: [entry('app.example.com', 74)],
        proxyRoot: '/opt/infra/proxy',
        renewal: '/etc/cron.d/x',
        now: NOW,
      }),
    ).find((action) => action.key === 'install-cron');

    expect(missing?.label).toBe('Install renewal cron');
    // Re-running it is how a cron pointing at a moved checkout gets fixed.
    expect(present?.label).toBe('Reinstall renewal cron');
    expect(missing?.confirm.detail.join(' ')).toContain(CLI_NAME);
  });
});

describe('renewalOutcome', () => {
  it('never claims a dry run renewed anything', () => {
    expect(renewalOutcome({ action: 'dry-run', renewed: ['app.example.com'], reloaded: false })).toBe(
      'Dry run complete. Nothing was renewed or reloaded.',
    );
  });

  it('distinguishes "nothing was due" from a renewal', () => {
    expect(renewalOutcome({ action: 'renew', renewed: [], reloaded: false })).toBe(
      'Nothing was due for renewal.',
    );
    expect(
      renewalOutcome({ action: 'renew', renewed: ['app.example.com'], reloaded: true }),
    ).toContain('Renewed app.example.com');
  });

  it('says whether the cron file changed, because re-running it is idempotent', () => {
    expect(
      renewalOutcome({
        action: 'install-cron',
        renewed: [],
        reloaded: false,
        cron: { path: '/etc/cron.d/x', changed: false },
      }),
    ).toBe('Kept /etc/cron.d/x');
    expect(
      renewalOutcome({
        action: 'install-cron',
        renewed: [],
        reloaded: false,
        cron: { path: '/etc/cron.d/x', changed: true },
      }),
    ).toBe('Wrote /etc/cron.d/x');
  });
});

describe('titles and hints', () => {
  it('titles each action distinctly, so a dry run is never mistaken for one', () => {
    expect(certificateActionTitle('dry-run')).toContain('dry run');
    expect(certificateActionTitle('renew')).toBe('Renewal');
    expect(certificateActionTitle('install-cron')).toBe('Renewal cron');
  });

  it('binds a bare r, because this screen has no field to type into', () => {
    expect(certificatesHints(false)).toContain('r refresh');
    expect(certificatesHints(true)).not.toContain('r refresh');
  });
});

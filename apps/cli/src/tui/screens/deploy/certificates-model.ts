import { CLI_NAME } from '../../../branding.js';
import type { CertificateExpiry } from '../../../deploy/proxy.js';
import { RENEW_WITHIN_DAYS } from '../../../deploy/update.js';
import {
  DEFAULT_CANCEL_LABEL,
  type ChecklistItem,
  type KeyValueRow,
} from '../../components/index.js';

// =============================================================================
// The certificates screen, as data  (issue #132, epic #118)
// =============================================================================
//
// A certificate nobody renews is a 90-day timer on an outage, which is why
// `checks/tls.ts`'s `certificate-renewal` exists and why THE CRON IS A FIRST-
// CLASS ROW HERE rather than a detail under the expiries: an operator looking
// at "valid for 74 more days" and nothing else has no way to learn that the
// thing which was going to renew it was never installed.
//
// THE EXPIRIES ARE A CHECKLIST, NOT A TABLE, because their whole content is a
// status: expired, expiring, fine. `KeyValue` has no colour and no glyph, and
// a red `XX` beside a hostname is the one thing a person scanning this screen
// over SSH will actually see. `checks/tls.ts`'s 30-day warning threshold is
// reused (as `RENEW_WITHIN_DAYS`, which `update.ts` publishes and its publish
// step renews on) rather than restated, so the screen and the deploy agree
// about what "soon" means.
//
// THIS SCREEN RENDERS; IT DOES NOT DECIDE. Every action below is
// `renewCertificates` or `installRenewalCron` with the arguments the
// subcommand would pass — the issue's own out-of-scope line, and the reason
// the dry run is offered first.
// =============================================================================

export type CertificateStatus = 'valid' | 'expiring' | 'expired' | 'unknown';

/** The 30-day window `deploy update`'s publish step renews inside. */
export { RENEW_WITHIN_DAYS };

export interface CertificatesModel {
  /** One row per lineage under the proxy. */
  certificates: ChecklistItem[];
  /** Proxy root, the renewal cron, and how many certificates were found. */
  facts: KeyValueRow[];
  /** Nothing under `<proxyRoot>/letsencrypt/live`: the actions are pointless. */
  empty: boolean;
  /** At least one certificate has already expired. */
  anyExpired: boolean;
  /** No renewal timer or cron entry was found. */
  renewalMissing: boolean;
}

export interface CertificatesInput {
  entries: readonly CertificateExpiry[];
  proxyRoot: string;
  /** Where the renewal is scheduled (`findRenewal`'s answer), or undefined. */
  renewal?: string | undefined;
  now?: number | undefined;
}

/** Expired, expiring within the renewal window, fine, or unreadable. */
export function certificateStatusOf(
  entry: CertificateExpiry,
): { status: CertificateStatus; detail: string } {
  if (entry.daysLeft === undefined || entry.notAfter === undefined) {
    return { status: 'unknown', detail: 'expiry could not be read' };
  }
  const on = entry.notAfter.toISOString().slice(0, 10);
  if (entry.daysLeft < 0) {
    return { status: 'expired', detail: `EXPIRED ${-entry.daysLeft} day(s) ago (${on})` };
  }
  if (entry.daysLeft <= RENEW_WITHIN_DAYS) {
    return { status: 'expiring', detail: `expires in ${entry.daysLeft} day(s) (${on})` };
  }
  return { status: 'valid', detail: `valid for ${entry.daysLeft} more day(s) (${on})` };
}

const GLYPH: Record<CertificateStatus, ChecklistItem['status']> = {
  valid: 'pass',
  expiring: 'warn',
  expired: 'fail',
  unknown: 'warn',
};

const REMEDY = `Renew it from this screen, or run \`${CLI_NAME} deploy certs renew --all\`.`;

export function certificatesModel(input: CertificatesInput): CertificatesModel {
  const certificates: ChecklistItem[] = input.entries.map((entry) => {
    const { status, detail } = certificateStatusOf(entry);
    return {
      id: entry.domain,
      title: entry.domain,
      status: GLYPH[status],
      detail,
      ...(status === 'valid' ? {} : { remedy: REMEDY }),
    };
  });

  const renewalMissing = input.renewal === undefined || input.renewal === '';

  return {
    certificates,
    facts: [
      { key: 'Proxy root', value: input.proxyRoot },
      {
        key: 'Automatic renewal',
        value: renewalMissing ? 'not scheduled' : input.renewal ?? '',
        note: renewalMissing
          ? // 90 days from issuance, with no warning, is the failure mode.
            '(the site breaks 90 days after issuance with nothing to stop it)'
          : undefined,
      },
      {
        key: 'Certificates',
        value: input.entries.length === 0 ? 'none found' : String(input.entries.length),
      },
    ],
    empty: input.entries.length === 0,
    anyExpired: input.entries.some((entry) => (entry.daysLeft ?? 0) < 0),
    renewalMissing,
  };
}

// -----------------------------------------------------------------------------
// The three actions
// -----------------------------------------------------------------------------

export type CertificateAction = 'dry-run' | 'renew' | 'install-cron';

export interface CertificateActionSpec {
  key: CertificateAction;
  label: string;
  /** The confirm shown before it runs; every action has one. */
  confirm: {
    message: string;
    detail: string[];
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
  };
}

/**
 * The actions, dry run FIRST and on purpose.
 *
 * Let's Encrypt rate-limits issuance, and `renewCertificates`' `--dry-run`
 * rehearses against staging without spending any of that budget or touching
 * what is on disk. Offering it above the real renewal is how a screen says
 * "check first" without a paragraph nobody reads.
 */
export function certificateActions(model: CertificatesModel): CertificateActionSpec[] {
  const actions: CertificateActionSpec[] = [
    {
      key: 'dry-run',
      label: 'Renew now (dry run)',
      confirm: {
        message: 'Rehearse a renewal?',
        detail: [
          'certbot runs against the staging environment.',
          'Nothing on disk changes and no rate-limit budget is spent.',
        ],
        confirmLabel: 'Yes, rehearse it',
        cancelLabel: DEFAULT_CANCEL_LABEL,
        danger: false,
      },
    },
    {
      key: 'renew',
      label: 'Renew now',
      confirm: {
        message: 'Renew the certificates behind this proxy?',
        detail: [
          "A certificate that is not due is left alone — certbot decides, not this screen.",
          'The proxy is reloaded only if something was actually renewed.',
        ],
        confirmLabel: 'Yes, renew now',
        cancelLabel: DEFAULT_CANCEL_LABEL,
        danger: true,
      },
    },
  ];

  // Offered whatever the state: re-running it rewrites the file, which is how
  // a cron pointing at a moved checkout gets fixed.
  actions.push({
    key: 'install-cron',
    label: model.renewalMissing ? 'Install renewal cron' : 'Reinstall renewal cron',
    confirm: {
      message: 'Write the renewal cron?',
      detail: [
        `Writes /etc/cron.d/${CLI_NAME}-certs-<app>, 0644, twice daily.`,
        'It renews every lineage under the shared proxy, not only this app.',
      ],
      confirmLabel: 'Yes, write it',
      cancelLabel: DEFAULT_CANCEL_LABEL,
      danger: false,
    },
  });

  return actions;
}

/** The frame title while an action runs, and what it says when it is done. */
export function certificateActionTitle(action: CertificateAction): string {
  switch (action) {
    case 'dry-run':
      return 'Renewal — dry run';
    case 'renew':
      return 'Renewal';
    case 'install-cron':
      return 'Renewal cron';
  }
}

export interface RenewalOutcomeInput {
  action: CertificateAction;
  renewed: readonly string[];
  reloaded: boolean;
  /** `installRenewalCron`'s answer, for the cron action. */
  cron?: { path: string; changed: boolean } | undefined;
}

/** The sentence an action ends on — the same ones the subcommand prints. */
export function renewalOutcome(input: RenewalOutcomeInput): string {
  if (input.action === 'install-cron') {
    if (input.cron === undefined) return 'Nothing was written.';
    return `${input.cron.changed ? 'Wrote' : 'Kept'} ${input.cron.path}`;
  }
  if (input.action === 'dry-run') {
    return 'Dry run complete. Nothing was renewed or reloaded.';
  }
  if (!input.reloaded) return 'Nothing was due for renewal.';
  return `Renewed ${input.renewed.join(', ') || 'certificate(s)'} and reloaded the proxy.`;
}

/**
 * The keys this screen binds.
 *
 * A bare `r` again: the action list is a `SelectInput` and there is no text
 * field anywhere on this screen (see `update-model.ts` for the rule).
 */
export function certificatesHints(busy: boolean): string[] {
  if (busy) return ['↑↓ scroll the output', 'esc back'];
  return ['enter select', 'r refresh', 'esc back'];
}

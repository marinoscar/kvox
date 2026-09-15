import { CLI_NAME } from '../../branding.js';
import { probe } from './probe.js';
import type { Check, CheckContext, CheckResult } from './types.js';
import { contextFs, skippedByProxyFlag } from './types.js';

// =============================================================================
// The certificate, if there is one yet  (issue #177, epic #168)
// =============================================================================
//
// NONE OF THESE ARE REQUIRED, and "no certificate" is a normal PASS on a first
// install - issuing one is what install is for. They exist so a re-run reports
// a known state rather than silently reissuing, and so an expiry creeping up
// is visible before it is an outage.
//
// Under `--skip-proxy` all three answer `skip`: no proxy means no certificate
// is this CLI's concern (issue #122).
// =============================================================================

const WARN_WITHIN_DAYS = 30;

/** The command that renews on demand and, with --install-cron, keeps renewing. */
const RENEW_COMMAND = `${CLI_NAME} deploy certs renew`;

function livePath(context: CheckContext, file: string): string {
  return `${context.proxyRoot}/letsencrypt/live/${context.domain ?? ''}/${file}`;
}

/** Reads `notAfter=...` from `openssl x509 -enddate`. Exported for its test. */
export function parseNotAfter(output: string, now: Date): CheckResult {
  const match = /notAfter=(.+)/.exec(output);
  const raw = match?.[1]?.trim();

  if (raw === undefined) {
    return {
      status: 'warn',
      detail: 'could not read the certificate expiry',
      remedy: 'Check by hand: openssl x509 -enddate -noout -in <cert.pem>',
    };
  }

  const expiry = new Date(raw);
  if (Number.isNaN(expiry.getTime())) {
    return {
      status: 'warn',
      detail: `unrecognised expiry: ${raw}`,
      remedy: 'Check by hand: openssl x509 -enddate -noout -in <cert.pem>',
    };
  }

  const days = Math.floor((expiry.getTime() - now.getTime()) / 86_400_000);

  if (days < 0) {
    return {
      status: 'warn',
      detail: `expired ${-days} day(s) ago`,
      remedy: `Renew it: ${RENEW_COMMAND}. Until then the site serves an invalid certificate.`,
    };
  }
  if (days <= WARN_WITHIN_DAYS) {
    return {
      status: 'warn',
      detail: `expires in ${days} day(s)`,
      remedy: `Renew it (${RENEW_COMMAND}), and check that automatic renewal is actually running.`,
    };
  }
  return { status: 'pass', detail: `valid for ${days} more day(s)` };
}

const certificatePresent: Check = {
  id: 'certificate-present',
  title: 'Certificate',
  severity: 'recommended',
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }

    const exists = contextFs(context).exists(livePath(context, 'fullchain.pem'));
    return exists
      ? { status: 'pass', detail: `already issued for ${context.domain}` }
      : {
          // Not a failure: on a first install this is the expected state and
          // issuing one is exactly what install does next.
          status: 'pass',
          detail: `none yet for ${context.domain}; install will request one`,
        };
  },
};

const certificateValidity: Check = {
  id: 'certificate-validity',
  title: 'Certificate validity',
  severity: 'recommended',
  requires: ['certificate-present'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }

    const path = livePath(context, 'cert.pem');
    if (!contextFs(context).exists(path)) {
      return { status: 'skip', detail: 'no certificate to inspect yet' };
    }

    try {
      // Read from disk rather than by making a TLS connection, so this works
      // before the vhost is live.
      const result = await context.runCommand(
        ['openssl', 'x509', '-enddate', '-noout', '-in', path],
        { cwd: process.cwd(), timeoutMs: 15_000 },
      );
      return parseNotAfter(result.stdout, new Date());
    } catch {
      return {
        status: 'skip',
        detail: 'openssl is not available to read the expiry',
      };
    }
  },
};

/**
 * Does this file schedule a renewal? A non-comment line mentioning certbot or
 * renew is taken as yes - the shared script the target server uses is called
 * neither `certbot` nor from a package's cron file, so the match is on what
 * the line does, not on what it is named.
 */
function schedulesRenewal(contents: string): boolean {
  return contents
    .split('\n')
    .some((line) => !/^\s*#/.test(line) && /certbot|renew/i.test(line));
}

/**
 * Where an operator's renewal lives, when it does. Exported for its test.
 *
 * Every form the target server might use, in the order they are cheapest to
 * check: certbot's own timer, the CLI's own cron file (`--install-cron`, #125),
 * any file in /etc/cron.d, the system crontab, and root's crontab.
 */
export async function findRenewal(context: CheckContext): Promise<string | undefined> {
  const fs = contextFs(context);

  const timer = await probe(context, ['systemctl', 'is-enabled', 'certbot.timer'], 15_000);
  if (timer.ok) return 'certbot.timer is enabled';

  const cronDir = '/etc/cron.d';
  const ownPrefix = `${CLI_NAME}-certs-`;
  for (const entry of fs.readDir?.(cronDir) ?? []) {
    const path = `${cronDir}/${entry}`;
    if (entry.startsWith(ownPrefix)) return path;
    if (schedulesRenewal(fs.readFile?.(path) ?? '')) return path;
  }

  if (schedulesRenewal(fs.readFile?.('/etc/crontab') ?? '')) return '/etc/crontab';

  const crontab = await probe(context, ['crontab', '-l'], 15_000);
  if (crontab.ok && schedulesRenewal(crontab.stdout)) return 'crontab -l';

  return undefined;
}

const certificateRenewal: Check = {
  id: 'certificate-renewal',
  title: 'Automatic renewal',
  severity: 'recommended',
  requires: ['certificate-present'],
  async run(context) {
    const skip = skippedByProxyFlag(context);
    if (skip !== undefined) return skip;
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }
    if (!contextFs(context).exists(livePath(context, 'fullchain.pem'))) {
      return { status: 'skip', detail: 'nothing to renew yet' };
    }

    const found = await findRenewal(context);
    if (found !== undefined) return { status: 'pass', detail: found };

    return {
      status: 'warn',
      detail: 'no renewal timer or cron entry found',
      // A certificate nobody renews is a 90-day timer on an outage.
      remedy: `Install one: ${RENEW_COMMAND} --install-cron. Otherwise the site breaks 90 days from issuance with no warning.`,
    };
  },
};

export const TLS_CHECKS: readonly Check[] = [
  certificatePresent,
  certificateValidity,
  certificateRenewal,
];

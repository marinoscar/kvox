import { resolve4, resolve6 } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';

import type { Check, CheckContext, CheckResult } from './types.js';
import { skippedByProxyFlag } from './types.js';

// =============================================================================
// Does the name point here?  (issue #177, epic #168)
// =============================================================================
//
// A certificate cannot be issued for a name that does not resolve to this
// server. Finding that out during certbot's challenge means the failure
// arrives after the stack is already running AND after a failed attempt has
// spent Let's Encrypt rate-limit budget - five failures per hostname per hour,
// so an operator debugging a typo can lock themselves out for the afternoon.
// Checking first costs nothing.
//
// Both checks answer `skip` under `--skip-proxy` (no certificate will be
// requested) and under `--skip-dns` (issue #122).
// =============================================================================

function skipped(context: CheckContext): CheckResult | undefined {
  return (
    skippedByProxyFlag(context) ??
    (context.skipDns === true ? { status: 'skip', detail: '--skip-dns' } : undefined)
  );
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

/**
 * This host's own non-internal addresses.
 *
 * Local interfaces first, and an external echo service is NOT consulted as a
 * fallback: a check that needs egress to a third party is a check that fails
 * in an egress-filtered or air-gapped environment, which is exactly where
 * someone is most likely to be deploying by hand. Behind NAT, where the
 * interfaces carry a private address, the operator states the public one
 * with `--public-ip` (or its environment variable) and it counts as ours.
 * The routing proof that genuinely needs a public request is install's
 * pre-publish self-probe (#125), not a doctor check.
 */
async function defaultOwnAddresses(): Promise<string[]> {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address);
}

async function ownAddresses(context: CheckContext): Promise<string[]> {
  const detected = await (context.ownAddresses ?? defaultOwnAddresses)();
  const stated = context.publicIp?.trim();
  return stated === undefined || stated === '' ? detected : [...detected, stated];
}

const dnsResolves: Check = {
  id: 'dns-resolves',
  title: 'Domain resolves',
  severity: 'required',
  async run(context: CheckContext) {
    const skip = skipped(context);
    if (skip !== undefined) return skip;
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given (pass --domain)' };
    }

    const resolver = context.resolveHost ?? defaultResolveHost;
    const addresses = await resolver(context.domain).catch(() => []);

    return addresses.length > 0
      ? { status: 'pass', detail: addresses.join(', ') }
      : {
          status: 'fail',
          detail: `${context.domain} has no A or AAAA record`,
          remedy: `Add a DNS record for ${context.domain} pointing at this server, and wait for it to propagate.`,
        };
  },
};

const dnsPointsHere: Check = {
  id: 'dns-points-here',
  title: 'Domain points at this server',
  severity: 'required',
  requires: ['dns-resolves'],
  async run(context: CheckContext) {
    const skip = skipped(context);
    if (skip !== undefined) return skip;
    if (context.domain === undefined) {
      return { status: 'skip', detail: 'no domain given' };
    }

    const resolver = context.resolveHost ?? defaultResolveHost;
    const addresses = await resolver(context.domain).catch(() => []);
    const own = await ownAddresses(context);

    if (own.length === 0) {
      // Downgraded rather than failed: not knowing our own address is a limit
      // of this check, not evidence that DNS is wrong.
      return {
        status: 'warn',
        detail: `resolves to ${addresses.join(', ')}; this server's own address could not be determined`,
        remedy: 'Confirm by hand that the record points here before issuing a certificate, or state this server\'s public address with --public-ip.',
      };
    }

    if (addresses.some((address) => own.includes(address))) {
      return { status: 'pass', detail: addresses.join(', ') };
    }

    return {
      status: 'fail',
      // Both sides named, because behind a CDN or another proxy this is
      // expected and the operator needs to recognise their own setup.
      detail: `${context.domain} resolves to ${addresses.join(', ')}, but this server is ${own.join(', ')}`,
      remedy: `The HTTP-01 challenge is served by this host, so the record must point at it. Behind NAT, state the public address with --public-ip. If the name is deliberately behind a CDN, issue the certificate another way and re-run with --skip-proxy.`,
    };
  },
};

export const DNS_CHECKS: readonly Check[] = [dnsResolves, dnsPointsHere];

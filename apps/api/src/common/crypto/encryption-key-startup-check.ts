import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { assertEncryptionKeyConfigured } from './secret-cipher';

// =============================================================================
// SECRETS_ENCRYPTION_KEY startup validation  (issue #116, epic #108)
// =============================================================================
//
// #114 built the cipher and #115 built the store on top of it. Both fail at the
// moment of use if the key is missing or malformed, which is the failure this
// issue exists to move: a deployment that boots happily and then 500s on a
// settings page has turned a configuration error into a runtime error, and
// handed it to the wrong person. This module is the bootstrap-time check that
// puts it back in the deploy log.
//
// -----------------------------------------------------------------------------
// THE DECISION: NO DEVELOPMENT FALLBACK KEY, AND NO NODE_ENV GATE AT ALL
// -----------------------------------------------------------------------------
// #116 offered two acceptable shapes for "the variable is absent in
// development": fail identically everywhere, or fall back to a fixed,
// loudly-logged development key. This chooses the first, and goes further by
// not branching on NODE_ENV anywhere in this file. Two reasons.
//
// 1. A FIXED FALLBACK KEY IS A KEY IN A PUBLIC REPOSITORY. Whatever constant we
//    shipped would be the key protecting every secret in any deployment that
//    reached the fallback branch. The branch is only safe if "is this
//    production?" is answered correctly 100% of the time — and here it would be
//    answered by NODE_ENV, which is UNSET by default in Node, which
//    `configuration.ts` therefore defaults to 'development', and which
//    `app.module.ts` already uses to decide whether to load TestAuthModule. A
//    deployment that forgets to set it does not fail; it quietly encrypts real
//    SMTP passwords under a constant anyone can read off GitHub, and every
//    symptom of that is invisible. Trading a hard failure for a silent
//    catastrophic one is a bad trade at any convenience saving.
//
// 2. IT WOULD ALSO CORRUPT DEVELOPER DATA. Credentials written under a fallback
//    key become permanently unreadable the moment a developer sets a real key —
//    the cipher's auth tag fails, `CredentialsService.getSecret` throws, and the
//    reported cause ("the payload is corrupt or the key changed") is true but
//    baffling, because nobody remembers a key they never set.
//
// -----------------------------------------------------------------------------
// SO WHAT MAKES IT STRICT WITHOUT BREAKING EVERY EXISTING DEPLOYMENT?
// -----------------------------------------------------------------------------
// The hard constraint: this repository sets SECRETS_ENCRYPTION_KEY NOWHERE
// today — not in `infra/compose/.env.example` (#116 item 2 adds it), not in the
// compose files, not in CI. In particular the `Smoke (boot compiled API)` job
// boots `dist/main.js` with NODE_ENV=production and no such variable. A naive
// unconditional throw here would therefore red the build immediately and break
// every running deployment on its next restart — for a feature that, today, has
// no consumer at all (#109 will be the first).
//
// Strictness is gated on whether the credential store IS IN USE, which is a
// fact about the deployment rather than a claim about it:
//
//   key present  ->  validate its format. ALWAYS, in every environment. A
//                    typo'd key is unambiguously an operator error, it can
//                    never be the intended state, and catching it costs
//                    nothing because no deployment sets the variable yet.
//
//   key absent,  ->  THROW. Every one of those rows is ciphertext this process
//   rows exist       cannot read. The deployment is already broken; the only
//                    question is whether it announces that in the deploy log or
//                    waits to 500 at an admin. This is the case the issue is
//                    actually about, and it is strict in development too.
//
//   key absent,  ->  WARN and boot. Nothing is stored, so nothing is
//   no rows          unreadable, and there is no misconfiguration to report —
//                    the feature is simply not set up. Every deployment in
//                    existence right now, the smoke job included, is here.
//
// The state machine is closed rather than merely convenient, because rows
// cannot exist without a key having been configured when they were written:
// `CredentialsService.setSecret` calls `encryptSecret`, which throws without a
// valid key. So "rows exist" really does mean "a key was working here once",
// and its absence now really is a regression rather than a first-time setup.
//
// WHAT A DEVELOPER RUNNING `docker compose up` FOR THE FIRST TIME EXPERIENCES,
// which is the trade-off this accepts and is worth stating plainly: the stack
// comes up normally, with one WARN line naming the variable and giving the
// generation command. Credential storage is the only thing that does not work,
// and the first attempt to store one fails with secret-cipher's operator-facing
// error — which also names the variable and gives the command. So the cost of
// refusing a fallback key is one deferred error message, on a feature they were
// deliberately reaching for, that tells them exactly what to do. The cost of
// accepting one was a public key on production secrets. That is the trade.
//
// This is a floor, not a ceiling. Once #116 items 2-5 put the variable in
// `.env.example` and the security docs, and once #109 gives the store a real
// consumer, the "absent, no rows" branch can be tightened to a hard failure
// without stranding anyone — every path that would then break has by that point
// been told about the variable. Tightening it TODAY would only mean breaking CI
// and every deployment to protect a feature nothing uses.
// =============================================================================

/**
 * Kept as a literal rather than imported from secret-cipher, which does not
 * export it. Duplicating one string is the smaller cost: widening that module's
 * public surface for a log line invites the next caller to reach in for
 * something that actually matters.
 */
const KEY_ENV_VAR = 'SECRETS_ENCRYPTION_KEY';

/** Repeated in every operator-facing message here. Same text as #114's. */
const GENERATE_COMMAND = 'openssl rand -base64 32';

/**
 * Validate the encryption key as far as this deployment's state allows, and
 * throw if the deployment is unable to read secrets it has already stored.
 *
 * Call from bootstrap BEFORE the port is bound, so a deployment that cannot
 * read its own credentials never serves a request. See the header for the
 * full decision; the short version is that a present key is always validated
 * and an absent one is only fatal when there is something to decrypt.
 *
 * @throws if the key is set but malformed, or unset while credentials exist.
 */
export async function verifyEncryptionKeyAtStartup(
  prisma: PrismaService,
  logger: Logger,
): Promise<void> {
  // An empty value ('SECRETS_ENCRYPTION_KEY=' with nothing after it, which is
  // exactly what copying `.env.example` produces) is deliberately treated as
  // ABSENT rather than as malformed — matching `getMasterKey`, which reports
  // `!raw` as "is not set". A whitespace-only value is NOT absent: it is
  // truthy, so it takes the strict branch below and is rejected as invalid
  // base64, which is the honest reading of somebody having typed something.
  if (process.env[KEY_ENV_VAR]) {
    // Deliberately not wrapped, re-worded, or downgraded by environment.
    // secret-cipher's error already names the variable, describes the shape of
    // the failure ("decoded to 24 bytes") and gives the generation command,
    // and it is addressed to precisely the person reading a failed deploy.
    // Rewriting it here could only lose information.
    assertEncryptionKeyConfigured();

    logger.log(
      `${KEY_ENV_VAR} is configured; encrypted credential storage is available.`,
    );
    return;
  }

  let storedCredentials: number;
  try {
    storedCredentials = await prisma.credential.count();
  } catch (error) {
    // A failed probe is NOT a boot failure, and specifically is not reported as
    // an encryption-key problem.
    //
    // The realistic cause is that the `credentials` table does not exist yet —
    // a deployment running this build before `prisma migrate deploy` (Prisma
    // P2021). Refusing to boot there would mean a new release could not start
    // until migrations ran, while the migration step in some setups runs from
    // the very container being blocked. The other cause is a database that is
    // unreachable, which readiness already reports accurately and which would
    // only be obscured by a message about encryption keys sending an operator
    // to check the wrong thing.
    //
    // Failing OPEN here is safe because it cannot hide the dangerous state: if
    // credentials do exist, this same check throws on the next boot that can
    // actually see them.
    logger.warn(
      `Could not check for stored credentials while validating ${KEY_ENV_VAR} ` +
        `(the credentials table may not be migrated yet). Continuing startup. ` +
        `Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (storedCredentials > 0) {
    // Fatal in EVERY environment, development included. There is no reading of
    // this state that is intended: rows only exist because a key was working
    // here at some point, so it has since been removed or the deployment is
    // pointed at another environment's database.
    //
    // The message carries a count and never an address — `purpose`/`name` pairs
    // are low-risk but this string goes to stdout on a failed deploy, and a
    // count is all an operator needs to gauge the scale. Recovery detail
    // (re-entering credentials, which ones) belongs in the rotation runbook,
    // #116 item 5.
    throw new Error(
      `${KEY_ENV_VAR} is not set, but ${storedCredentials} encrypted credential(s) ` +
        `are stored in the database. Without the key that encrypted them they cannot ` +
        `be read, so this deployment would fail at the point of use rather than here. ` +
        `Restore the original key, or — if it is genuinely lost — delete the affected ` +
        `credentials and have an administrator enter them again under a new key ` +
        `generated with: ${GENERATE_COMMAND}`,
    );
  }

  // The state every deployment of this repository is in right now.
  //
  // WARN and not ERROR: nothing is wrong. No credential is stored, so none is
  // unreadable, and a feature that is not configured is not a fault. Logging
  // this at `error` would train operators to ignore errors from a boot that
  // then works perfectly, which is how a real one gets scrolled past.
  logger.warn(
    `${KEY_ENV_VAR} is not set. Encrypted credential storage is unavailable and ` +
      `saving a credential will fail until it is configured. No credentials are ` +
      `currently stored, so nothing is at risk. Generate a key with: ${GENERATE_COMMAND}`,
  );
}

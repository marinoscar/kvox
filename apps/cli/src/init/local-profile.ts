import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  metadataFor,
  type DeriveContext,
  type EnvVarMetadata,
} from '../deploy/env-metadata.js';
import type { EnvVarSpec } from '../deploy/env-spec.js';

// =============================================================================
// The LOCAL profile  (issue #344, epic #341)
// =============================================================================
//
// `deploy install` and `init` ask the same question - "what belongs in
// infra/compose/.env?" - about two different machines. Everything that answers
// it is already written and is REUSED WHOLE: `parseEnvExample` produces the
// question list, `runEnvWizard` drives it, `generateBase64Key` makes the
// secrets, `serializeEnvFile` writes the file. This module is only the
// DIFFERENCE between the two machines, and it is deliberately about a page
// long, because that difference is genuinely small:
//
//   - NODE_ENV is not forced to production. A checkout is a development
//     environment; that is the entire point of it.
//   - APP_URL is not derived from a public domain. There isn't one. The
//     template's own default (http://localhost:3535) is already the right
//     answer, which is why this file does not restate it.
//   - The OAuth callback is still DERIVED rather than asked - from APP_URL
//     instead of from a domain. The deploy path's reason holds unchanged
//     locally: a callback that disagrees with APP_URL is the single most
//     common way a hand-written .env fails, and both restate a fact the
//     operator has already stated.
//   - Google credentials and the admin address may be EMPTY here. On a VPS
//     they cannot: a deployment nobody can log into is not a deployment. In a
//     fresh clone "I have not created the OAuth client yet" is a real, normal
//     state, and refusing to write a file over it just leaves the person with
//     no .env at all.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO is re-specify defaults.
// `.env.example` is the specification (see env-spec.ts's header), so every
// value not named below - ports, token lifetimes, job queue tuning, storage
// limits - comes from the template, and a fork that adds a variable gets it
// here for free.
// =============================================================================

/** Where the template and the file it generates live, relative to the root. */
export const ENV_TEMPLATE_RELATIVE_PATH = join('infra', 'compose', '.env.example');
export const ENV_FILE_RELATIVE_PATH = join('infra', 'compose', '.env');

/**
 * Walks up from `startDir` looking for the environment template.
 *
 * ANCHORED ON `.env.example`, NOT ON `.git` OR `package.json`. It is the file
 * this command actually needs, so finding it IS the precondition; a checkout
 * exported without its git directory, or a nested workspace with its own
 * package.json, would both defeat the other two anchors.
 */
export function findRepoRoot(startDir: string): string | undefined {
  let current = resolve(startDir);

  for (;;) {
    if (existsSync(join(current, ENV_TEMPLATE_RELATIVE_PATH))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Generated with the CSPRNG, never put to anybody.
 *
 * Asking a human to invent a 32-byte key produces one of two things: a value
 * pasted from another system, or `openssl rand -base64 32` run in a second
 * terminal - which is precisely the manual step this command exists to remove.
 */
export const GENERATED_KEYS: readonly string[] = [
  'JWT_SECRET',
  'COOKIE_SECRET',
  'SECRETS_ENCRYPTION_KEY',
];

/**
 * The only keys a person is asked about, because nothing can work them out.
 *
 * Note what is NOT here: everything with a usable template default. Eight
 * questions is a setup; thirty-four is a form, and a form is something people
 * click through - the same argument env-wizard.ts's header makes for deploy.
 */
export const PROMPTED_KEYS: readonly string[] = [
  'INITIAL_ADMIN_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
];

/** Keys an unfinished setup may legitimately leave empty. */
export const BLANK_OK_KEYS: readonly string[] = [
  'INITIAL_ADMIN_EMAIL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

/**
 * Keys the application cannot actually run without, in the order they bite.
 *
 * GOOGLE_CLIENT_ID is first because its absence is not a degraded feature: the
 * API does not boot at all. Passport's OAuth2Strategy throws "OAuth2Strategy
 * requires a clientID option" while Nest is still wiring modules, so the
 * container exits before it ever serves a request. That fact is currently
 * recorded in a comment in .github/workflows/ci.yml and nowhere a person
 * setting the project up would look, which is why `init` says it out loud.
 */
export const REQUIRED_TO_RUN: readonly string[] = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'INITIAL_ADMIN_EMAIL',
];

/**
 * The compose service name the database answers to, and the default offered
 * for POSTGRES_HOST.
 *
 * THE ONE TEMPLATE DEFAULT THIS PROFILE OVERRIDES, and the reason is that the
 * template's `localhost` is right for exactly one of the two readers of this
 * file and wrong for the other. base.compose.yml passes POSTGRES_HOST into the
 * api CONTAINER (falling back to `db` when .env omits it), and inside that
 * container `localhost` is the container itself - so accepting every default
 * would produce a stack that cannot reach its own database, which is the one
 * outcome this command exists to prevent.
 *
 * The cost is stated in the prompt's help and in the next steps: host-side
 * tooling (`prisma:migrate` run from the checkout) resolves this name too, and
 * cannot resolve `db`. Somebody pointing at a PostgreSQL on their own machine
 * answers `localhost` and gets the host-side commands instead.
 */
export const COMPOSE_DB_HOST = 'db';

/** True when this host name only means anything inside the compose network. */
export function isComposeInternalHost(host: string | undefined): boolean {
  return host !== undefined && host !== '' && !/^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(host);
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value === '';
}

/** `<APP_URL>/api/auth/<provider>/callback`, with any trailing slash removed. */
export function callbackUrlFor(
  appUrl: string | undefined,
  provider: string,
): string | undefined {
  if (isBlank(appUrl)) return undefined;
  return `${(appUrl as string).replace(/\/+$/, '')}/api/auth/${provider}/callback`;
}

/**
 * Local derivations, keyed on the ANSWERS rather than on a domain.
 *
 * APP_URL is resolved before either of these, because `.env.example` presents
 * the Application section before the OAuth ones and the wizard walks the
 * template in file order - the same ordering guarantee the deploy path's
 * derivations already rely on.
 */
const LOCAL_DERIVATIONS: Readonly<
  Record<string, (context: DeriveContext) => string | undefined>
> = {
  GOOGLE_CALLBACK_URL: ({ answers }) => callbackUrlFor(answers.get('APP_URL'), 'google'),
  // Only once somebody has actually configured Microsoft. Returning undefined
  // leaves the key exactly as the template has it - commented out - rather
  // than writing a callback for a provider this deployment does not use.
  MICROSOFT_CALLBACK_URL: ({ answers }) =>
    isBlank(answers.get('MICROSOFT_CLIENT_ID'))
      ? undefined
      : callbackUrlFor(answers.get('APP_URL'), 'microsoft'),
};

/**
 * The local annotation for one key.
 *
 * Built FROM `metadataFor`, not beside it. `secret`, `validate`, `generate`,
 * `never` and `group` are facts about the variable itself and are identical on
 * both machines - a password is a password, and TEST_AUTH_ENABLED is still
 * never written. Only the four members that encode "this is a public VPS"
 * (`fixed`, the domain-based `derive`, and which keys are `essential`) are
 * replaced. Keeping the shared half means a fork that annotates a new variable
 * gets it in both profiles at once.
 */
export function localMetadataFor(key: string): EnvVarMetadata {
  const base = metadataFor(key);
  const local: EnvVarMetadata = {};

  if (base.never === true) local.never = true;
  if (base.secret === true) local.secret = true;
  if (base.generate !== undefined) local.generate = base.generate;
  if (base.validate !== undefined) local.validate = base.validate;
  // Groups stay opt-in exactly as they are on a VPS: the observability and
  // storage stacks are separate compose overlays, so their variables belong to
  // whoever turns those on. Skipping them also keeps their several secret keys
  // out of the question list, which is what keeps this to eight prompts.
  if (base.group !== undefined) local.group = base.group;

  const derive = LOCAL_DERIVATIONS[key];
  if (derive !== undefined) local.derive = derive;
  if (PROMPTED_KEYS.includes(key)) local.essential = true;
  if (BLANK_OK_KEYS.includes(key)) local.allowBlank = true;

  return local;
}

/**
 * Per-key adjustments to the parsed template, applied before the wizard runs.
 *
 * Two kinds, both about what pressing Enter should mean:
 *
 *   - A PLACEHOLDER is not a default. `your-google-client-id` fails the shared
 *     `rejectPlaceholder` validator, so leaving it as the fallback would trap
 *     somebody on a question whose offered answer is refused. Empty is the
 *     honest default for a credential that does not exist yet.
 *   - `.env.example`'s help is written for a person copying the file by hand.
 *     Where a prompt needs to say more than that, it is said here, next to the
 *     reason - never by editing `.env.example`, which is a validated file that
 *     both this CLI and Docker Compose read.
 */
const SPEC_OVERRIDES: Readonly<
  Record<string, { defaultValue?: string; help?: string }>
> = {
  POSTGRES_HOST: {
    defaultValue: COMPOSE_DB_HOST,
    help: [
      'Where PostgreSQL is, as the API sees it.',
      '',
      `  ${COMPOSE_DB_HOST}         the database container (add -f devdb.compose.yml when you`,
      '             bring the stack up). The right answer if you have no',
      '             PostgreSQL of your own.',
      '  localhost  a PostgreSQL already running on this machine.',
      '',
      'This name is also what `prisma:migrate` uses. A compose service name',
      `resolves only inside the stack, so with ${COMPOSE_DB_HOST} the migration runs in the`,
      'api container; with localhost it runs from this checkout.',
    ].join('\n'),
  },
  POSTGRES_PASSWORD: {
    help: [
      'The database password.',
      '',
      'Press Enter to accept the development default (postgres), which is',
      'also what the devdb.compose.yml container is created with.',
    ].join('\n'),
  },
  GOOGLE_CLIENT_ID: {
    defaultValue: '',
    help: [
      'REQUIRED to run the application. The API does not start without it:',
      'Passport throws "OAuth2Strategy requires a clientID option" during',
      'bootstrap, so the container exits before serving anything.',
      '',
      'Create one at https://console.cloud.google.com/apis/credentials, with',
      'the callback URL shown at the end of this run as an authorised',
      'redirect URI. You may leave it empty now and fill it in later.',
    ].join('\n'),
  },
  GOOGLE_CLIENT_SECRET: { defaultValue: '' },
  INITIAL_ADMIN_EMAIL: {
    defaultValue: '',
    help: [
      'The Google account that becomes the first Admin.',
      '',
      'The seed writes it to the allowlist, and the first login matching it',
      'claims the Admin role. Every other address is refused by the allowlist,',
      'so with this empty NOBODY can log in - not even you.',
    ].join('\n'),
  },
};

/** Applies those adjustments, leaving every other spec exactly as parsed. */
export function localSpecs(specs: readonly EnvVarSpec[]): EnvVarSpec[] {
  return specs.map((spec) => {
    const override = SPEC_OVERRIDES[spec.key];
    if (override === undefined) return spec;

    return {
      ...spec,
      ...(override.defaultValue === undefined ? {} : { defaultValue: override.defaultValue }),
      ...(override.help === undefined ? {} : { help: override.help }),
    };
  });
}

/**
 * The answers an unattended run gives to the questions it cannot ask.
 *
 * The wizard refuses, by design, to let an ESSENTIAL key fall back to its
 * template default when nobody is there to confirm it - `deploy install`
 * silently shipping `POSTGRES_PASSWORD=postgres` to a public server is exactly
 * the accident that rule prevents. Locally those defaults ARE the intended
 * answers, so this supplies them as answers rather than weakening the rule.
 *
 * Only keys with a usable default appear. The three in BLANK_OK_KEYS have
 * none, and stay empty through `allowBlank`.
 */
export function unattendedLocalAnswers(specs: readonly EnvVarSpec[]): Map<string, string> {
  const answers = new Map<string, string>();

  for (const spec of localSpecs(specs)) {
    if (!PROMPTED_KEYS.includes(spec.key)) continue;
    if (BLANK_OK_KEYS.includes(spec.key)) continue;
    if (spec.defaultValue === '') continue;
    answers.set(spec.key, spec.defaultValue);
  }

  return answers;
}

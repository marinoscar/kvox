import {
  probeTcp as defaultProbeTcp,
  runChecks as defaultRunChecks,
  type Check,
  type CheckContext,
  type CompletedCheck,
} from '../checks/index.js';
import { metadataFor, type EnvGroup, type EnvVarMetadata } from '../env-metadata.js';
import type { EnvVarSpec } from '../env-spec.js';
import type { ServerFacts } from '../server-facts.js';

// =============================================================================
// The wizard as data  (issue #127, epic #118)
// =============================================================================
//
// One ordered list of steps, each naming the .env.example keys it asks, the
// text it opens with, and the doctor checks it runs before letting the
// operator move on. The readline path (env-wizard.ts) and the ink screens
// (#131) both RENDER this list; neither owns a question of its own. That is
// decision 10 of #118, and the reason is the two-lists problem checks/ was
// built to avoid: a TUI-only wizard would drift from --non-interactive the
// first time somebody added a field to one and not the other.
//
// WHAT A STEP DOES NOT SAY. A field is a KEY, nothing more; whether it is
// secret, how it is validated, whether it is generated, derived or suggested
// all come from env-metadata.ts, exactly as before. A fork that adds a key
// with no entry here still gets it asked - it lands in the `optional` step -
// so .env.example remains the question list and this file only orders it.
//
// NO DATABASE HOSTNAME IS EVER PRE-FILLED. The database step lists the keys;
// it offers nothing for POSTGRES_HOST (decision 2 of #118). What it does
// instead is VERIFY: the four database checks run against the typed values
// before the next question, so a wrong password is found now and not after
// fifteen more answers.
// =============================================================================

/** The pseudo-key for the public hostname, which is not an .env.example key. */
export const DOMAIN_FIELD = '__domain';

/** An .env.example key, or `DOMAIN_FIELD`. */
export type FieldRef = string;

export type MetadataResolver = (key: string) => EnvVarMetadata;

/** What the wizard knows when a step opens or closes. */
export interface WizardStepContext {
  /** Given up front, or answered in the `domain` step; undefined before then. */
  domain: string | undefined;
  /** Every value resolved so far - answers, defaults, derivations. */
  answers: ReadonlyMap<string, string>;
  facts: ServerFacts;
}

/**
 * Everything a check needs that is not an answer. `domain` and `env` are
 * deliberately excluded: the wizard fills those from the step's own answers,
 * which is the whole point of checking inline.
 */
export type StepCheckBase = Omit<CheckContext, 'domain' | 'env'>;

/** What `onLeave` receives. Every probe is injectable so no test hits the network. */
export interface StepCheckContext extends WizardStepContext {
  /** The registry the step's check ids are looked up in. */
  checks: readonly Check[];
  runChecks: typeof defaultRunChecks;
  probeTcp: typeof defaultProbeTcp;
  /** Injectable so a probe can be driven in a test without a network. */
  fetchImpl?: typeof fetch | undefined;
  base: StepCheckBase;
}

export interface FieldInput {
  specs: readonly EnvVarSpec[];
  resolve: MetadataResolver;
  groups: readonly EnvGroup[];
  /** Keys an earlier step already claimed. */
  claimed: ReadonlySet<string>;
}

export interface WizardStep {
  id: string;
  title: string;
  /** Lines printed (or rendered) before the first field. */
  intro: (context: WizardStepContext) => readonly string[];
  /** The keys this step owns, in the order they are asked. */
  fields: (input: FieldInput) => FieldRef[];
  /** Registry ids this step verifies on leaving; `onLeave` runs them. */
  checkIds?: readonly string[] | undefined;
  /** Runs after the step's fields are answered. A `fail` re-enters the step. */
  onLeave?: ((context: StepCheckContext) => Promise<CompletedCheck[]>) | undefined;
  /** Every field is optional: a blank answer skips the key rather than writing it. */
  optional?: boolean | undefined;
}

export const STORAGE_CHECK_ID = 'storage-reachable';
export const GOOGLE_OAUTH_CHECK_ID = 'google-oauth-credentials';

/**
 * What every Google OAuth client id contains, and what a REAL one ends with.
 *
 * Two constants, not one, because they answer different questions. The infix
 * is the discriminator: nobody pastes `apps.googleusercontent` by accident, so
 * a value without it is certainly the wrong field (a project id, an API key).
 * The `.com` suffix is what makes it a client id Google could actually know
 * about — a placeholder on a reserved TLD (RFC 2606 `.invalid`, `.test`) is
 * well-formed and deliberately not real, which is exactly what an unattended
 * install fixture wants.
 */
const GOOGLE_CLIENT_ID_INFIX = '.apps.googleusercontent.';
const GOOGLE_CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Same rule the TUI applied: a bare hostname, nothing else. */
export function validateDomain(value: string): string | undefined {
  if (value === '') return 'is required';
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(value)
    ? undefined
    : 'must be a hostname (no scheme, path or port)';
}

/** The URL the OAuth client must be registered with, once the domain is known. */
export function googleRedirectUri(context: WizardStepContext): string | undefined {
  const appUrl = appUrlFor(context);
  return appUrl === undefined ? undefined : `${appUrl}/api/auth/google/callback`;
}

function appUrlFor(context: WizardStepContext): string | undefined {
  const answered = context.answers.get('APP_URL');
  if (answered !== undefined && answered !== '') return answered.replace(/\/+$/, '');
  return context.domain === undefined || context.domain === ''
    ? undefined
    : `https://${context.domain}`;
}

/** Only the keys the template actually has, in the order given here. */
function present(keys: readonly string[]): (input: FieldInput) => FieldRef[] {
  return ({ specs }) => {
    const known = new Set(specs.map((spec) => spec.key));
    return keys.filter((key) => known.has(key));
  };
}

/**
 * Runs the named registry checks with a context built from the answers so
 * far. The typed APP_BIND_PORT outranks the base context's port, because the
 * base was decided before the operator answered.
 */
export async function runStepChecks(
  ids: readonly string[],
  context: StepCheckContext,
): Promise<CompletedCheck[]> {
  const selected = ids.flatMap((id) => {
    const check = context.checks.find((candidate) => candidate.id === id);
    return check === undefined ? [] : [check];
  });
  if (selected.length === 0) return [];

  const typedPort = Number(context.answers.get('APP_BIND_PORT'));
  const checkContext: CheckContext = {
    ...context.base,
    ...(context.domain === undefined ? {} : { domain: context.domain }),
    env: context.answers,
    ...(Number.isInteger(typedPort) && typedPort > 0 ? { bindPort: typedPort } : {}),
  };

  return await context.runChecks(selected, checkContext);
}

function registryStep(ids: readonly string[]): Pick<WizardStep, 'checkIds' | 'onLeave'> {
  return { checkIds: ids, onLeave: (context) => runStepChecks(ids, context) };
}

function formatFacts(facts: ServerFacts): string | undefined {
  const parts: string[] = [];
  if (facts.cpus !== null) parts.push(`${facts.cpus} CPU${facts.cpus === 1 ? '' : 's'}`);
  if (facts.memoryBytes !== null) {
    parts.push(`${Math.round((facts.memoryBytes / (1024 * 1024 * 1024)) * 10) / 10} GiB RAM`);
  }
  return parts.length === 0 ? undefined : parts.join(', ');
}

/**
 * A best-effort, warn-only reachability probe of the object store: a TCP
 * connect to the endpoint, or to the bucket's AWS host when no endpoint is
 * set. Warn rather than fail because the bucket may be reachable only once
 * a firewall rule is added later, and a check that blocks the install on a
 * guess is a check people learn to skip.
 */
async function storageReachable(context: StepCheckContext): Promise<CompletedCheck[]> {
  const bucket = context.answers.get('S3_BUCKET') ?? '';
  if (bucket === '' || /^your-/i.test(bucket)) return [];

  const started = Date.now();
  const endpoint = context.answers.get('S3_ENDPOINT') ?? '';
  const region = context.answers.get('S3_REGION') || 'us-east-1';

  let host: string;
  let port: number;
  if (endpoint === '') {
    host = `${bucket}.s3.${region}.amazonaws.com`;
    port = 443;
  } else {
    try {
      const url = new URL(endpoint);
      host = url.hostname;
      port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
    } catch {
      return [
        {
          id: STORAGE_CHECK_ID,
          title: 'Object storage reachable',
          severity: 'recommended',
          status: 'warn',
          detail: `S3_ENDPOINT is not a URL: ${endpoint}`,
          remedy: 'Set S3_ENDPOINT to the full origin, such as https://minio.internal:9000.',
          durationMs: Date.now() - started,
        },
      ];
    }
  }

  const { ok, reason } = await context.probeTcp(host, port);
  return [
    {
      id: STORAGE_CHECK_ID,
      title: 'Object storage reachable',
      severity: 'recommended',
      status: ok ? 'pass' : 'warn',
      detail: ok ? `${host}:${port}` : `no connection to ${host}:${port} (${reason ?? 'unknown'})`,
      ...(ok
        ? {}
        : {
            remedy:
              'Uploads will fail until the bucket is reachable from this server. Check S3_ENDPOINT, S3_REGION and any egress firewall.',
          }),
      durationMs: Date.now() - started,
    },
  ];
}

/**
 * Verifies the Google OAuth credentials, and is honest about the half it
 * cannot verify (issue #231).
 *
 * This was the only credential-collecting step in the wizard that tested
 * nothing, so a typo in the client id or a secret pasted from the wrong Google
 * Cloud project was accepted in silence and surfaced much later — after the
 * build, the migration and the certificate — as a failed login on a deployment
 * that otherwise looked healthy.
 *
 * THE DISCRIMINATOR. Presenting the pair to Google's token endpoint with a
 * deliberately bogus authorization code separates the two answers that matter:
 *
 *   - `invalid_client` — the client id/secret pair is not real. Certain.
 *   - `invalid_grant`  — the pair IS real; Google got far enough to reject the
 *                        code instead. That is the pass.
 *
 * This is the same shape as `POST /api/ai-settings/test`, where a 401 counts
 * as success because it proves the endpoint exists.
 *
 * WHAT IT DOES NOT CLAIM. A client secret cannot be fully exercised without a
 * browser round-trip through the consent screen, and whether the redirect URI
 * is registered on the client is not readable through any endpoint available
 * here. A pass says the credentials are a real pair, not that login will work,
 * and the detail line says so rather than implying otherwise.
 *
 * FAILURE POSTURE. A malformed client id is a hard failure — it is certainly
 * wrong. Anything that only proves we could not reach Google is a WARNING, for
 * `storageReachable`'s reason exactly: an operator on a restricted network must
 * still be able to install, and a check that blocks on a guess is one people
 * learn to skip.
 */
async function googleOauthVerified(context: StepCheckContext): Promise<CompletedCheck[]> {
  const clientId = (context.answers.get('GOOGLE_CLIENT_ID') ?? '').trim();
  const clientSecret = (context.answers.get('GOOGLE_CLIENT_SECRET') ?? '').trim();
  const started = Date.now();

  // Nothing typed yet: required-ness is the field validator's job, not this
  // probe's, and answering here would double-report the same empty field.
  if (clientId === '') return [];

  const base = {
    id: GOOGLE_OAUTH_CHECK_ID,
    title: 'Google OAuth credentials',
    severity: 'required' as const,
  };

  if (!clientId.includes(GOOGLE_CLIENT_ID_INFIX)) {
    return [
      {
        ...base,
        status: 'fail',
        detail: `GOOGLE_CLIENT_ID does not contain ${GOOGLE_CLIENT_ID_INFIX}`,
        remedy: `A Google OAuth client id looks like 1234567890-abc123.apps.googleusercontent.com. Copy it from the client's own page in Google Cloud console, not the project id or the API key.`,
        durationMs: Date.now() - started,
      },
    ];
  }

  // Well formed, but on a reserved TLD: it CANNOT be a client Google knows
  // about, so there is nothing to verify and asking would mean sending a
  // credential to a third party for a value that is not real. Warn rather than
  // fail — this is what an unattended install fixture deliberately looks like
  // (`.github/e2e/answers.env` uses RFC 2606 `.invalid` on purpose), and
  // failing it would block every such install on a value nobody got wrong.
  if (!clientId.endsWith(GOOGLE_CLIENT_ID_SUFFIX)) {
    return [
      {
        ...base,
        status: 'warn',
        detail: `client id is well formed but not on ${GOOGLE_CLIENT_ID_SUFFIX}, so nothing was verified against Google`,
        remedy:
          'A real Google OAuth client id ends .apps.googleusercontent.com. If this is a deliberate placeholder, no action is needed — Google sign-in will not work in this deployment.',
        durationMs: Date.now() - started,
      },
    ];
  }

  if (clientSecret === '') {
    return [
      {
        ...base,
        status: 'warn',
        detail: 'client id looks right; no secret given, so the pair was not verified',
        remedy: 'Enter GOOGLE_CLIENT_SECRET to have the pair checked against Google.',
        durationMs: Date.now() - started,
      },
    ];
  }

  const redirectUri = googleRedirectUri(context) ?? '';
  const doFetch = context.fetchImpl ?? globalThis.fetch;

  let payload: { error?: unknown; error_description?: unknown };
  try {
    const response = await doFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        // Deliberately not a real code: we are asking Google to tell us WHICH
        // thing it objects to, and it checks the client before the code.
        code: 'deploy-credential-probe',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    return [
      {
        ...base,
        status: 'warn',
        detail: `could not reach Google to verify (${formatProbeError(error)})`,
        remedy:
          'The credentials were not checked. Egress to oauth2.googleapis.com is blocked or unavailable; the install can continue.',
        durationMs: Date.now() - started,
      },
    ];
  }

  const code = typeof payload.error === 'string' ? payload.error : '';

  if (code === 'invalid_client') {
    return [
      {
        ...base,
        status: 'fail',
        detail: 'Google rejected this client id and secret as a pair (invalid_client)',
        remedy:
          'Re-copy both from the same OAuth client in Google Cloud console. A secret from a different client, or a rotated one, fails exactly this way.',
        durationMs: Date.now() - started,
      },
    ];
  }

  // `invalid_grant` is the expected answer for a real pair and a bogus code.
  // Anything else unrecognised also got past the client check, so it is
  // evidence the pair exists - but say which, rather than claiming more.
  const detail =
    code === 'invalid_grant'
      ? 'client id and secret are a real pair'
      : `client id and secret accepted (Google answered ${code === '' ? 'no error' : code})`;

  return [
    {
      ...base,
      status: 'pass',
      detail: `${detail}; redirect URI registration cannot be checked from here`,
      ...(redirectUri === ''
        ? {}
        : {
            remedy: `Confirm ${redirectUri} is registered on this client before the first login.`,
          }),
      durationMs: Date.now() - started,
    },
  ];
}

/** The message shape the probe reports for a thrown fetch failure. */
function formatProbeError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : 'unknown error';
}

/**
 * The install wizard, in order. `review` asks nothing; it is where the
 * renderer shows the summary and asks for confirmation.
 */
export const INSTALL_WIZARD_STEPS: readonly WizardStep[] = [
  {
    id: 'domain',
    title: 'Domain',
    intro: () => [
      'The public hostname this deployment is served on. APP_URL and the OAuth',
      'callback are derived from it, and the DNS record is checked before moving on.',
    ],
    fields: (input) => [DOMAIN_FIELD, ...present(['APP_URL'])(input)],
    ...registryStep(['dns-resolves', 'dns-points-here']),
  },
  {
    id: 'database',
    title: 'Database',
    intro: () => [
      'This application has no PostgreSQL of its own: point it at an existing server.',
      'Nothing is pre-filled for the host. The connection, the credentials, the',
      'database and its privileges are verified before the next question.',
    ],
    fields: present([
      'POSTGRES_HOST',
      'POSTGRES_PORT',
      'POSTGRES_USER',
      'POSTGRES_PASSWORD',
      'POSTGRES_DB',
      'POSTGRES_SSL',
    ]),
    ...registryStep([
      'database-reachable',
      'database-credentials',
      'database-exists',
      'database-privileges',
    ]),
  },
  {
    id: 'secrets',
    title: 'Secrets',
    intro: () => [
      'Session and encryption secrets. Generated with the CSPRNG unless you paste',
      'your own; shown masked everywhere.',
    ],
    fields: present(['JWT_SECRET', 'COOKIE_SECRET', 'SECRETS_ENCRYPTION_KEY']),
  },
  {
    id: 'oauth',
    title: 'Google OAuth',
    intro: (context) => {
      const redirect = googleRedirectUri(context);
      const appUrl = appUrlFor(context);
      return [
        'Create an OAuth client at https://console.cloud.google.com/apis/credentials',
        'and register EXACTLY this redirect URI on it:',
        '',
        `    ${redirect ?? '(the domain is not known yet)'}`,
        '',
        ...(appUrl === undefined ? [] : [`APP_URL will be ${appUrl}.`]),
      ];
    },
    fields: present(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALLBACK_URL']),
    onLeave: googleOauthVerified,
  },
  {
    id: 'admin',
    title: 'Administrator',
    intro: () => [
      'The first account to sign in with this address claims the Admin role. It is',
      "also the certificate registration address unless --email says otherwise.",
    ],
    fields: present(['INITIAL_ADMIN_EMAIL']),
  },
  {
    id: 'storage',
    title: 'Object storage',
    intro: () => [
      'S3-compatible object storage for uploads. Optional: leave a field blank to',
      'skip it. Reachability is probed, but only as a warning.',
    ],
    fields: ({ specs, resolve, groups, claimed }) =>
      groups.includes('storage')
        ? specs
            .filter((spec) => resolve(spec.key).group === 'storage' && !claimed.has(spec.key))
            .map((spec) => spec.key)
        : [],
    onLeave: storageReachable,
    optional: true,
  },
  {
    id: 'resources',
    title: 'Resources',
    intro: (context) => {
      const seen = formatFacts(context.facts);
      return [
        'The loopback port the shared proxy forwards to, the job worker slots and the',
        'container memory limits. Each is measured from this server and applied with',
        'its reason; pass --answer, or --all to review them, to decide one yourself.',
        ...(seen === undefined ? [] : [`This server: ${seen}.`]),
      ];
    },
    fields: present(['APP_BIND_PORT', 'JOBS_WORKER_CONCURRENCY', 'API_MEM_LIMIT', 'WEB_MEM_LIMIT']),
  },
  {
    id: 'optional',
    title: 'Everything else',
    intro: () => [
      'Every remaining variable. Enter keeps the value shown; a blank answer to an',
      'optional variable leaves it out.',
    ],
    // Whatever no earlier step claimed, in template order - including a
    // fork's own keys, which is what keeps .env.example the question list.
    fields: ({ specs, claimed }) =>
      specs.filter((spec) => !claimed.has(spec.key)).map((spec) => spec.key),
    optional: true,
  },
  {
    id: 'review',
    title: 'Review',
    intro: () => [],
    fields: () => [],
  },
];

export interface ResolvedStep {
  step: WizardStep;
  fields: FieldRef[];
}

/**
 * Binds the steps to a parsed template: each step's concrete key list, with
 * every key appearing in exactly one step (the first that names it).
 */
export function resolveSteps(
  steps: readonly WizardStep[],
  specs: readonly EnvVarSpec[],
  options: { resolve?: MetadataResolver | undefined; groups?: readonly EnvGroup[] | undefined } = {},
): ResolvedStep[] {
  const resolve = options.resolve ?? metadataFor;
  const groups = options.groups ?? [];
  const claimed = new Set<string>();
  const resolved: ResolvedStep[] = [];

  for (const step of steps) {
    const fields = step
      .fields({ specs, resolve, groups, claimed })
      .filter((field) => !claimed.has(field));
    for (const field of fields) claimed.add(field);
    resolved.push({ step, fields });
  }

  return resolved;
}

/** What a renderer needs to put one field on screen. */
export interface WizardField {
  key: string;
  label: string;
  help: string;
  placeholder: string;
  secret: boolean;
  validate?: ((value: string) => string | undefined) | undefined;
}

/**
 * The essential questions, in step order, as fields a screen can render.
 *
 * Same selection the TUI made before this file existed - the domain, then
 * every essential key that is not fixed, derived or opt-in - but ORDERED BY
 * THE STEPS rather than by the template, so the two renderers agree.
 */
export function essentialFields(
  specs: readonly EnvVarSpec[],
  resolve: MetadataResolver = metadataFor,
): WizardField[] {
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const fields: WizardField[] = [];

  for (const { fields: refs } of resolveSteps(INSTALL_WIZARD_STEPS, specs, { resolve })) {
    for (const ref of refs) {
      if (ref === DOMAIN_FIELD) {
        fields.push({
          key: DOMAIN_FIELD,
          label: 'Domain',
          help: 'The public hostname this will be served on. APP_URL and the OAuth callback are derived from it.',
          placeholder: 'app.example.com',
          secret: false,
          validate: validateDomain,
        });
        continue;
      }

      const spec = byKey.get(ref);
      if (spec === undefined) continue;
      const metadata = resolve(spec.key);
      if (metadata.never === true || metadata.fixed !== undefined) continue;
      if (metadata.derive !== undefined) continue;
      if (metadata.group !== undefined) continue;
      if (metadata.essential !== true) continue;

      fields.push({
        key: spec.key,
        label: spec.key,
        help: [spec.help, metadata.help ?? ''].filter((text) => text !== '').join('\n'),
        placeholder: spec.defaultValue,
        secret: metadata.secret === true,
        ...(metadata.validate === undefined ? {} : { validate: metadata.validate }),
      });
    }
  }

  return fields;
}

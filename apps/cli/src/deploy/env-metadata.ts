import { randomBytes } from 'node:crypto';

import { isLoopbackPortFree } from './checks/types.js';
import { DEFAULT_BIND_PORT, type SiblingPort } from './layout.js';
import type { ServerFacts } from './server-facts.js';

// =============================================================================
// The handful of keys that need more than their template default
// =============================================================================
// (issue #174, epic #168)
//
// env-spec.ts gets the QUESTION out of .env.example. This gets the GOOD
// question, for the minority of keys where the difference matters: mask it,
// generate it, validate it, compute it, or never ask at all.
//
// THIS REGISTRY IS DELIBERATELY SMALL AND DELIBERATELY NOT EXHAUSTIVE. A key
// with no entry still works - not secret, not essential, template default,
// help text from the parsed comments. That fallback IS the template-safety
// property: a fork that adds SENTRY_DSN gets a usable prompt without touching
// this file. Adding an entry per variable would quietly undo that, because the
// next fork's variables would be the ones without entries.
// =============================================================================

/** Groups an operator opts into. Their keys are skipped otherwise. */
export type EnvGroup = 'observability' | 'storage';

export interface DeriveContext {
  /** The public hostname the deployment is being published under. */
  domain: string;
  /** Answers collected so far, in prompt order. */
  answers: ReadonlyMap<string, string>;
  /**
   * What kind of server this is (#127): CPUs, RAM, and so on, as read by
   * server-facts.ts. Every field is null when nothing could be read, and a
   * suggestion that needs an unknown fact answers undefined.
   */
  facts: ServerFacts;
  /**
   * The bind port every OTHER app under the apps root has recorded, from
   * their state files (`siblingBindPorts`). A stopped app is invisible to a
   * bind probe, so the port scan must consult these as well.
   */
  siblingPorts: readonly SiblingPort[];
  /** Loopback bind probe; injected so the port suggestion is testable. */
  portFree?: ((port: number) => Promise<boolean>) | undefined;
}

/**
 * A server-derived default (#127). Differs from a `derive` in exactly one
 * way: it is ALWAYS shown, with its reason, and always editable - an
 * operator who never saw "3536 because 3535 is used by demo" would publish a
 * vhost to the wrong port and never know why.
 */
export interface Suggestion {
  value: string;
  /** One clause, shown beside the value: "4 CPUs detected". */
  reason: string;
}

export interface EnvVarMetadata {
  /** Never echoed, never logged, never rendered into a frame. */
  secret?: boolean;
  /** Asked even when the template supplies a default. */
  essential?: boolean;
  /**
   * In an UNATTENDED run, the template default is an acceptable answer for
   * this essential key. Essential keys otherwise refuse the template default
   * without a terminal, because `POSTGRES_PASSWORD=postgres` is a placeholder
   * nobody chose; `POSTGRES_SSL=false` is a real setting somebody did.
   */
  defaultAcceptable?: boolean;
  /** Offer to generate a value rather than make someone invent one. */
  generate?: 'base64-32';
  /** Returns a message when the value is unusable, undefined when it is fine. */
  validate?: (value: string) => string | undefined;
  /** Computed from the domain and earlier answers; never prompted for. */
  derive?: (context: DeriveContext) => string | undefined;
  /**
   * Proposed from the server (#127) when nothing usable is set yet. Shown with
   * its reason and editable; undefined means "no opinion", and the template
   * default stands.
   */
  suggest?: (context: DeriveContext) => Promise<Suggestion | undefined>;
  /** Extra help shown under the template's own comment when the key is asked. */
  help?: string;
  /** Forced for a VPS deployment. Not offered, not overridable by a prompt. */
  fixed?: string;
  /** Only asked when the operator opted into this group. */
  group?: EnvGroup;
  /** Never written at all, whatever the template says. */
  never?: boolean;
  /**
   * An EMPTY value is an acceptable answer for this key.
   *
   * Nothing in ENV_METADATA below sets it, and the VPS path is unchanged by
   * its existence: a deployment that cannot reach its own OAuth provider is
   * not a deployment. It exists for the LOCAL profile in `init/` (issue #344),
   * where `GOOGLE_CLIENT_ID` may legitimately be filled in later - the clone
   * is being set up, not served - and an unattended run must produce a file
   * rather than an error listing the credentials nobody has yet.
   *
   * Blank SKIPS validation; a value that is present must still validate. That
   * asymmetry is the whole point: "not configured yet" and "configured wrong"
   * are different states and only the first one is allowed through.
   */
  allowBlank?: boolean;
}

/** 32 bytes from the CSPRNG. Never Math.random, and never a shelled-out openssl:
 * the CLI cannot assume what is installed, and this must behave identically on
 * a minimal container. */
export function generateBase64Key(): string {
  return randomBytes(32).toString('base64');
}

function requireMinLength(minimum: number) {
  return (value: string): string | undefined =>
    value.length >= minimum
      ? undefined
      : `must be at least ${minimum} characters (got ${value.length})`;
}

/** Rejects a value that is present but still the template's placeholder. */
function rejectPlaceholder(value: string): string | undefined {
  return /^your-|^change-me|example\.com$/i.test(value)
    ? 'still looks like the placeholder from .env.example'
    : undefined;
}

function combine(
  ...validators: ReadonlyArray<(value: string) => string | undefined>
) {
  return (value: string): string | undefined => {
    for (const validate of validators) {
      const message = validate(value);
      if (message !== undefined) return message;
    }
    return undefined;
  };
}

/**
 * AES-256 needs exactly 32 bytes. A key that merely LOOKS like base64 passes
 * startup and then fails the first time a credential is saved, which is a long
 * way from where the mistake was made.
 */
export function validateBase64Key32(value: string): string | undefined {
  // Empty is allowed: .env.example documents that this is optional until a
  // credential is actually stored.
  if (value === '') return undefined;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, 'base64');
  } catch {
    return 'must be base64';
  }
  // Buffer.from is lenient, so round-trip to catch input that is not base64 at
  // all rather than silently accepting a truncated decode.
  if (decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    return 'must be valid base64 (generate with: openssl rand -base64 32)';
  }
  if (decoded.length !== 32) {
    return `must decode to exactly 32 bytes for AES-256 (got ${decoded.length})`;
  }
  return undefined;
}

export function validateEmail(value: string): string | undefined {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    ? undefined
    : 'must be an email address';
}

export function validatePort(value: string): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536
    ? undefined
    : 'must be a port number between 1 and 65535';
}

export function validateBoolean(value: string): string | undefined {
  return value === 'true' || value === 'false' ? undefined : 'must be true or false';
}

export function validatePositiveInteger(value: string): string | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? undefined : 'must be a whole number above 0';
}

/** A Docker size: `512M`, `1g`, `2048m`. Compose accepts either case. */
export function validateMemorySize(value: string): string | undefined {
  return /^\d+[kmg]?b?$/i.test(value) ? undefined : 'must be a size such as 512M or 1G';
}

// -----------------------------------------------------------------------------
// The server-derived suggestions  (issue #127, epic #118)
// -----------------------------------------------------------------------------
//
// Each is a pure function of DeriveContext, so the tests hand it a fake
// server. NONE OF THESE IS APPLIED SILENTLY: the wizard shows every
// suggestion with its reason, and a value already set (on disk, or given
// with --answer) is never second-guessed.

/** How far past the default port to look before giving up. */
const PORT_SCAN_LIMIT = 100;

const GIB = 1024 * 1024 * 1024;

function formatGib(bytes: number): string {
  return `${Math.round((bytes / GIB) * 10) / 10} GiB RAM detected`;
}

/**
 * The first port from 3535 that is free on loopback AND recorded by no other
 * app. Both are consulted because each misses something: a bind probe cannot
 * see a stopped sibling, and a state file cannot see a stray process.
 */
export async function suggestBindPort(context: DeriveContext): Promise<Suggestion | undefined> {
  const portFree = context.portFree ?? isLoopbackPortFree;
  const skipped: string[] = [];

  for (let port = DEFAULT_BIND_PORT; port < DEFAULT_BIND_PORT + PORT_SCAN_LIMIT; port += 1) {
    const sibling = context.siblingPorts.find((entry) => entry.port === port);
    if (sibling !== undefined) {
      skipped.push(`${port} is used by ${sibling.name}`);
      continue;
    }
    if (!(await portFree(port))) {
      skipped.push(`${port} is in use on this server`);
      continue;
    }
    return {
      value: String(port),
      reason: skipped.length === 0 ? `${port} is free` : skipped.join(', '),
    };
  }

  return undefined;
}

/** `min(4, max(1, cpus - 1))`: one core left for the request path. */
export async function suggestWorkerConcurrency(
  context: DeriveContext,
): Promise<Suggestion | undefined> {
  const cpus = context.facts.cpus;
  if (cpus === null || cpus < 1) return undefined;
  return {
    value: String(Math.min(4, Math.max(1, cpus - 1))),
    reason: `${cpus} CPU${cpus === 1 ? '' : 's'} detected`,
  };
}

export async function suggestApiMemoryLimit(
  context: DeriveContext,
): Promise<Suggestion | undefined> {
  const bytes = context.facts.memoryBytes;
  if (bytes === null) return undefined;
  const value = bytes >= 8 * GIB ? '2g' : bytes >= 4 * GIB ? '1g' : '512m';
  return { value, reason: formatGib(bytes) };
}

export async function suggestWebMemoryLimit(
  context: DeriveContext,
): Promise<Suggestion | undefined> {
  const bytes = context.facts.memoryBytes;
  if (bytes === null) return undefined;
  return { value: bytes >= 4 * GIB ? '256m' : '128m', reason: formatGib(bytes) };
}

export const ENV_METADATA: Readonly<Record<string, EnvVarMetadata>> = {
  // --- Application ---------------------------------------------------------
  NODE_ENV: { fixed: 'production' },
  APP_URL: {
    // Derived, not asked. APP_URL and GOOGLE_CALLBACK_URL disagreeing with the
    // certificate's domain is the single most common failure in a hand-built
    // .env, and both restate information the operator has already given.
    derive: ({ domain }) => `https://${domain}`,
  },
  // --- Resources (#127) ----------------------------------------------------
  // Suggested from the server, never silently: see the functions above.
  APP_BIND_PORT: { validate: validatePort, suggest: suggestBindPort },
  JOBS_WORKER_CONCURRENCY: {
    validate: validatePositiveInteger,
    suggest: suggestWorkerConcurrency,
  },
  API_MEM_LIMIT: { validate: validateMemorySize, suggest: suggestApiMemoryLimit },
  WEB_MEM_LIMIT: { validate: validateMemorySize, suggest: suggestWebMemoryLimit },

  // --- Database ------------------------------------------------------------
  // Asked explicitly rather than defaulted: .env.example says `localhost`
  // while base.compose.yml falls back to `db`, and which of the two is right
  // depends on where the process runs, not on the deployment. `db` is a compose
  // service name that only resolves INSIDE the stack (devdb.compose.yml defines
  // it); `localhost` only works from the host. Inheriting either blindly would
  // be wrong for the other case.
  //
  // NO HOSTNAME IS EVER PRE-FILLED FOR POSTGRES_HOST (epic #118, decision 2).
  // This CLI is a template; a default hostname would be the template author's
  // server, not the operator's.
  POSTGRES_HOST: { essential: true },
  POSTGRES_PORT: { validate: validatePort },
  POSTGRES_USER: { essential: true },
  POSTGRES_PASSWORD: { essential: true, secret: true },
  POSTGRES_DB: { essential: true },
  POSTGRES_SSL: {
    // Asked, because checks/database.ts already honours it (PGSSLMODE=require)
    // and a managed PostgreSQL that requires TLS refuses a plaintext session
    // with an error that names nothing about SSL. `false` is a real answer,
    // not a placeholder, so an unattended run may take it.
    essential: true,
    defaultAcceptable: true,
    validate: validateBoolean,
    help: 'true or false. Set true when the server requires TLS; the database check that runs next verifies the connection either way.',
  },

  // --- JWT / session -------------------------------------------------------
  JWT_SECRET: {
    essential: true,
    secret: true,
    generate: 'base64-32',
    validate: combine(requireMinLength(32), rejectPlaceholder),
  },
  COOKIE_SECRET: {
    essential: true,
    secret: true,
    generate: 'base64-32',
    validate: combine(requireMinLength(32), rejectPlaceholder),
  },

  // --- Credential encryption ----------------------------------------------
  SECRETS_ENCRYPTION_KEY: {
    secret: true,
    generate: 'base64-32',
    validate: validateBase64Key32,
  },

  // --- OAuth ---------------------------------------------------------------
  // An empty GOOGLE_CLIENT_ID crashes bootstrap outright with "OAuth2Strategy
  // requires a clientID option", so this is a hard requirement.
  GOOGLE_CLIENT_ID: { essential: true, validate: rejectPlaceholder },
  GOOGLE_CLIENT_SECRET: {
    essential: true,
    secret: true,
    validate: rejectPlaceholder,
  },
  GOOGLE_CALLBACK_URL: {
    derive: ({ domain }) => `https://${domain}/api/auth/google/callback`,
  },

  // --- Web Push ------------------------------------------------------------
  // NEVER asked, but deliberately still READ (#241). `/admin/settings/push`
  // generates, rotates and enables these live since #355, and that is the
  // path an operator should use. `PushConfigService.resolveFromEnv` remains
  // case 1 of four - with no stored configuration at all these are the
  // fallback - so they stay in the template and stay documented; the wizard
  // simply stops pointing a first-time install at the wrong mechanism. An
  // operator who wants the env path writes them into .env by hand.
  VAPID_PUBLIC_KEY: { never: true },
  VAPID_PRIVATE_KEY: { never: true, secret: true },
  VAPID_SUBJECT: { never: true },

  // --- Admin bootstrap -----------------------------------------------------
  // Without it nobody can become an admin: the seed writes the allowlist row,
  // and the first OAuth login matching this address claims the role.
  INITIAL_ADMIN_EMAIL: {
    essential: true,
    validate: combine(validateEmail, rejectPlaceholder),
  },

  // --- Test authentication -------------------------------------------------
  // NEVER offered and never written. Setting it true in production fails
  // startup by design, and there is no reason a deployment should carry it.
  TEST_AUTH_ENABLED: { never: true },

  // --- Observability -------------------------------------------------------
  OTEL_ENABLED: { group: 'observability' },
  OTEL_EXPORTER_OTLP_ENDPOINT: { group: 'observability' },
  OTEL_SERVICE_NAME: { group: 'observability' },
  UPTRACE_PROJECT1_TOKEN: { group: 'observability', secret: true },
  UPTRACE_SECRET_KEY: { group: 'observability', secret: true },
  UPTRACE_ADMIN_EMAIL: { group: 'observability' },
  UPTRACE_ADMIN_PASSWORD: { group: 'observability', secret: true },
  UPTRACE_PGPASSWORD: { group: 'observability', secret: true },
  UPTRACE_SITE_URL: { group: 'observability' },
  UPTRACE_REDIS_PASSWORD: { group: 'observability', secret: true },
  UPTRACE_CH_PASSWORD: { group: 'observability', secret: true },
  UPTRACE_CH_USER: { group: 'observability' },

  // --- Storage -------------------------------------------------------------
  S3_BUCKET: { group: 'storage' },
  S3_REGION: { group: 'storage' },
  S3_ENDPOINT: { group: 'storage' },
  AWS_ACCESS_KEY_ID: { group: 'storage', secret: true },
  AWS_SECRET_ACCESS_KEY: { group: 'storage', secret: true },
  // The one key in this template whose EMPTY default is a real answer (#255).
  // `STORAGE_CSP_ORIGIN=` is uncommented with no value, so it is not optional
  // and its blank is not "unset" - it means "no extra origin", and the policy
  // reads as connect-src/media-src 'self' only. That is a deployment somebody
  // chose, unlike an empty AWS_ACCESS_KEY_ID, which is a credential nobody
  // supplied. Hence this flag here rather than a softer blank rule in
  // env-wizard.ts: SECRETS_ENCRYPTION_KEY and the two AWS keys ship empty
  // defaults too and must keep failing closed.
  STORAGE_CSP_ORIGIN: { allowBlank: true },
};

export function metadataFor(key: string): EnvVarMetadata {
  return ENV_METADATA[key] ?? {};
}

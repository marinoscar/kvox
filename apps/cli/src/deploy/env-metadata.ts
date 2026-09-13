import { randomBytes } from 'node:crypto';

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
export type EnvGroup = 'observability' | 'storage' | 'microsoft-oauth';

export interface DeriveContext {
  /** The public hostname the deployment is being published under. */
  domain: string;
  /** Answers collected so far, in prompt order. */
  answers: ReadonlyMap<string, string>;
}

export interface EnvVarMetadata {
  /** Never echoed, never logged, never rendered into a frame. */
  secret?: boolean;
  /** Asked even when the template supplies a default. */
  essential?: boolean;
  /** Offer to generate a value rather than make someone invent one. */
  generate?: 'base64-32';
  /** Returns a message when the value is unusable, undefined when it is fine. */
  validate?: (value: string) => string | undefined;
  /** Computed from the domain and earlier answers; never prompted for. */
  derive?: (context: DeriveContext) => string | undefined;
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

export const ENV_METADATA: Readonly<Record<string, EnvVarMetadata>> = {
  // --- Application ---------------------------------------------------------
  NODE_ENV: { fixed: 'production' },
  APP_URL: {
    // Derived, not asked. APP_URL and GOOGLE_CALLBACK_URL disagreeing with the
    // certificate's domain is the single most common failure in a hand-built
    // .env, and both restate information the operator has already given.
    derive: ({ domain }) => `https://${domain}`,
  },

  // --- Database ------------------------------------------------------------
  // Asked explicitly rather than defaulted: .env.example says `localhost`
  // while base.compose.yml falls back to `db`, and which of the two is right
  // depends on where the process runs, not on the deployment. `db` is a compose
  // service name that only resolves INSIDE the stack (devdb.compose.yml defines
  // it); `localhost` only works from the host. Inheriting either blindly would
  // be wrong for the other case.
  POSTGRES_HOST: { essential: true },
  POSTGRES_PORT: { validate: validatePort },
  POSTGRES_USER: { essential: true },
  POSTGRES_PASSWORD: { essential: true, secret: true },
  POSTGRES_DB: { essential: true },

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
  MICROSOFT_CLIENT_ID: { group: 'microsoft-oauth' },
  MICROSOFT_CLIENT_SECRET: { group: 'microsoft-oauth', secret: true },
  MICROSOFT_CALLBACK_URL: {
    group: 'microsoft-oauth',
    derive: ({ domain }) => `https://${domain}/api/auth/microsoft/callback`,
  },

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
  UPTRACE_DSN: { group: 'observability', secret: true },
  UPTRACE_CH_USER: { group: 'observability' },
  CLICKHOUSE_USER: { group: 'observability' },
  CLICKHOUSE_PASSWORD: { group: 'observability', secret: true },

  // --- Storage -------------------------------------------------------------
  S3_BUCKET: { group: 'storage' },
  S3_REGION: { group: 'storage' },
  S3_ENDPOINT: { group: 'storage' },
  AWS_ACCESS_KEY_ID: { group: 'storage', secret: true },
  AWS_SECRET_ACCESS_KEY: { group: 'storage', secret: true },
};

export function metadataFor(key: string): EnvVarMetadata {
  return ENV_METADATA[key] ?? {};
}

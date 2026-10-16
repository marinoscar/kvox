import { validatePort, type EnvSpecFragment } from '@marinoscar/platform-cli/core';

// =============================================================================
// The environment keys only this app has  (issue #482, epic #478)
// =============================================================================
//
// The platform CLI ships metadata for its own keys (the database login, the
// session secrets, OAuth, telemetry, the optional slices). The keys of
// `infra/compose/.env.example` that are this app's own would otherwise be
// treated generically by the install wizard: no validation, and nothing to keep
// the Web Push keys out of a generated environment file. Keys the platform
// already owns are not repeated here (a key with two owners is an error at
// `createCli`).
//
// The retired `VAPID_*` entries are gone: the platform notifications slice reads
// no VAPID environment variable (#470), and the commented lines were removed
// from the template when `infra/` moved to `platform-infra sync` (#483). So is
// `STORAGE_CSP_ORIGIN`: the platform's Content Security Policy allows `https:`
// for connect-src and media-src, so no storage origin is written into nginx.
// This app's own keys now live in `infra/compose/app.env.example`, appended to
// the generated `.env.example`.
//
// WHAT IS NOT HERE, AND WHY. Before the platform engine the wizard also
// SUGGESTED `APP_BIND_PORT`, `JOBS_WORKER_CONCURRENCY`, `API_MEM_LIMIT` and
// `WEB_MEM_LIMIT` from the server's facts (free port, CPU count, memory) and
// applied them without asking. `EnvVarMetadata` has no `suggest`, so those four
// now take the template default unless answered (`--answer`, `--answers-file`,
// or `--all` to review them); they are validated below so a wrong answer is
// still refused. `POSTGRES_SSL` used to be essential-but-defaultable (asked, yet
// accepted as `false` by an unattended run); the platform's "essential" cannot
// be defaulted, so it is validated and documented but not asked by default.
// =============================================================================

function validateBoolean(value: string): string | undefined {
  return value === 'true' || value === 'false' ? undefined : 'must be true or false';
}

function validatePositiveInteger(value: string): string | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? undefined : 'must be a whole number above 0';
}

/** A Docker size: `512M`, `1g`, `2048m`. Compose accepts either case. */
function validateMemorySize(value: string): string | undefined {
  return /^\d+[kmg]?b?$/i.test(value) ? undefined : 'must be a size such as 512M or 1G';
}

export const APP_ENV_SPEC: EnvSpecFragment = {
  id: 'app',
  metadata: {
    // --- Resources -----------------------------------------------------------
    APP_BIND_PORT: { validate: validatePort },
    JOBS_WORKER_CONCURRENCY: { validate: validatePositiveInteger },
    API_MEM_LIMIT: { validate: validateMemorySize },
    WEB_MEM_LIMIT: { validate: validateMemorySize },

    // --- Database ------------------------------------------------------------
    POSTGRES_SSL: {
      validate: validateBoolean,
      help: 'true or false. Set true when the server requires TLS; the database check that runs next verifies the connection either way.',
    },

    // --- Knowledge graph -----------------------------------------------------
    // Anything but `false` leaves the scheduler on (apps/api/src/config), so the
    // wizard accepts only the two spellings the template documents.
    KG_MIGRATE_SCHEDULE_ENABLED: { validate: validateBoolean },
  },
};

// =============================================================================
// Which compose files a deployment is driven with
// =============================================================================
//
// A VPS deployment is always `base`, `prod`, `vps`. When it opted into the
// observability group it ALSO carries the platform telemetry stack (the
// OpenTelemetry collector and GreptimeDB), and the order is the platform's:
//
//   base, prod, telemetry, vps, vps.telemetry
//
// ORDER IS LOAD-BEARING. Compose merges `-f` files left to right and a later
// file wins. `telemetry.compose.yml` adds services, so it sits BEFORE
// `vps.compose.yml` and inherits that file's hardening; `vps.telemetry.compose.yml`
// hardens those services (`ports: !override`, loopback binding, memory caps) and
// therefore comes last. Putting either telemetry file anywhere else changes
// which ports reach a public interface.
//
// HOW A DEPLOYMENT IS KNOWN TO HAVE TELEMETRY. From its `.env`, not from a
// recorded flag: `telemetry.compose.yml` interpolates the three GreptimeDB
// passwords with `${VAR:?...}`, so a stack missing any one of them cannot even
// be parsed by `docker compose`. The `.env` carries all three exactly when the
// operator opted into the observability group (the wizard writes them, and the
// template's placeholders are refused), so "all three set" is both the sign
// that the group was chosen and the precondition for the overlay to load.
// Deriving it means a deployment installed before this overlay existed is
// unchanged until its operator adds the passwords, and no state file changes.
// =============================================================================

/** The three GreptimeDB logins' passwords, which `telemetry.compose.yml` cannot load without. */
const TELEMETRY_REQUIRED_KEYS = [
  'GREPTIME_WRITER_PASSWORD',
  'GREPTIME_READER_PASSWORD',
  'GREPTIME_ADMIN_PASSWORD',
] as const;

export const BASE_COMPOSE_FILE = 'base.compose.yml';
export const PROD_COMPOSE_FILE = 'prod.compose.yml';
export const VPS_COMPOSE_FILE = 'vps.compose.yml';
export const TELEMETRY_COMPOSE_FILE = 'telemetry.compose.yml';
export const VPS_TELEMETRY_COMPOSE_FILE = 'vps.telemetry.compose.yml';

/** True when this `.env` carries a usable telemetry configuration. */
export function telemetryEnabled(env: ReadonlyMap<string, string> | undefined): boolean {
  if (env === undefined) return false;
  return TELEMETRY_REQUIRED_KEYS.every((key) => (env.get(key) ?? '').trim() !== '');
}

/**
 * The `-f` file names for one deployment, in compose's merge order.
 *
 * @param env - The deployment's parsed `.env`; undefined (no file yet) means no telemetry.
 */
export function composeFilesFor(env: ReadonlyMap<string, string> | undefined): string[] {
  return telemetryEnabled(env)
    ? [
        BASE_COMPOSE_FILE,
        PROD_COMPOSE_FILE,
        TELEMETRY_COMPOSE_FILE,
        VPS_COMPOSE_FILE,
        VPS_TELEMETRY_COMPOSE_FILE,
      ]
    : [BASE_COMPOSE_FILE, PROD_COMPOSE_FILE, VPS_COMPOSE_FILE];
}

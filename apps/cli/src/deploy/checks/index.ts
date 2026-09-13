import type { Check } from './types.js';
import { DATABASE_CHECKS } from './database.js';
import { DNS_CHECKS } from './dns.js';
import { HOST_CHECKS } from './host.js';
import { TLS_CHECKS } from './tls.js';

// =============================================================================
// The check registry  (issue #176, epic #168)
// =============================================================================
//
// ONE ordered list. `doctor` renders it (#178), and install and update run the
// `required` subset as their preflight (#180, #182) - from here, not from a
// second list of their own. Two lists is how a prerequisite ends up enforced
// by one command and not the other.
// =============================================================================

// Host first: everything else depends on docker being usable, and a server
// with no docker should say so before it starts probing databases.
export const ALL_CHECKS: readonly Check[] = [
  ...HOST_CHECKS,
  ...DATABASE_CHECKS,
  ...DNS_CHECKS,
  ...TLS_CHECKS,
];

/** The subset install and update must pass before they touch anything. */
export function requiredChecks(checks: readonly Check[] = ALL_CHECKS): Check[] {
  return checks.filter((check) => check.severity === 'required');
}

export * from './types.js';
export { HOST_CHECKS, evaluateDf } from './host.js';
export { DATABASE_CHECKS, databaseSettings, probeTcp } from './database.js';
export { DNS_CHECKS } from './dns.js';
export { TLS_CHECKS, parseNotAfter } from './tls.js';

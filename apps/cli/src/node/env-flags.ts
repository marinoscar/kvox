// =============================================================================
// Reading boolean environment variables  (issue #277, epic #254)
// =============================================================================
//
// Two helpers rather than one, because DEFAULT-ON and DEFAULT-OFF variables
// must not share a parser. `envFlagOn('')` and `envFlagOff('')` have to give
// opposite answers, and folding that into a single function with a default
// argument is how a variable ends up meaning the opposite of what its name
// says when it is set to the empty string — which is what a compose file with
// `APPCTL_MEMORY_WATCHDOG=` produces.
// =============================================================================

/** True only for an explicit affirmative. The parser for DEFAULT-OFF settings. */
export function envFlagOn(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/** True only for an explicit negative. The parser for DEFAULT-ON settings. */
export function envFlagOff(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === 'false' || value === '0' || value === 'no' || value === 'off';
}

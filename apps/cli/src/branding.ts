import { APP_NAME } from '@app/shared';

// =============================================================================
// CLI identity — the one constant a fork renames  (issue #140, epic #110)
// =============================================================================
//
// This repository is a TEMPLATE. Somebody clones it, calls their product
// something else, and every user-visible string carrying "appctl" is now
// wrong. The whole point of this module is that renaming is a one-line edit
// here rather than a grep across the package, so three separate things are
// DERIVED from `CLI_NAME` instead of being written out again:
//
//   1. the executable name shown in `--help` and in error messages
//   2. the config directory, `~/.appctl/` (consumed by #143)
//   3. the environment-variable prefix, `APPCTL_` (consumed by #143/#144)
//
// If those three were three literals, a rename would leave a binary called
// `acmectl` reading `~/.appctl/config.json` and answering to `APPCTL_TOKEN` —
// and nothing would fail, which is what makes that class of bug expensive.
//
// TWO IDENTITIES, NOT ONE (issue #165, epic #161). The three things above are
// the BINARY's identity and are still seeded by `CLI_NAME` right here. The
// PRODUCT's display name is a different fact with a different blast radius —
// it appears in the browser wordmark and in email templates too — so it now
// comes from `@app/shared`, and `CLI_DISPLAY_NAME` is derived from it. A fork
// renaming its product edits that one constant and the CLI banner follows;
// renaming the executable is still an edit here, and the two are deliberately
// independent.
//
// THE ONE PLACE THIS CONSTANT CANNOT REACH is the `bin` key in package.json.
// npm reads that file before any code runs, so the name is necessarily written
// there a second time. A test asserting `packageJson.bin` has exactly one key
// and that it equals `CLI_NAME` is the guard for that duplication, and it is
// the reason the duplication is acceptable rather than merely tolerated.
// =============================================================================

/**
 * The name of the executable, and the seed for everything else in this file.
 *
 * WHY `appctl` AND NOT `app`: a bare `app` is short enough to collide with
 * something already on a developer's PATH, and a CLI that silently shadows (or
 * is silently shadowed by) another binary is a support ticket nobody enjoys.
 * The `-ctl` suffix is the established convention for "the control client for
 * a service" (kubectl, systemctl, gcloud's various *ctl tools), it reads as
 * neutral rather than as a product name, and it is unlikely to already exist.
 *
 * WHY NOT DERIVE IT FROM package.json's `name`: that field is `cli`, because
 * it is the workspace name (`apps/api` is `api`, `apps/web` is `web`), and
 * `cli` is not a name anyone wants to type. The two are independent facts.
 *
 * CONSTRAINTS ON A REPLACEMENT VALUE: lowercase ASCII letters, digits and
 * hyphens. It becomes a filesystem path and an env-var prefix, so anything
 * else (spaces, dots, uppercase) produces a dotfile directory that is awkward
 * to type on one side and an unusable variable name on the other.
 */
export const CLI_NAME = 'appctl';

/**
 * Human-readable product name for banners and `--help` output.
 *
 * Separate from `CLI_NAME` because the two genuinely differ: you type `git`
 * and the docs say "Git". `CLI_NAME` is this executable's own identity and is
 * still set right here; the PRODUCT half now comes from `@app/shared`, which
 * the web app and the API render too (issue #165, epic #161).
 *
 * That split is the point rather than an inconsistency. Renaming the product
 * should rename the CLI's banner along with the browser wordmark and the email
 * templates — one edit, everything follows. Renaming the BINARY should not: a
 * product called "Acme" may perfectly well still ship a command called
 * `appctl`, and `CLI_NAME` additionally seeds a filesystem path and an
 * environment-variable prefix, which is why it keeps its own constraints and
 * its own constant.
 */
export const CLI_DISPLAY_NAME = `${APP_NAME} CLI`;

/**
 * The per-user config directory NAME (not the path — resolving `~` needs
 * `os.homedir()`, and that belongs to #143, which owns the file itself).
 *
 * The leading dot is applied here rather than left to the caller so that every
 * consumer cannot get it subtly wrong in its own way.
 */
export const CONFIG_DIR_NAME = `.${CLI_NAME}`;

/**
 * Basename of the config file inside that directory.
 *
 * DELIBERATELY NOT `credentials.json` OR `secrets.json`, even though it will
 * hold a token. Those two names are exactly what a machine-level git
 * excludesFile blocks (see the note at the bottom of the repo .gitignore and
 * issue #115), and a file whose name is on a global ignore list is a file that
 * vanishes from `git add` without a warning. This one is never committed, but
 * the naming habit is worth keeping consistent — and any FIXTURE of it written
 * under test would hit precisely that trap.
 */
export const CONFIG_FILE_NAME = 'config.json';

/**
 * Turn the CLI name into a legal environment-variable prefix: `APPCTL_`.
 *
 * The uppercase-and-substitute is not decoration. A fork that renames to
 * `acme-cli` would otherwise produce `ACME-CLI_TOKEN`, which no POSIX shell
 * can set (`export ACME-CLI_TOKEN=x` is a syntax error) — the CLI would read
 * an env var that is impossible to provide, and the failure would look like
 * "my token is being ignored" rather than "that name is illegal".
 *
 * A leading digit is also illegal in a shell identifier, hence the underscore
 * prefix in that case.
 */
function toEnvPrefix(name: string): string {
  const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return /^[0-9]/.test(upper) ? `_${upper}_` : `${upper}_`;
}

/** e.g. `APPCTL_`. Every env var this CLI reads starts with it. */
export const ENV_PREFIX = toEnvPrefix(CLI_NAME);

/**
 * Build the full name of one of this CLI's environment variables.
 *
 *   envVar('TOKEN')      -> 'APPCTL_TOKEN'
 *   envVar('SERVER_URL') -> 'APPCTL_SERVER_URL'
 *
 * Callers pass the SUFFIX only and never concatenate the prefix themselves, so
 * `process.env` lookups cannot drift from the names printed in help text.
 *
 * NOTE ON THE EPIC: #110 sketches these as `APP_SERVER_URL` / `APP_TOKEN`. A
 * bare `APP_` prefix is too generic to claim in a shared shell — it is a
 * plausible name for half a dozen unrelated tools, and a CI runner that
 * exports `APP_TOKEN` for something else would have this CLI silently pick it
 * up and send it to a server as a bearer credential. Prefixing with the binary
 * name is the standard defence and costs nothing.
 */
export function envVar(suffix: string): string {
  return `${ENV_PREFIX}${suffix}`;
}

/**
 * The API's global route prefix, set by `app.setGlobalPrefix('api')` in
 * apps/api/src/main.ts. Lives here beside the other identity constants because
 * it is the other half of "where do I send a request" and, unlike the rest of
 * this file, it is NOT something a fork should change casually — moving it
 * means moving the nginx routes too.
 */
export const API_PATH_PREFIX = '/api';

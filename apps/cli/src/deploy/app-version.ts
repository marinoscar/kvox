import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError } from '../errors.js';

// =============================================================================
// The application's own version, chosen at deploy time  (issue #295, epic #168)
// =============================================================================
//
// `apps/api/package.json` and `apps/web/package.json` had both read 1.0.0 since
// the template, so the About page's "Version" fact never changed and two
// deployments of two different revisions were indistinguishable by version.
// The plumbing to carry a version already existed end to end and had simply
// never been fed:
//
//   apps/api/package.json -> readDeployedAppVersion()   (deploy-info.ts)
//                         -> deploy-info/info.json  app.version
//                         -> GET /api/admin/about
//                         -> the About page's "Version" fact
//
//   APP_VERSION in the deployment's .env
//                         -> resolveApiVersion()        (apps/api/src/openapi/version.ts)
//
// This module is the source of the number both of those now carry. Everything
// in it is PURE except the three functions that say otherwise in their names
// (`readVersionSources`, `writeAppVersion`), because the pipeline steps that
// call it have to be testable without a filesystem.
//
// WHY DEPLOY TIME RATHER THAN RELEASE TIME. This was argued and decided the
// other way round from the usual answer; the trade-offs it accepts are
// recorded in issue #295's "Accepted risks" and in `docs/specs/vps-deploy.md`
// §24. This module implements that decision and does not re-open it.
//
// ONE SHARED VERSION FOR THE PRODUCT. `apps/api` and `apps/web` ship as one
// deployment from one commit, so two numbers could only ever diverge by
// accident. `writeAppVersion` writes both or neither.
// =============================================================================

/** The `.env` key `resolveApiVersion()` reads first. */
export const APP_VERSION_KEY = 'APP_VERSION';

/** The package manifests that carry the product version, in lockstep. */
export const VERSIONED_MANIFESTS: readonly string[] = [
  join('apps', 'api', 'package.json'),
  join('apps', 'web', 'package.json'),
];

/** The root lockfile, whose workspace entries carry the version too. */
export const LOCKFILE = 'package-lock.json';

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers after `-`; empty for a release version. */
  prerelease: readonly string[];
  /** Dot-separated identifiers after `+`. Ignored by precedence, per the spec. */
  build: readonly string[];
}

/**
 * SemVer 2.0.0's own grammar, anchored.
 *
 * Deliberately strict: `v1.2.3`, `1.2`, `01.2.3` and `1.2.3.4` are all
 * REFUSED rather than coerced. A deploy-time version is typed by a human under
 * time pressure, and quietly reinterpreting what they typed is how a server
 * ends up reporting a number nobody chose. The refusal names the input.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parses a strict SemVer 2.0.0 string; undefined for anything else. */
export function parseSemver(value: string): Semver | undefined {
  const match = SEMVER.exec(value.trim());
  if (match === null) return undefined;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined || match[4] === '' ? [] : match[4].split('.'),
    build: match[5] === undefined || match[5] === '' ? [] : match[5].split('.'),
  };
}

/** True when `value` is a version this CLI will write. */
export function isSemver(value: string): boolean {
  return parseSemver(value) !== undefined;
}

/**
 * SemVer 2.0.0 §11 precedence: negative, zero or positive, like a comparator.
 *
 * Build metadata is IGNORED, as the specification requires — `1.0.0+a` and
 * `1.0.0+b` have equal precedence, so neither sorts above the other and
 * neither is an acceptable "next" version for the other.
 *
 * A prerelease sorts BELOW its release (`1.0.0-rc.1 < 1.0.0`), which is what
 * makes "1.0.0 after 1.0.0-rc.1" a legal deploy and the reverse a refusal.
 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // "A pre-release version has lower precedence than a normal version."
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    // "A larger set of pre-release fields has a higher precedence than a
    // smaller set, if all of the preceding identifiers are equal."
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) - Number(right);
      continue;
    }
    // "Numeric identifiers always have lower precedence than alphanumeric."
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }

  return 0;
}

/** Compares two version STRINGS. Unparseable sorts below anything parseable. */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return compareSemver(left, right);
}

/**
 * The version this run suggests: a patch bump of `current`.
 *
 * A PRERELEASE BECOMES ITS OWN RELEASE rather than gaining a patch:
 * `1.4.0-rc.2` suggests `1.4.0`, not `1.4.1`. The release is the next version
 * above a prerelease of it by SemVer's own precedence rule, and it is what an
 * operator deploying a release candidate to production actually means.
 *
 * Build metadata is dropped: it does not participate in precedence, so
 * carrying it forward would produce a "next" version that does not sort above
 * the current one and that `validateAppVersion` would then refuse.
 */
export function suggestBump(current: string): string {
  const parsed = parseSemver(current);
  // Nothing parseable to bump from — the fallback `currentAppVersion` returns
  // for a clone whose manifests are missing or unreadable.
  if (parsed === undefined) return '0.0.1';

  if (parsed.prerelease.length > 0) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export interface VersionSources {
  /** `apps/api/package.json`'s version in the clone. */
  api: string | undefined;
  /** `apps/web/package.json`'s version in the clone. */
  web: string | undefined;
  /** `APP_VERSION` in the deployment's `.env`, i.e. what is running now. */
  env: string | undefined;
}

/**
 * The version a bump is measured from: the HIGHEST of what the clone says and
 * what this deployment is actually running.
 *
 * THE `.env` IS IN THIS MAX ON PURPOSE, and it is not belt and braces. When a
 * publish cannot reach the repository — a fork with no push access, a tag
 * deploy, a race lost to another server — the bump is rolled back out of the
 * clone (see `publishVersionPlan` in install.ts/update.ts), so the clone comes
 * back reporting the OLD number while the deployment is serving the new one.
 * Measuring from the clone alone would then suggest the same number again on
 * the next deploy, and `validateAppVersion` would accept it, and the running
 * version would silently go backwards. Taking the max makes the suggestion
 * monotonic against what is actually deployed, whatever the repository ended
 * up recording.
 *
 * `0.0.0` when nothing is readable — a fresh clone whose manifests this fork
 * moved, say. `suggestBump` then proposes `0.0.1`, which is honest: this CLI
 * has no idea what came before.
 */
export function currentAppVersion(sources: VersionSources): string {
  const candidates = [sources.api, sources.web, sources.env].filter(
    (value): value is string => value !== undefined && isSemver(value),
  );
  if (candidates.length === 0) return '0.0.0';
  return candidates.reduce((best, value) => (compareVersions(value, best) > 0 ? value : best));
}

/** The `version` of a package manifest; undefined when absent or unreadable. */
export function readManifestVersion(path: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Reads every source the suggestion is measured from. */
export function readVersionSources(
  repoPath: string,
  env?: ReadonlyMap<string, string> | undefined,
): VersionSources {
  const envVersion = env?.get(APP_VERSION_KEY);

  return {
    api: readManifestVersion(join(repoPath, VERSIONED_MANIFESTS[0] as string)),
    web: readManifestVersion(join(repoPath, VERSIONED_MANIFESTS[1] as string)),
    env: envVersion === undefined || envVersion === '' ? undefined : envVersion,
  };
}

/**
 * Why `candidate` may not be deployed, or undefined when it may.
 *
 * TWO RULES, AND THE SECOND IS THE ONE THAT MATTERS: it must parse as SemVer,
 * and it must sort STRICTLY ABOVE the current version. A deploy must never
 * move the number backwards — a server reporting 1.4.0 that is later
 * redeployed as 1.3.9 makes every version in every log and every support
 * conversation meaningless, and there is no way to tell afterwards which
 * 1.3.9 anyone was looking at.
 *
 * Equality is refused too, not only regression. Re-deploying the same number
 * for different code is the same failure with a smaller step size, and
 * `--no-version-bump` is the supported way to say "redeploy this release
 * unchanged".
 */
export function validateAppVersion(candidate: string, current: string): string | undefined {
  const trimmed = candidate.trim();

  if (trimmed === '') return 'A version is required.';
  if (!isSemver(trimmed)) {
    return (
      `\`${trimmed}\` is not a valid SemVer version. ` +
      `Write it as MAJOR.MINOR.PATCH — for example ${suggestBump(current)} — ` +
      `optionally with a \`-prerelease\` suffix. A leading \`v\` is not part of the version.`
    );
  }

  const order = compareVersions(trimmed, current);
  if (order === 0) {
    return (
      `\`${trimmed}\` is the version already deployed. ` +
      `Choose a higher one, or pass --no-version-bump to redeploy this release unchanged.`
    );
  }
  if (order < 0) {
    return (
      `\`${trimmed}\` sorts BELOW the current version \`${current}\`, and a deploy must never ` +
      `move the version backwards. Choose a higher one, or pass --no-version-bump to redeploy ` +
      `without touching it.`
    );
  }

  return undefined;
}

/**
 * Replaces the top-level `version` in a package manifest, TEXTUALLY.
 *
 * A targeted edit rather than `JSON.parse` -> `JSON.stringify`: re-serialising
 * would reformat a fork's hand-formatted manifest on every deploy, turning a
 * one-line version change into a whole-file diff in somebody else's
 * repository. This repository's two manifests happen to round-trip byte for
 * byte, which is exactly why relying on that would be easy and wrong.
 *
 * The edited value is checked against the PARSED manifest's own `version`, so
 * a regex that matched something else — a nested `"version"` key a fork added
 * above it — cannot silently rewrite the wrong field.
 */
export function setManifestVersion(contents: string, version: string): string {
  const parsed = JSON.parse(contents) as { version?: unknown };
  const span = findTopLevelStringValue(contents, 'version');

  if (span === undefined || contents.slice(span.start, span.end) !== parsed.version) {
    throw new UsageError(
      `Could not find the top-level "version" field to update in this package.json. ` +
        `Set the version by hand, or re-run with --no-version-bump.`,
    );
  }

  return contents.slice(0, span.start) + version + contents.slice(span.end);
}

/**
 * Where a TOP-LEVEL key's string value sits, by character offset.
 *
 * DEPTH-AWARE RATHER THAN A REGEX, because "the first `"version"` in the file"
 * is not the same thing as "the manifest's version". A nested one — inside
 * `engines`, inside a fork's own block, inside `overrides` — can appear first,
 * and a regex that matched it would rewrite a dependency constraint while the
 * product version stayed put. Depth 1 is exactly the question being asked.
 *
 * It also has to work on a MINIFIED manifest: `{"name":"api","version":"1.0.0"}`
 * is legal JSON with no line structure at all, so anchoring to the start of a
 * line is not available either. (The test fixtures write one; so could a fork's
 * build step.)
 *
 * Returns the offsets of the value's contents, excluding its quotes. Only
 * plain string values are recognised — a `version` that is not a string is not
 * something this CLI should be editing anyway.
 */
function findTopLevelStringValue(
  contents: string,
  key: string,
): { start: number; end: number } | undefined {
  let depth = 0;
  let index = 0;

  /** Consumes a JSON string starting at a quote; returns its inner span. */
  const readString = (at: number): { start: number; end: number; next: number } => {
    const start = at + 1;
    let cursor = start;
    while (cursor < contents.length) {
      const character = contents[cursor];
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (character === '"') return { start, end: cursor, next: cursor + 1 };
      cursor += 1;
    }
    return { start, end: contents.length, next: contents.length };
  };

  while (index < contents.length) {
    const character = contents[index];

    if (character === '"') {
      const token = readString(index);
      const isKeyAtTopLevel =
        depth === 1 && contents.slice(token.start, token.end) === key;
      index = token.next;

      if (!isKeyAtTopLevel) continue;

      // Skip the whitespace and the colon between the key and its value.
      while (index < contents.length && /[\s:]/.test(contents[index] as string)) index += 1;
      if (contents[index] !== '"') return undefined;

      const value = readString(index);
      return { start: value.start, end: value.end };
    }

    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    index += 1;
  }

  return undefined;
}

/**
 * Replaces one workspace's `version` in `package-lock.json`, TEXTUALLY.
 *
 * ⚠ DELIBERATELY NOT `npm install --package-lock-only`, which issue #295
 * proposed and which is what CLAUDE.md's CLI version rule requires of a
 * developer bumping the CLI in the repository. The two situations are not the
 * same, and the difference matters:
 *
 *   1. IT WOULD RESOLVE DEPENDENCY RANGES AGAINST THE REGISTRY. A
 *      `--package-lock-only` run rewrites whatever it can improve, so a deploy
 *      could quietly pull newer transitive versions into the lockfile — and
 *      `npm ci` in the Dockerfile would then install them into the image.
 *      Issue #295's accepted risk ("the deployed commit is not the commit CI
 *      built") is explicitly bounded by "nothing that changes behaviour"; a
 *      version bump that also moves the dependency tree breaks that bound.
 *   2. IT NEEDS THE REGISTRY AT ALL, on a production server, in the middle of
 *      a deploy, for a three-character edit.
 *
 * The lockfile carries a workspace's version in exactly ONE place —
 * `packages["apps/api"].version` — so the surgical edit is complete rather
 * than merely cheaper. `app-version.test.ts` asserts that against this
 * repository's own lockfile so a future npm format change cannot make it
 * silently partial.
 *
 * Returns the contents unchanged when the lockfile has no entry for that
 * workspace: a fork may not vendor one, and a missing lockfile entry is not a
 * reason to fail a deploy. (`npm ci` does not validate a workspace's own
 * version field, so a stale entry never breaks the build either — it is
 * recorded for the humans reading the diff.)
 */
export function setLockfileWorkspaceVersion(
  contents: string,
  workspace: string,
  version: string,
): string {
  const parsed = JSON.parse(contents) as {
    packages?: Record<string, { version?: unknown }> | undefined;
  };
  const recorded = parsed.packages?.[workspace]?.version;
  if (typeof recorded !== 'string') return contents;

  const escaped = workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `("${escaped}"[ \\t]*:[ \\t]*\\{\\s*"version"[ \\t]*:[ \\t]*")([^"]*)(")`,
  ).exec(contents);

  if (match === null || match[2] !== recorded) {
    // The entry exists in the parsed document but not in the shape this edit
    // understands. Leaving it alone is right: a wrong surgical edit to a
    // lockfile is far worse than a stale version field in one.
    return contents;
  }

  const { index } = match;
  return (
    contents.slice(0, index) +
    `${match[1] as string}${version}${match[3] as string}` +
    contents.slice(index + (match[0] as string).length)
  );
}

/** The workspace paths `setLockfileWorkspaceVersion` is applied to. */
export const VERSIONED_WORKSPACES: readonly string[] = ['apps/api', 'apps/web'];

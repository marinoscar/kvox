import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { githubSlug } from './repo.js';

// =============================================================================
// The environment template the INSTALLER saved beside the CLI  (issue #236)
// =============================================================================
//
// WHY THIS EXISTS
//
// `install.sh` clones the repository, builds this CLI from it, copies `dist/`,
// `package.json` and the vendored workspace packages into the install root,
// and then deletes the clone. `infra/compose/.env.example` went with it — so
// the wizard turned around and asked GitHub, over the network, through a
// credential that may not exist for the invoking user, for a file the
// installer had held in its hands minutes earlier.
//
// That is the failure reported for a first install on a real server: the
// remote read needs `gh`, `gh`'s authentication is PER USER, the installer
// deliberately supports running as root (#226), and root's `gh` is commonly
// logged out. The wizard then had no template, so it asked no questions about
// the database, the secrets, the OAuth client or the administrator.
//
// So the installer now keeps that one file, and this module reads it. An
// ordinary first install needs no network and no credential to know what to
// ask.
//
// WHY IT IS GATED ON THE REPOSITORY, AND WHY THAT GATE IS NOT OPTIONAL
//
// A bundled copy is the template of the repository THIS CLI WAS BUILT FROM.
// That is not necessarily the repository being deployed: `--repo` names any
// repository, and a CLI built from one fork can deploy another. Handing one
// repository's variable list to another repository's install is exactly the
// defect #229 fixed one layer up, where a sibling application's `.env.example`
// was answering this application's questions.
//
// So the installer records the clone URL it used, and this module refuses to
// answer unless that repository and the one being deployed are the same. A
// missing or unreadable record is a refusal, never an assumption.
// =============================================================================

/** Directory, relative to the package root, the installer writes into. */
const TEMPLATE_DIR = 'template';

/** The saved template, and the record of where it came from. */
const TEMPLATE_FILE = '.env.example';
const SOURCE_FILE = 'source.json';

export interface BundledTemplate {
  /** The file's contents, byte for byte as the repository holds them. */
  contents: string;
  /** The clone URL the installer read it from. */
  repoUrl: string;
  /** The branch, tag or commit it was read at; empty when unrecorded. */
  ref: string;
}

/** The package root, one level above this file in both src and dist layouts. */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The template the installer saved, or `undefined`.
 *
 * `undefined` covers a CLI installed before this existed, a development
 * checkout that never ran the installer, and an install whose record is
 * missing or malformed — all of which mean "there is nothing here to trust".
 */
export function readBundledTemplate(root = packageRoot()): BundledTemplate | undefined {
  try {
    const directory = join(root, TEMPLATE_DIR);
    const contents = readFileSync(join(directory, TEMPLATE_FILE), 'utf8');
    if (contents.trim() === '') return undefined;

    const parsed: unknown = JSON.parse(readFileSync(join(directory, SOURCE_FILE), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const record = parsed as { repoUrl?: unknown; ref?: unknown };
    if (typeof record.repoUrl !== 'string' || record.repoUrl === '') return undefined;

    return {
      contents,
      repoUrl: record.repoUrl,
      ref: typeof record.ref === 'string' ? record.ref : '',
    };
  } catch {
    return undefined;
  }
}

/**
 * True when a bundled template may answer for `repoUrl`.
 *
 * Compared on the GitHub slug rather than the raw string, so the same
 * repository written as ssh, scp-style or https — with or without a `.git`
 * suffix — still matches. Two URLs neither of which is on GitHub are compared
 * literally: there is no parser here that could safely equate them.
 */
export function bundledTemplateMatches(bundled: BundledTemplate, repoUrl: string): boolean {
  const theirs = githubSlug(repoUrl);
  const ours = githubSlug(bundled.repoUrl);
  if (theirs !== null && ours !== null) return theirs.toLowerCase() === ours.toLowerCase();
  if (theirs === null && ours === null) return bundled.repoUrl.trim() === repoUrl.trim();
  return false;
}

/** The bundled template's contents when it belongs to `repoUrl`, else nothing. */
export function bundledTemplateFor(
  repoUrl: string,
  root?: string,
): string | undefined {
  if (repoUrl.trim() === '') return undefined;
  const bundled = root === undefined ? readBundledTemplate() : readBundledTemplate(root);
  if (bundled === undefined) return undefined;
  return bundledTemplateMatches(bundled, repoUrl) ? bundled.contents : undefined;
}

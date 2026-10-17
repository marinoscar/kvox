#!/usr/bin/env node
// =============================================================================
// Slice and peer-dependency check for the @marinoscar/kvox-* packages
// =============================================================================
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim), with the
// platform- prefix and file names turned into the constants below.
//
// WHY
// -----------------------------------------------------------------------------
// A package is a set of SLICES: the folders directly under
// packages/kvox-<pkg>/src/. A host (the web edition, KVox Desktop) installs the
// package and imports only the slices it needs, so it must also install only
// the peer dependencies those slices need. Two files describe that, and this
// script keeps them honest against the source:
//
//   packages/kvox-slices.json       slice -> the slices it may import
//   packages/kvox-slice-peers.json  slice -> the packages its files import,
//                                   plus $universal, $implies, $reserved and
//                                   $hostOnly (see docs/PACKAGES.md)
//
// THE RULES (each violation is printed as `[rule] message`)
// -----------------------------------------------------------------------------
//   1. graph         Every key of kvox-slices.json is a packages/kvox-* package
//                    and every package is listed; a slice depends only on
//                    declared slices of its own package; the graph has no
//                    cycle; every folder under src/ is a declared slice
//                    (a slice may be declared before its folder exists).
//   2. peers-data    Every declared slice has an entry in kvox-slice-peers.json
//                    and every entry is a declared slice; $universal names
//                    declared slices (or "*" for all of them).
//   3. manifest      package.json peerDependencies match the data: a peer the
//                    universal slices need (with the slices they depend on) is
//                    required, any other peer is optional
//                    (peerDependenciesMeta), every peer in the data exists in
//                    package.json, every peer in package.json is accounted
//                    for (a slice, $reserved or $hostOnly), and a $hostOnly
//                    peer is imported by no slice.
//   4. imports       Every non-relative, non-built-in import in a slice's files
//                    names a package the slice (or a slice it depends on)
//                    lists, directly or through $implies, or a dependency of
//                    the package. Comments are ignored. Files at the root of
//                    src/ may use any peer of their package.
//   5. app-installs  With --app <dir>: an app that imports
//                    @marinoscar/kvox-<pkg>/<slice> lists the package and every
//                    peer that slice (and the slices it depends on) needs in
//                    its own package.json, or in the root package.json.
//                    A peer named with --without is exempt: the app leaves it
//                    out on purpose because the feature that needs it is switched
//                    off in the slice's forRoot (examples/bare-host leaves out
//                    @nestjs/schedule, pdfkit, docx and unpdf). The exemption is
//                    for rule 5 only; the app must then really not install it.
//
//   6. host-neutral  No file under packages/kvox-api/src/** or
//                    packages/kvox-web/src/** imports @marinoscar/platform-*.
//                    A slice that did could not be installed on Desktop, where
//                    the platform does not exist. The one place that imports
//                    the platform is the app folder apps/api/src/platform-kvox.
//                    packages/kvox-ai/src/** may import exactly one platform
//                    specifier, the public subpath @marinoscar/platform-api/ai
//                    (the provider-adapter types and classes, an interim peer
//                    until the lean adapter package of #578); any other
//                    platform specifier, the bare package or a deeper path
//                    such as @marinoscar/platform-api/ai/core, is a violation
//                    (HOST_NEUTRAL_ALLOWED).
//   7. headless      No file under packages/kvox-web/src/<slice>/headless/**
//                    imports @mui/*, @emotion/* or a router (react-router*), or
//                    reaches into a ui/ folder. A headless entry is what a host
//                    with another design system builds its own UI on.
//
// ENTRIES. A web slice is split into entries, the folders headless/, ui/ and
// testing/ directly under the slice. A slice entry in kvox-slice-peers.json may
// carry `"entries": { "ui": ["@mui/material"] }`: peers that ONLY the files of
// that entry (and the same entry of the slices it depends on) may import. The
// slice's own `peers` are what every file of it may import, so a host that
// installs only the headless entry installs none of the entries' peers; they
// are optional in package.json even when the slice is universal. App installs
// (rule 5) follow the entry the app imports (`@marinoscar/kvox-web/core/ui`).
//
// Usage: node scripts/kvox-packages/check-slice-peers.mjs [--root <dir>]
//          [--app <dir>]... [--without <package>]... [--table] [--json]
//   --root <dir>   Repository root (default: this script's grandparent).
//   --app <dir>    Also run rule 5 for this app folder (repeatable), relative
//                  to the root, e.g. --app apps/api --app apps/web. Without
//                  --app only rules 1 to 4 and 6 run.
//   --without <package>
//                  Rule 5 does not require this peer of the --app folders
//                  (repeatable). See rule 5.
//   --table        Print the required and optional peers per slice and exit.
//   --json         Print the violations as JSON.
// Exit: 0 clean, 1 violations, 2 usage error.
//
// Node built-ins only. Importing this module runs nothing.
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Folder-name prefix of the packages this script checks (`packages/kvox-*`). */
export const PREFIX = 'kvox-';
/** npm scope of the packages. */
export const SCOPE = '@marinoscar/';
/** Slice graph, relative to the root. */
export const SLICES_FILE = 'packages/kvox-slices.json';
/** Per-slice peers, relative to the root. */
export const PEERS_FILE = 'packages/kvox-slice-peers.json';
/** Packages whose `src/` may not import the platform (rule 6). */
export const HOST_NEUTRAL_PACKAGES = Object.freeze(['kvox-api', 'kvox-web', 'kvox-ai']);
/**
 * The platform specifiers a host-neutral package may import anyway, matched
 * EXACTLY (rule 6). `kvox-ai` implements the model port over the provider-adapter
 * types and classes of `@marinoscar/platform-api/ai` (issue #579) until the lean
 * adapter package (#578) replaces that peer; nothing else of the platform.
 */
export const HOST_NEUTRAL_ALLOWED = Object.freeze({
  'kvox-ai': Object.freeze(['@marinoscar/platform-api/ai']),
});
/** Specifier prefix rule 6 forbids. */
export const PLATFORM_PREFIX = '@marinoscar/platform-';

const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|tsx)$/;
const BUILTINS = new Set(builtinModules);
const toPosix = (p) => p.split(sep).join('/');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Reading the repository
// -----------------------------------------------------------------------------

/** `{ dir: 'kvox-api', name: '@marinoscar/kvox-api', manifest }` for every package folder. */
export function listPackages(root) {
  const packagesDir = join(root, 'packages');
  if (!isDirectory(packagesDir)) return [];
  const out = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    if (!dir.startsWith(PREFIX)) continue;
    const manifestPath = join(packagesDir, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    out.push({ dir, name: manifest.name ?? `${SCOPE}${dir}`, manifest });
  }
  return out;
}

/** Folder names directly under `packages/<dir>/src`. */
export function sliceFolders(root, dir) {
  const src = join(root, 'packages', dir, 'src');
  if (!isDirectory(src)) return [];
  return readdirSync(src)
    .filter((entry) => isDirectory(join(src, entry)))
    .sort();
}

/** Every `.ts` / `.tsx` file under `dir`, as absolute paths. */
export function sourceFiles(dir) {
  if (!isDirectory(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (isDirectory(full)) out.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.test(entry)) out.push(full);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Imports
// -----------------------------------------------------------------------------

/**
 * Removes block and line comments so an `import` quoted in TSDoc is not an
 * import. A `//` counts as a comment only at the start of a line or after
 * whitespace, which keeps `https://...` inside a string intact.
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

const IMPORT_PATTERNS = [
  // import x from 'y' / import { x } from 'y' / export * from 'y' / export { x } from 'y'
  /\b(?:import|export)\s[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  // import 'y' (a statement of its own: a string literal that merely CONTAINS the word,
  // such as the enum member `'import'` in a wire schema, is not one)
  /(?:^|[;{}])[ \t]*\bimport\s*['"]([^'"\n]+)['"]/gm,
  // import('y') and require('y')
  /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

/** Every module specifier a source text imports, in order of appearance, without duplicates. */
export function importSpecifiers(source) {
  const text = stripComments(source);
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; a relative path or built-in -> null. */
export function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTINS.has(name) ? null : name;
}

// -----------------------------------------------------------------------------
// The slice data
// -----------------------------------------------------------------------------

/** The data keys that are not packages. */
const isMeta = (key) => key.startsWith('$');

/** The slice graph: `{ 'kvox-api': { core: ['ports'] } }`. */
export function readGraph(root) {
  const raw = readJson(join(root, SLICES_FILE));
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !isMeta(key)));
}

/** The peers file: `{ universal, implies, reserved, hostOnly, slices }`. */
export function readPeers(root) {
  const raw = readJson(join(root, PEERS_FILE));
  return {
    universal: raw.$universal ?? {},
    implies: raw.$implies ?? {},
    reserved: raw.$reserved ?? {},
    hostOnly: raw.$hostOnly ?? {},
    slices: Object.fromEntries(Object.entries(raw).filter(([key]) => !isMeta(key))),
  };
}

/** The slice and every slice it depends on, transitively (cycle-safe). */
export function sliceClosure(graph, pkg, slice) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of graph[pkg]?.[name] ?? []) visit(dep);
  };
  visit(slice);
  return seen;
}

/** The packages a slice's own entry lists. */
function ownPeers(peers, pkg, slice) {
  return peers.slices[pkg]?.[slice]?.peers ?? [];
}

/** The extra packages only the files of `entry` of a slice may import. */
function entryPeers(peers, pkg, slice, entry) {
  return peers.slices[pkg]?.[slice]?.entries?.[entry] ?? [];
}

/** Every entry name a slice declares extra peers for. */
function entryNames(peers, pkg, slice) {
  return Object.keys(peers.slices[pkg]?.[slice]?.entries ?? {});
}

/**
 * The packages a slice needs: its own and those of the slices it depends on.
 * With `entry`, also the extra peers of that entry in each of those slices.
 */
export function closurePeers(graph, peers, pkg, slice, entry = null) {
  const out = new Set();
  for (const name of sliceClosure(graph, pkg, slice)) {
    for (const peer of ownPeers(peers, pkg, name)) out.add(peer);
    if (entry !== null) for (const peer of entryPeers(peers, pkg, name, entry)) out.add(peer);
  }
  return out;
}

/** `peerSet` plus everything `$implies` says comes with it, transitively. */
export function withImplied(peerSet, implies) {
  const out = new Set(peerSet);
  const queue = [...peerSet];
  while (queue.length > 0) {
    for (const implied of implies[queue.pop()] ?? []) {
      if (!out.has(implied)) {
        out.add(implied);
        queue.push(implied);
      }
    }
  }
  return out;
}

/** The slices a consumer always gets: `$universal`, with "*" meaning every declared slice. */
export function universalSlices(graph, peers, pkg) {
  const declared = Object.keys(graph[pkg] ?? {});
  const value = peers.universal[pkg];
  return value === '*' ? declared : (value ?? []);
}

/** `{ required: Set, optional: Set }` peers of a package, from the data. */
export function packagePeers(graph, peers, pkg) {
  const required = new Set();
  for (const slice of universalSlices(graph, peers, pkg)) {
    for (const peer of closurePeers(graph, peers, pkg, slice)) required.add(peer);
  }
  const optional = new Set();
  for (const slice of Object.keys(graph[pkg] ?? {})) {
    for (const peer of ownPeers(peers, pkg, slice)) if (!required.has(peer)) optional.add(peer);
    for (const entry of entryNames(peers, pkg, slice)) {
      // An entry's peers are never required: a host that uses only the other
      // entries (headless) must not have to install them.
      for (const peer of entryPeers(peers, pkg, slice, entry)) if (!required.has(peer)) optional.add(peer);
    }
  }
  for (const peer of [...(peers.reserved[pkg] ?? []), ...(peers.hostOnly[pkg] ?? [])]) {
    if (!required.has(peer)) optional.add(peer);
  }
  return { required, optional };
}

// -----------------------------------------------------------------------------
// The rules
// -----------------------------------------------------------------------------

function findCycle(slices) {
  const state = new Map();
  const path = [];
  const visit = (name) => {
    if (state.get(name) === 'done') return null;
    if (state.get(name) === 'visiting') return [...path.slice(path.indexOf(name)), name];
    state.set(name, 'visiting');
    path.push(name);
    for (const dep of slices[name] ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(name, 'done');
    return null;
  };
  for (const name of Object.keys(slices)) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

/** Rules 1 and 2. */
function checkData(root, packages, graph, peers, violations) {
  const add = (rule, message) => violations.push({ rule, message });
  const dirs = new Set(packages.map((p) => p.dir));
  for (const pkg of Object.keys(graph)) {
    if (!dirs.has(pkg)) add('graph', `${SLICES_FILE} lists '${pkg}' but packages/${pkg}/package.json does not exist`);
  }
  for (const { dir } of packages) {
    const slices = graph[dir];
    if (!slices) {
      add('graph', `packages/${dir} has no entry in ${SLICES_FILE}`);
      continue;
    }
    for (const [slice, deps] of Object.entries(slices)) {
      for (const dep of deps) {
        if (!(dep in slices)) add('graph', `${dir}/${slice} depends on '${dep}', which ${SLICES_FILE} does not declare for ${dir}`);
      }
    }
    const cycle = findCycle(slices);
    if (cycle) add('graph', `${dir} has a slice cycle: ${cycle.join(' -> ')}`);
    for (const folder of sliceFolders(root, dir)) {
      if (!(folder in slices)) add('graph', `packages/${dir}/src/${folder}/ is not a declared slice; add it to ${SLICES_FILE}`);
    }

    const entries = peers.slices[dir] ?? {};
    for (const slice of Object.keys(slices)) {
      if (!(slice in entries)) add('peers-data', `${dir}/${slice} has no entry in ${PEERS_FILE}`);
    }
    for (const slice of Object.keys(entries)) {
      if (!(slice in slices)) add('peers-data', `${PEERS_FILE} has an entry for ${dir}/${slice}, which ${SLICES_FILE} does not declare`);
    }
    const universal = peers.universal[dir];
    if (universal === undefined) add('peers-data', `${PEERS_FILE} has no $universal entry for ${dir}`);
    else if (universal !== '*') {
      for (const slice of universal) {
        if (!(slice in slices)) add('peers-data', `$universal of ${dir} names '${slice}', which is not a declared slice`);
      }
    }
  }
  for (const key of ['universal', 'reserved', 'hostOnly']) {
    for (const pkg of Object.keys(peers[key])) {
      if (!dirs.has(pkg)) add('peers-data', `$${key} names '${pkg}', which is not a package`);
    }
  }
}

/** Rule 3. */
function checkManifest(packages, graph, peers, violations) {
  const add = (message) => violations.push({ rule: 'manifest', message });
  for (const { dir, manifest } of packages) {
    if (!graph[dir]) continue;
    const declared = manifest.peerDependencies ?? {};
    const optionalInManifest = new Set(
      Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([, meta]) => meta?.optional === true)
        .map(([name]) => name)
    );
    const { required, optional } = packagePeers(graph, peers, dir);
    const where = `packages/${dir}/package.json`;
    for (const peer of required) {
      if (!(peer in declared)) add(`${where}: peer '${peer}' is required by a universal slice but is not in peerDependencies`);
      else if (optionalInManifest.has(peer)) add(`${where}: peer '${peer}' is required by a universal slice but marked optional in peerDependenciesMeta`);
    }
    for (const peer of optional) {
      if (!(peer in declared)) add(`${where}: optional peer '${peer}' (${PEERS_FILE}) is not in peerDependencies`);
      else if (!optionalInManifest.has(peer)) add(`${where}: peer '${peer}' is needed only by non-universal slices (or reserved, or host-only) and must be optional in peerDependenciesMeta`);
    }
    for (const peer of Object.keys(declared)) {
      if (!required.has(peer) && !optional.has(peer)) {
        add(`${where}: peer '${peer}' is in no slice, $reserved or $hostOnly entry of ${PEERS_FILE}`);
      }
    }
    for (const peer of peers.hostOnly[dir] ?? []) {
      for (const slice of Object.keys(graph[dir])) {
        if (ownPeers(peers, dir, slice).includes(peer)) {
          add(`${PEERS_FILE}: ${dir}/${slice} lists the host-only peer '${peer}'; no slice may import it`);
        }
      }
    }
  }
}

/** Rule 4. */
function checkImports(root, packages, graph, peers, violations) {
  for (const { dir, manifest } of packages) {
    if (!graph[dir]) continue;
    const src = join(root, 'packages', dir, 'src');
    const runtimeDeps = new Set(Object.keys(manifest.dependencies ?? {}));
    const allPeers = new Set([...Object.keys(manifest.peerDependencies ?? {})]);
    for (const file of sourceFiles(src)) {
      const rel = toPosix(relative(src, file));
      const top = rel.split('/')[0];
      const isRootFile = !rel.includes('/');
      const slice = isRootFile ? null : top;
      // The entry folder (headless, ui, testing) of a file two levels down.
      const entry = isRootFile || rel.split('/').length < 3 ? null : rel.split('/')[1];
      const allowed = withImplied(
        isRootFile ? allPeers : closurePeers(graph, peers, dir, slice, entry),
        peers.implies
      );
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const name = packageNameOf(specifier);
        if (name === null || runtimeDeps.has(name) || allowed.has(name)) continue;
        violations.push({
          rule: 'imports',
          message: isRootFile
            ? `packages/${dir}/src/${rel} imports '${specifier}', which is not a peer of ${dir}`
            : `packages/${dir}/src/${rel} imports '${specifier}', but slice '${slice}'${entry ? ` (entry '${entry}')` : ''} (and the slices it depends on) list no peer '${name}' in ${PEERS_FILE}`,
        });
      }
    }
  }
}

/** Rule 6. */
function checkHostNeutral(root, violations) {
  for (const pkg of HOST_NEUTRAL_PACKAGES) {
    const src = join(root, 'packages', pkg, 'src');
    const allowed = HOST_NEUTRAL_ALLOWED[pkg] ?? [];
    for (const file of sourceFiles(src)) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith(PLATFORM_PREFIX) && !allowed.includes(specifier)) {
          violations.push({
            rule: 'host-neutral',
            message:
              allowed.length > 0
                ? `${toPosix(relative(root, file))} imports '${specifier}'. A ${pkg} slice may import only ${allowed.map((a) => `'${a}'`).join(', ')} of @marinoscar/platform-*: anything else would not install on Desktop.`
                : `${toPosix(relative(root, file))} imports '${specifier}'. A ${pkg} slice must not import @marinoscar/platform-*: it would not install on Desktop. Bind the platform in apps/api/src/platform-kvox (or the web app) behind a port instead.`,
          });
        }
      }
    }
  }
}

/** Rule 7. */
function checkHeadless(root, violations) {
  const src = join(root, 'packages', 'kvox-web', 'src');
  for (const file of sourceFiles(src)) {
    const rel = toPosix(relative(src, file));
    const parts = rel.split('/');
    if (parts.length < 3 || parts[1] !== 'headless') continue;
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      const name = packageNameOf(specifier);
      const forbidden =
        name !== null &&
        (name.startsWith('@mui/') || name.startsWith('@emotion/') || name.startsWith('react-router'));
      const intoUi = specifier.startsWith('.') && /(^|\/)ui(\/|$)/.test(specifier);
      if (forbidden || intoUi) {
        violations.push({
          rule: 'headless',
          message: `packages/kvox-web/src/${rel} imports '${specifier}'. A headless entry imports no @mui/*, @emotion/*, router or ui/ folder: a host with another design system builds its own UI on it.`,
        });
      }
    }
  }
}

/** Rule 5. */
function checkApps(root, apps, packages, graph, peers, violations, without = new Set()) {
  const rootManifest = existsSync(join(root, 'package.json')) ? readJson(join(root, 'package.json')) : {};
  const depNames = (manifest) =>
    new Set(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
        Object.keys(manifest?.[field] ?? {})
      )
    );
  const byName = new Map(packages.map((p) => [p.name, p]));
  for (const app of apps) {
    const appDir = resolve(root, app);
    const manifestPath = join(appDir, 'package.json');
    if (!existsSync(manifestPath)) {
      violations.push({ rule: 'app-installs', message: `${app}/package.json does not exist` });
      continue;
    }
    const installed = new Set([...depNames(readJson(manifestPath)), ...depNames(rootManifest)]);
    const needed = new Map();
    const need = (name, why) => {
      if (!needed.has(name)) needed.set(name, why);
    };
    for (const file of sourceFiles(join(appDir, 'src'))) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const name = packageNameOf(specifier);
        const pkg = name ? byName.get(name) : undefined;
        if (!pkg) continue;
        const rest = specifier.slice(name.length + 1);
        const slices = rest === '' ? universalSlices(graph, peers, pkg.dir) : [rest.split('/')[0]];
        // `@marinoscar/kvox-web/core/ui`: the second segment is the entry.
        const entry = rest.split('/')[1] ?? null;
        need(name, `imported by ${toPosix(relative(root, file))}`);
        for (const slice of slices) {
          if (!(slice in (graph[pkg.dir] ?? {}))) continue;
          for (const peer of closurePeers(graph, peers, pkg.dir, slice, entry)) {
            need(peer, `needed by ${name}/${slice} (imported by ${toPosix(relative(root, file))})`);
          }
        }
      }
    }
    for (const [name, why] of needed) {
      if (without.has(name)) continue;
      if (!installed.has(name)) violations.push({ rule: 'app-installs', message: `${app}/package.json does not list '${name}' (${why})` });
    }
  }
}

/**
 * Runs the rules.
 *
 * @param {{ root: string, apps?: string[], without?: string[] }} options Repository root, the app folders for rule 5 and
 *   the peers rule 5 does not require of them (features the app switched off).
 * @returns {{ rule: string, message: string }[]} The violations (empty when clean).
 */
export function checkSlicePeers({ root, apps = [], without = [] }) {
  const violations = [];
  const packages = listPackages(root);
  const graph = readGraph(root);
  const peers = readPeers(root);
  checkData(root, packages, graph, peers, violations);
  checkManifest(packages, graph, peers, violations);
  checkImports(root, packages, graph, peers, violations);
  checkHostNeutral(root, violations);
  checkHeadless(root, violations);
  if (apps.length > 0) checkApps(root, apps, packages, graph, peers, violations, new Set(without));
  return violations;
}

/** A text table of the required and optional peers per slice, for the READMEs. */
export function peersTable(root) {
  const packages = listPackages(root);
  const graph = readGraph(root);
  const peers = readPeers(root);
  const lines = [];
  for (const { dir, name } of packages) {
    if (!graph[dir]) continue;
    const { required, optional } = packagePeers(graph, peers, dir);
    lines.push(`${name}`);
    lines.push(`  required: ${[...required].sort().join(', ') || '(none)'}`);
    lines.push(`  optional: ${[...optional].sort().join(', ') || '(none)'}`);
    for (const slice of Object.keys(graph[dir])) {
      const all = [...closurePeers(graph, peers, dir, slice)].sort();
      lines.push(`  ${slice}: ${all.join(', ') || '(none)'}`);
      for (const entry of entryNames(peers, dir, slice)) {
        const extra = [...closurePeers(graph, peers, dir, slice, entry)].filter((p) => !all.includes(p)).sort();
        lines.push(`  ${slice}/${entry}: + ${extra.join(', ') || '(none)'}`);
      }
    }
  }
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Command line
// -----------------------------------------------------------------------------

const USAGE =
  'Usage: node scripts/kvox-packages/check-slice-peers.mjs [--root <dir>] [--app <dir>]... [--without <package>]... [--table] [--json]';

function parseArgs(argv) {
  const opts = { root: null, apps: [], without: [], table: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--table') opts.table = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--root' || arg === '--app' || arg === '--without') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      if (arg === '--app') opts.apps.push(value);
      else if (arg === '--without') opts.without.push(value);
      else opts.root = value;
      i += 1;
    } else throw new Error(`unknown argument '${arg}'`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`check-slice-peers: ${err.message}\n${USAGE}`);
    process.exit(2);
  }
  const root = resolve(opts.root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  if (!existsSync(join(root, SLICES_FILE)) || !existsSync(join(root, PEERS_FILE))) {
    console.error(`check-slice-peers: ${SLICES_FILE} and ${PEERS_FILE} must exist under ${root}`);
    process.exit(2);
  }
  if (opts.table) {
    console.log(peersTable(root));
    return;
  }
  const violations = checkSlicePeers({ root, apps: opts.apps, without: opts.without });
  if (opts.json) console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
  else if (violations.length === 0) {
    const scope = opts.apps.length > 0 ? `, apps ${opts.apps.join(', ')}` : '';
    console.log(`Slice peers check passed (${listPackages(root).length} packages${scope}).`);
  } else {
    for (const { rule, message } of violations) console.error(`[${rule}] ${message}`);
    console.error(`\nSlice peers check FAILED: ${violations.length} violation${violations.length === 1 ? '' : 's'}. Rules: docs/PACKAGES.md#peer-dependencies-per-slice`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main();
}

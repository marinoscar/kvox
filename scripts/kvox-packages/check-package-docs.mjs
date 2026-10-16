#!/usr/bin/env node
// =============================================================================
// Documentation check for the @marinoscar/kvox-* packages
// =============================================================================
//
// Modelled on marinoscar/enterpriseappbase (not copied verbatim); the standard
// it enforces is docs/PACKAGES.md.
//
// For every packages/kvox-* package:
//
//   readme-headings   README.md starts with `# @marinoscar/kvox-<pkg>` and has
//                     exactly the fifteen `##` sections of README_HEADINGS, in
//                     that order, each with text under it ("None." is text).
//   readme-status     "Purpose and scope" holds a line starting `Status:`
//                     (`Status: scaffold` until the package is filled).
//   readme-subpaths   The README names every entry point of the `exports` map
//                     (`@marinoscar/kvox-<pkg>/<subpath>`; the root export is
//                     the package name itself).
//   slice-readme      Every slice folder under src/ has a README.md with the
//                     five `##` sections of SLICE_README_HEADINGS, each with text.
//   links             Every relative Markdown link in those READMEs points at a
//                     file or folder that exists (anchors are not checked).
//   typedoc-config    typedoc.json lists one entry point per exported subpath
//                     (`./src/<subpath>/index.ts`, `./src/index.ts` for the
//                     root) and no other.
//   api-reference     docs-api/api.json (from `npm run docs:kvox-packages`)
//                     exists, and every exported top-level declaration of an
//                     entry point carries `@stability stable|experimental|
//                     deprecated`; one tagged `@extensionPoint` is named in the
//                     README's "Extension-point catalog" section.
//
// TypeDoc itself already fails on an undocumented export, a broken `{@link}`
// and a type that is used but not exported (typedoc.base.json).
//
// Usage: node scripts/kvox-packages/check-package-docs.mjs [--root <dir>]
// Exit: 0 clean, 1 violations, 2 usage error.
//
// Node built-ins only. Importing this module runs nothing.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { listPackages, sliceFolders } from './check-slice-peers.mjs';

/** The `##` sections of a package README, in order. */
export const README_HEADINGS = Object.freeze([
  'Purpose and scope',
  'Install and peer dependencies',
  'Quick start',
  'Configuration',
  'Extension-point catalog',
  'Data',
  'Permissions and settings',
  'UI',
  'Infra',
  'Observability',
  'Security notes',
  'Conformance suite',
  'Upgrade notes',
  'Troubleshooting',
  'Links',
]);

/** The `##` sections of a slice README, in order. */
export const SLICE_README_HEADINGS = Object.freeze([
  'Purpose and scope',
  'Entry point',
  'Peer dependencies',
  'Configuration',
  'Extension-point catalog',
]);

/** Values of the `@stability` tag. */
export const STABILITY_VALUES = Object.freeze(['stable', 'experimental', 'deprecated']);

const TYPEDOC_KIND_MODULE = 2;

/** Splits Markdown into `{ title, sections: [{ heading, body }] }` at `#` and `##` lines outside code fences. */
export function parseMarkdown(text) {
  let title = null;
  const sections = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h1 = !inFence && /^#\s+(.+?)\s*$/.exec(line);
    const h2 = !inFence && /^##\s+(.+?)\s*$/.exec(line);
    if (h1 && title === null) title = h1[1];
    else if (h2) sections.push({ heading: h2[1], body: '' });
    else if (sections.length > 0) sections[sections.length - 1].body += `${line}\n`;
  }
  return { title, sections };
}

/** Problems with a README's `##` sections against `expected`. */
export function checkSections(parsed, expected, where, rule) {
  const problems = [];
  const found = parsed.sections.map((s) => s.heading);
  for (const heading of expected) {
    if (!found.includes(heading)) problems.push({ rule, message: `${where}: missing section '## ${heading}'` });
  }
  for (const heading of found) {
    if (!expected.includes(heading)) problems.push({ rule, message: `${where}: unexpected section '## ${heading}' (the standard has no such heading; use '###' under a standard section)` });
  }
  const order = found.filter((h) => expected.includes(h));
  const wanted = expected.filter((h) => found.includes(h));
  if (order.join('\n') !== wanted.join('\n')) problems.push({ rule, message: `${where}: sections are out of order; expected ${expected.join(' > ')}` });
  for (const section of parsed.sections) {
    if (expected.includes(section.heading) && section.body.trim() === '') {
      problems.push({ rule, message: `${where}: section '## ${section.heading}' is empty (write "None." and why, if there is nothing to say)` });
    }
  }
  return problems;
}

/** Relative Markdown links `[text](path)` outside code fences; `{ target }` without anchor or query. */
export function relativeLinks(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) continue;
      out.push(target.split('#')[0].split('?')[0]);
    }
  }
  return out.filter((t) => t !== '');
}

/** The exports keys that are entry points (everything but `./package.json`). */
export function entryKeys(manifest) {
  return Object.keys(manifest.exports ?? {}).filter((key) => key !== './package.json');
}

/**
 * The entry points that are compiled code: an `exports` value that is an object
 * of conditions (`import`/`require`). A plain string target is a data file the
 * package ships as-is (the contract's `./schemas/transcript-export.v1.json`):
 * the README must name it, but TypeDoc has no source entry for it.
 */
export function codeEntryKeys(manifest) {
  return entryKeys(manifest).filter((key) => typeof manifest.exports[key] !== 'string');
}

/** `.` -> `./src/index.ts`; `./core` -> `./src/core/index.ts`; `./a/b` -> `./src/a/b/index.ts`. */
export function entrySourcePath(key) {
  return key === '.' ? './src/index.ts' : `./src/${key.slice(2)}/index.ts`;
}

const tagText = (tag) => (tag.content ?? []).map((part) => part.text ?? '').join('').trim();

/** Top-level exported declarations of an api.json: the module children, or the root's when there is one entry point. */
export function topLevelDeclarations(api) {
  const children = api.children ?? [];
  const modules = children.filter((c) => c.kind === TYPEDOC_KIND_MODULE);
  if (modules.length === 0) return [{ entry: api.name, declarations: children }];
  return modules.map((m) => ({ entry: m.name, declarations: m.children ?? [] }));
}

/**
 * Checks one package. Returns `{ rule, message }[]`.
 *
 * @param {{ root: string, dir: string, manifest: object }} pkg The package.
 */
export function checkPackageDocs({ root, dir, manifest }) {
  const problems = [];
  const name = `@marinoscar/${dir}`;
  const folder = join(root, 'packages', dir);
  const add = (rule, message) => problems.push({ rule, message });

  // README
  const readmePath = join(folder, 'README.md');
  let readmeText = '';
  if (!existsSync(readmePath)) add('readme-headings', `packages/${dir}/README.md does not exist`);
  else {
    readmeText = readFileSync(readmePath, 'utf8');
    const parsed = parseMarkdown(readmeText);
    if (parsed.title !== name) add('readme-headings', `packages/${dir}/README.md: first heading is '# ${parsed.title}', expected '# ${name}'`);
    problems.push(...checkSections(parsed, README_HEADINGS, `packages/${dir}/README.md`, 'readme-headings'));
    const purpose = parsed.sections.find((s) => s.heading === 'Purpose and scope');
    if (purpose && !/^Status:\s*\S/m.test(purpose.body)) add('readme-status', `packages/${dir}/README.md: 'Purpose and scope' has no line starting 'Status:'`);
    for (const key of entryKeys(manifest)) {
      const specifier = key === '.' ? name : `${name}/${key.slice(2)}`;
      if (!readmeText.includes(specifier)) add('readme-subpaths', `packages/${dir}/README.md never mentions the entry point '${specifier}'`);
    }
    for (const target of relativeLinks(readmeText)) {
      if (!existsSync(resolve(folder, target))) add('links', `packages/${dir}/README.md links to '${target}', which does not exist`);
    }
  }

  // Slice READMEs
  for (const slice of sliceFolders(root, dir)) {
    const path = join(folder, 'src', slice, 'README.md');
    const where = `packages/${dir}/src/${slice}/README.md`;
    if (!existsSync(path)) {
      add('slice-readme', `${where} does not exist`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    problems.push(...checkSections(parseMarkdown(text), SLICE_README_HEADINGS, where, 'slice-readme'));
    for (const target of relativeLinks(text)) {
      if (!existsSync(resolve(dirname(path), target))) add('links', `${where} links to '${target}', which does not exist`);
    }
  }

  // typedoc.json
  const typedoc = parseJsonWithComments(join(folder, 'typedoc.json'));
  if (!typedoc) add('typedoc-config', `packages/${dir}/typedoc.json does not exist or does not parse`);
  else {
    const configured = new Set((typedoc.entryPoints ?? []).map((p) => p.replace(/^\.\//, '')));
    const wanted = new Set(codeEntryKeys(manifest).map((key) => entrySourcePath(key).replace(/^\.\//, '')));
    for (const path of wanted) if (!configured.has(path)) add('typedoc-config', `packages/${dir}/typedoc.json has no entry point '${path}' for an exported subpath`);
    for (const path of configured) if (!wanted.has(path)) add('typedoc-config', `packages/${dir}/typedoc.json lists '${path}', which no exports entry points at`);
  }

  // api.json
  const apiPath = join(folder, 'docs-api', 'api.json');
  if (!existsSync(apiPath)) add('api-reference', `packages/${dir}/docs-api/api.json does not exist; run 'npm run docs:kvox-packages' first`);
  else {
    const api = JSON.parse(readFileSync(apiPath, 'utf8'));
    const catalog = parseMarkdown(readmeText).sections.find((s) => s.heading === 'Extension-point catalog')?.body ?? '';
    for (const { entry, declarations } of topLevelDeclarations(api)) {
      for (const declaration of declarations) {
        // A function's comment sits on its first signature, not on the declaration.
        const comment = declaration.comment ?? declaration.signatures?.[0]?.comment;
        const tags = comment?.blockTags ?? [];
        const stability = tags.find((t) => t.tag === '@stability');
        const label = `packages/${dir} ${entry}: '${declaration.name}'`;
        if (!stability) add('api-reference', `${label} has no @stability tag`);
        else if (!STABILITY_VALUES.includes(tagText(stability))) add('api-reference', `${label} has '@stability ${tagText(stability)}'; expected one of ${STABILITY_VALUES.join(', ')}`);
        if (tags.some((t) => t.tag === '@extensionPoint') && !catalog.includes(declaration.name)) {
          add('api-reference', `${label} is an @extensionPoint but the README's 'Extension-point catalog' never names it`);
        }
      }
    }
  }
  return problems;
}

/** typedoc.json allows comments; strip them before parsing. */
function parseJsonWithComments(path) {
  try {
    const text = readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Checks every package under root. */
export function checkAllPackageDocs(root) {
  return listPackages(root).flatMap((pkg) =>
    checkPackageDocs({ root, ...pkg }).map((p) => ({ package: `@marinoscar/${pkg.dir}`, ...p }))
  );
}

function main() {
  const argv = process.argv.slice(2);
  let root = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1] !== undefined) {
      root = argv[i + 1];
      i += 1;
    } else {
      console.error(`check-package-docs: unknown argument '${argv[i]}'\nUsage: node scripts/kvox-packages/check-package-docs.mjs [--root <dir>]`);
      process.exit(2);
    }
  }
  const repoRoot = resolve(root ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
  const count = listPackages(repoRoot).length;
  if (count === 0) {
    console.error('check-package-docs: no packages/kvox-* package found');
    process.exit(2);
  }
  const violations = checkAllPackageDocs(repoRoot);
  if (violations.length === 0) {
    console.log(`Package docs check passed (${count} packages).`);
    process.exit(0);
  }
  for (const { rule, message } of violations) console.error(`[${rule}] ${message}`);
  console.error(`\nPackage docs check FAILED: ${violations.length} problem${violations.length === 1 ? '' : 's'}. The standard: docs/PACKAGES.md`);
  process.exit(1);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main();
}

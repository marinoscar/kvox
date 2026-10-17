import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { KvoxWebHost } from '../headless/host.js';

// =============================================================================
// describeKvoxWebConformance
// =============================================================================
//
// The executable proof that a binding of `KvoxWebHost` is complete and that the
// package keeps its own rules. Test-runner neutral: the caller hands over
// `describe`, `it` and `expect`, so it runs under Vitest and Jest.
//
//   kvox-web.host-neutral  A static scan of the package sources: no file imports
//                          a platform package; no `*/headless` file
//                          imports `@mui/*`, `@emotion/*` or `react-router-dom`,
//                          or reaches into a `*/ui` folder. Needs `srcDir`.
//   kvox-web.host          The shape of a host: every port present, links that
//                          return paths, a viewer that is null or has a
//                          permission set. Needs `createHost`.
// =============================================================================

/**
 * The test runner's functions. When omitted, the globals are used.
 *
 * @stability experimental
 */
export interface KvoxWebConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: () => void | Promise<void>): void;
  /** Starts an assertion. */
  expect(actual: unknown): KvoxWebExpectation;
}

/**
 * The assertions the suites use.
 *
 * @stability experimental
 */
export interface KvoxWebExpectation {
  /** Deep equality. */
  toEqual(expected: unknown): void;
  /** Truthiness. */
  toBeTruthy(): void;
  /** Strict equality. */
  toBe(expected: unknown): void;
}

/**
 * Options of {@link describeKvoxWebConformance}.
 *
 * @stability experimental
 */
export interface KvoxWebConformanceOptions {
  /** Absolute path of `packages/kvox-web/src`, for the `kvox-web.host-neutral` suite. */
  srcDir?: string;
  /** Builds the host under test, for the `kvox-web.host` suite. */
  createHost?: () => KvoxWebHost;
}

// Assembled, not written out: the repository greps the sources for the literal
// to prove no file imports the platform, and this file would be the one match.
const PLATFORM_PREFIX = `@marinoscar/${'platform'}-`;

const IMPORT_RE =
  /(?:\bimport|\bexport)\s[^;'"`]*?\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules') return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * Violations of the host-neutral rules in a package source tree.
 *
 * @param srcDir - Absolute path of `packages/kvox-web/src`.
 * @returns One human-readable line per violation (empty when clean).
 *
 * @stability experimental
 */
export function scanKvoxWebSources(srcDir: string): string[] {
  const problems: string[] = [];
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file).split(sep).join('/');
    const parts = rel.split('/');
    const inHeadless = parts.length >= 3 && parts[1] === 'headless';
    const text = stripComments(readFileSync(file, 'utf8'));
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? '';
      if (specifier.startsWith(PLATFORM_PREFIX)) {
        problems.push(`${rel} imports ${specifier}: a kvox-web file must not depend on the platform`);
      }
      if (!inHeadless) continue;
      if (/^@mui\//.test(specifier) || /^@emotion\//.test(specifier)) {
        problems.push(`${rel} imports ${specifier}: a headless entry imports no MUI or Emotion module`);
      }
      if (specifier === 'react-router-dom' || specifier.startsWith('react-router')) {
        problems.push(`${rel} imports ${specifier}: a headless entry imports no router`);
      }
      if (specifier.startsWith('.') && /(^|\/)ui(\/|$)/.test(specifier)) {
        problems.push(`${rel} imports ${specifier}: a headless entry never reaches into a ui folder`);
      }
    }
  }
  return problems;
}

/**
 * Registers the web conformance suites.
 *
 * @param harness - `describe`, `it` and `expect` of the caller's runner.
 * @param options - What to scan and how to build the host.
 *
 * @stability experimental
 */
export function describeKvoxWebConformance(
  harness: KvoxWebConformanceHarness,
  options: KvoxWebConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  if (options.srcDir !== undefined) {
    const { srcDir } = options;
    describe('kvox-web.host-neutral', () => {
      it('no file imports a platform package, and no headless entry imports MUI, Emotion, a router or a ui folder', () => {
        expect(scanKvoxWebSources(srcDir)).toEqual([]);
      });
    });
  }

  if (options.createHost !== undefined) {
    const { createHost } = options;
    describe('kvox-web.host', () => {
      it('provides every port', () => {
        const host = createHost();
        expect(typeof host.http.request === 'function').toBe(true);
        expect(typeof host.http.requestBlob === 'function').toBe(true);
        expect(typeof host.http.postFormData === 'function').toBe(true);
        expect(typeof host.http.requestWithMeta === 'function').toBe(true);
        expect(typeof host.sse.connect === 'function').toBe(true);
        expect(typeof host.sse.post === 'function').toBe(true);
        expect(typeof host.viewer === 'function').toBe(true);
        expect(typeof host.features === 'function').toBe(true);
      });

      it('builds a path for every page a slice links to', () => {
        const { links } = createHost();
        for (const build of [links.transcript, links.note, links.entity, links.conversation]) {
          const path = build('abc');
          expect(typeof path === 'string' && path.startsWith('/') && path.includes('abc')).toBe(true);
        }
      });

      it('answers the viewer with null or a user that holds a permission set', () => {
        const viewer = createHost().viewer();
        expect(viewer === null || (typeof viewer.userId === 'string' && viewer.permissions instanceof Set)).toBe(true);
      });
    });
  }
}

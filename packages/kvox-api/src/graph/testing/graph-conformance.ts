import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { NotFoundException } from '@nestjs/common';

import type { KvoxJobHandler } from '../../ports/index.js';
import { createFakeKvoxAi } from '../../testing/index.js';
import { GraphAccessService } from '../access/graph-access.service.js';
import { buildDigestFactList, type DigestItemFact } from '../brief/brief-facts.js';
import { buildDigestPrompt, DIGEST_RESPONSE_SCHEMA } from '../brief/brief-prompt.js';
import {
  KG_ENTITY_DIGEST_JOB_TYPE,
  KG_GRAPH_LAYOUT_JOB_TYPE,
  KG_MIGRATE_JOB_TYPE,
  KG_PURGE_JOB_TYPE,
  KG_SPEAKER_LINK_JOB_TYPE,
} from '../job-types.js';

// =============================================================================
// The graph conformance suite (issue #496, epic #491)
// =============================================================================
//
// `describeGraphConformance` states, once, the invariants of the connected-knowledge core that a
// host's binding must not break and a fork that changes the slice must keep:
//
//   • the job types and their execution posture: every `kg.*` type the core owns is server-only
//     (no node result members), with the profile pinned in the job-queue spec; the entity digest is
//     the one that spends the owner's own AI key;
//   • `GraphWriteService` is the ONLY code that creates a `kg_entities`, `kg_relations` or `kg_items`
//     row (the deferred `kg_assert_has_evidence` trigger is what refuses an uncited one, and a second
//     writer would route around the service's validation); `kg.migrate` is the one named exception
//     and reshapes rows it already owns;
//   • a `sensitive` PersonFact never leaves the deployment: it is dropped from the brief's fact list
//     before a prompt is built, so a model call never carries its text;
//   • no access answers 404, never 403: a row that is missing and a row another account owns are the
//     same answer, so an id cannot be probed.
//
// The first group reads the handlers the host's binding registered; the rest run the real code over
// fakes, so they hold for any host. The source scan reads the package's own files (TypeScript in a
// checkout, compiled JavaScript when installed) from the folder the suite is imported from.
// =============================================================================

/**
 * The test runner's functions, so the suite runs under Jest or Vitest.
 *
 * @stability experimental
 */
export interface GraphConformanceHarness {
  /** Opens a group of tests. */
  describe(name: string, fn: () => void): void;
  /** Declares one test. */
  it(name: string, fn: (...args: any[]) => any): void;
  /** Starts an assertion. */
  expect(actual: any): any;
}

/**
 * Options of {@link describeGraphConformance}.
 *
 * @stability experimental
 */
export interface GraphConformanceOptions {
  /**
   * The folder holding the `graph`, `graph-extraction` and `graph-rdf` slice folders to scan; the
   * default is the folder the package's slices sit in.
   */
  sourceRoot?: string;
}

/**
 * What the suite needs from a host's binding.
 *
 * @stability experimental
 */
export interface GraphConformanceTarget {
  /** Every job handler the binding registered (the graph types are picked out by name). */
  handlers: readonly KvoxJobHandler[];
}

/** The job types the graph core registers, with the profile each must carry. */
const PINNED_TYPES = [
  { type: KG_SPEAKER_LINK_JOB_TYPE, maxRuntimeMs: 2 * 60_000, maxAttempts: 3 },
  { type: KG_PURGE_JOB_TYPE, maxRuntimeMs: 30 * 60_000, maxAttempts: 1 },
  { type: KG_GRAPH_LAYOUT_JOB_TYPE, maxRuntimeMs: 15 * 60_000, maxAttempts: 2 },
  { type: KG_MIGRATE_JOB_TYPE, maxRuntimeMs: 60 * 60_000, maxAttempts: 3 },
  { type: KG_ENTITY_DIGEST_JOB_TYPE, maxRuntimeMs: 5 * 60_000, maxAttempts: 1 },
] as const;

/** The files allowed to create graph rows, by path relative to the slice folder, without extension. */
const GRAPH_ROW_WRITERS = ['graph/write/graph-write.service'];

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';

const SECRET = 'SECRET-HEALTH-DETAIL-9f31';

/** Every file of the slice folders under `root`, as `{ path, text }`, specs and declarations excluded. */
function sliceSources(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === '__fixtures__' || name === 'testing' || name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|js)$/.test(name) && !/\.(spec|d)\.(ts|js)$/.test(name) && !name.endsWith('.d.ts')) {
        out.push({ path: relative(root, full).split(sep).join('/').replace(/\.(ts|js)$/, ''), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const slice of ['graph', 'graph-extraction', 'graph-rdf']) {
    const dir = join(root, slice);
    if (existsSync(dir)) walk(dir);
  }
  return out;
}

/**
 * Registers the graph conformance suite.
 *
 * @param label - names the binding under test in the report.
 * @param setup - resolves the host's binding (the registered handlers).
 * @param harness - the runner's `describe`, `it` and `expect`.
 * @param options - where to scan for the write-path rule.
 * @stability experimental
 */
export function describeGraphConformance(
  label: string,
  setup: () => Promise<GraphConformanceTarget> | GraphConformanceTarget,
  harness: GraphConformanceHarness,
  options: GraphConformanceOptions = {},
): void {
  const { describe, it, expect } = harness;
  const sourceRoot = options.sourceRoot ?? join(__dirname, '..', '..');

  describe(`graph conformance: ${label}`, () => {
    describe('job types', () => {
      let handlers: readonly KvoxJobHandler[] = [];

      it('resolves the binding', async () => {
        handlers = (await setup()).handlers;
      });

      for (const pinned of PINNED_TYPES) {
        it(`${pinned.type} is registered, server-only, with its pinned profile`, () => {
          const handler = handlers.find((candidate) => candidate.type === pinned.type);

          expect(handler).toBeDefined();
          expect(handler?.nodeResultSchema).toBeUndefined();
          expect(handler?.persistNodeResult).toBeUndefined();
          expect(handler?.profile).toEqual({ maxRuntimeMs: pinned.maxRuntimeMs, maxAttempts: pinned.maxAttempts });
        });
      }

      it('only the entity digest spends the owner\'s AI key', () => {
        const spending = handlers.filter((handler) => handler.type.startsWith('kg.') && handler.usesAi === true);
        const core = spending.filter((handler) => PINNED_TYPES.some((pinned) => pinned.type === handler.type));

        expect(core.map((handler) => handler.type)).toEqual([KG_ENTITY_DIGEST_JOB_TYPE]);
      });
    });

    describe('the write path', () => {
      it('only GraphWriteService creates kg_entities, kg_relations or kg_items rows', () => {
        const sources = sliceSources(sourceRoot);

        expect(sources.length).toBeGreaterThan(50);

        const create = /\.(kgEntity|kgRelation|kgItem)\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/;
        const insert = /INSERT\s+INTO\s+kg_(entities|relations|items)\b/i;
        const offenders = sources
          .filter(({ path }) => !GRAPH_ROW_WRITERS.includes(path))
          .filter(({ text }) => create.test(text) || insert.test(text))
          .map(({ path }) => path);

        expect(offenders).toEqual([]);
      });

      it('the writer is where the rule says it is (a rename must move the allow-list with it)', () => {
        const paths = sliceSources(sourceRoot).map(({ path }) => path);

        for (const writer of GRAPH_ROW_WRITERS) expect(paths).toContain(writer);
      });
    });

    describe('a sensitive PersonFact never leaves the deployment', () => {
      const fact = (over: Partial<DigestItemFact>): DigestItemFact => ({
        kind: 'person_fact',
        title: null,
        statement: 'Sarah prefers written updates',
        status: null,
        occurredAt: null,
        dueAt: null,
        sensitivity: 'business',
        evidenceIds: ['44444444-4444-4444-8444-444444444444'],
        ...over,
      });

      it('is dropped from the digest fact list even when personal facts are allowed', () => {
        const list = buildDigestFactList({
          previous: [],
          items: [fact({}), fact({ statement: SECRET, sensitivity: 'sensitive' })],
          relations: [],
          includePersonalFacts: true,
        });

        expect(list.facts.map((entry) => entry.text).join('\n')).not.toContain(SECRET);
        expect(list.facts).toHaveLength(1);
      });

      it('never reaches a model call: the recording fake AI sees no trace of it', async () => {
        const list = buildDigestFactList({
          previous: [],
          items: [fact({ statement: SECRET, sensitivity: 'sensitive' }), fact({})],
          relations: [],
          includePersonalFacts: true,
        });
        const prompt = buildDigestPrompt({ entity: { label: 'Sarah Chen', type: 'Person' }, facts: list.facts, previousHandles: list.previousHandles });
        const ai = createFakeKvoxAi({ script: { structured: { statements: [] } } });
        const target = await ai.resolveTask({ userId: USER, orgId: null, feature: 'graph.entity_digest' }, 'graph.digest');

        await ai
          .generateStructured(
            { userId: USER, orgId: null, feature: 'graph.entity_digest' },
            {
              target,
              system: prompt.systemPrompt,
              user: prompt.userContent,
              schemaName: 'kg_entity_digest',
              schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never,
              jsonSchema: DIGEST_RESPONSE_SCHEMA,
              maxOutputTokens: 512,
            },
          )
          .catch(() => undefined);

        const sent = JSON.stringify(ai.calls.filter((call) => call.method === 'generateStructured'));

        expect(sent).toContain('written updates');
        expect(sent).not.toContain(SECRET);
      });
    });

    describe('no access answers 404, never 403', () => {
      const accessOver = (row: { ownerId: string; reviewStatus?: string } | null) => {
        const prisma = {
          kgEntity: { findUnique: async () => (row ? { id: ENTITY, reviewStatus: 'accepted', ...row } : null) },
        };

        return new GraphAccessService(prisma as never);
      };

      it('a missing row and another account\'s row are the same NotFoundException', async () => {
        const missing = await accessOver(null).require(USER, 'entity', ENTITY, 'view').catch((error: unknown) => error);
        const foreign = await accessOver({ ownerId: OTHER }).require(USER, 'entity', ENTITY, 'view').catch((error: unknown) => error);

        expect(missing).toBeInstanceOf(NotFoundException);
        expect(foreign).toBeInstanceOf(NotFoundException);
        expect((foreign as NotFoundException).getResponse()).toEqual((missing as NotFoundException).getResponse());
      });

      it('a malformed id is the same answer too', async () => {
        const malformed = await accessOver({ ownerId: USER }).require(USER, 'entity', 'not-a-uuid', 'view').catch((error: unknown) => error);

        expect(malformed).toBeInstanceOf(NotFoundException);
      });

      it('the owner reads their own row', async () => {
        await expect(accessOver({ ownerId: USER }).require(USER, 'entity', ENTITY, 'view')).resolves.toMatchObject({ id: ENTITY });
      });
    });
  });
}

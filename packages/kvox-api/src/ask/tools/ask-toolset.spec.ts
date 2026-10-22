import 'reflect-metadata';

import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { EntityBriefService, EntityDigestEnqueuer, GraphEntitiesService, GraphLayoutEnqueuer, GraphWriteService } from '../../graph/index.js';
import { KVOX_JOBS } from '../../ports/index.js';
import { expectNoUuid, makeCtx, seedEntity, uid } from '../testing/ask-tool-fakes.js';
import { AskToolError } from './ask-tool.js';
import { ASK_TOOL_NAMES, AskToolset, formatZodError, modelReadableError } from './ask-toolset.js';
import { ASK_TOOL_PROVIDERS } from './ask-tool-providers.js';
import { EntityBriefTool } from './entity-brief.tool.js';
import { EvidenceTool } from './evidence.tool.js';
import { GetEntityTool } from './get-entity.tool.js';
import { ListCommitmentsTool } from './list-commitments.tool.js';
import { ListRisksTool } from './list-risks.tool.js';
import { NeighborsTool } from './neighbors.tool.js';
import { SearchTool } from './search.tool.js';
import { TimelineTool } from './timeline.tool.js';

// =============================================================================
// AskToolset (#377): the eight definitions conform to the strict subset, the
// executor turns every model mistake into `ok: false` (never a throw), results
// are compacted to the token budget, and nothing here can write.
// =============================================================================

const ENTITY = uid(1);

/**
 * What the strict structured-output subset forbids that a tool schema could do: an object that is
 * open (`additionalProperties` not false), a property missing from `required`, a bounds keyword.
 */
function strictSchemaViolations(schema: unknown, path = '$'): string[] {
  if (schema === null || typeof schema !== 'object') return [];
  const node = schema as Record<string, unknown>;
  const found: string[] = [];
  const bounds = ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'format'];

  for (const keyword of bounds) if (keyword in node) found.push(`${path}: bounds keyword "${keyword}"`);
  const properties = node.properties as Record<string, unknown> | undefined;
  if (node.type === 'object' || properties) {
    if (node.additionalProperties !== false) found.push(`${path}: additionalProperties must be false`);
    const required = (node.required as string[] | undefined) ?? [];
    for (const key of Object.keys(properties ?? {})) {
      if (!required.includes(key)) found.push(`${path}.${key}: not in required`);
      found.push(...strictSchemaViolations((properties ?? {})[key], `${path}.${key}`));
    }
  }
  if (node.items) found.push(...strictSchemaViolations(node.items, `${path}[]`));

  return found;
}

function build(over: { graphRead?: object; prisma?: object; preferences?: object } = {}) {
  const graphRead = {
    listEntities: jest.fn(async () => ({ items: [], nextCursor: null })),
    getEntity: jest.fn(),
    timeline: jest.fn(),
    ...over.graphRead,
  };
  const prisma = {
    kgEvidence: { findMany: jest.fn(async () => []) },
    kgItem: { findMany: jest.fn(async () => []) },
    transcript: { findMany: jest.fn(async () => []) },
    note: { findMany: jest.fn(async () => []) },
    ...over.prisma,
  };
  const search = {
    search: jest.fn(async () => ({ results: [], nextCursor: null })),
  };
  const visibility = { viewerFor: jest.fn(), transcriptVisibleSql: jest.fn(), run: jest.fn() };
  const tools = {
    search: new SearchTool(graphRead as never, search as never, prisma as never, visibility as never),
    getEntity: new GetEntityTool(graphRead as never, { effectiveSchemaFor: jest.fn() } as never, prisma as never),
    neighbors: new NeighborsTool({ neighborhood: jest.fn() } as never, prisma as never),
    timeline: new TimelineTool(graphRead as never, prisma as never),
    evidence: new EvidenceTool({ listForSubject: jest.fn(async () => []) } as never, prisma as never),
    entityBrief: new EntityBriefTool({ getBrief: jest.fn() } as never, prisma as never),
    listCommitments: new ListCommitmentsTool(prisma as never),
    listRisks: new ListRisksTool(prisma as never, { effectiveSchemaFor: jest.fn() } as never),
  };
  const preferences = { get: jest.fn(async () => ({})), ...over.preferences };
  const toolset = new AskToolset(
    tools.search,
    tools.getEntity,
    tools.neighbors,
    tools.timeline,
    tools.evidence,
    tools.entityBrief,
    tools.listCommitments,
    tools.listRisks,
    preferences as never,
  );
  return { toolset, tools, graphRead, prisma, search };
}

describe('AskToolset.definitions', () => {
  const { toolset } = build();
  const defs = toolset.definitions();

  it('returns exactly the eight tools, in a stable order', () => {
    expect(defs.map((d) => d.name)).toEqual([...ASK_TOOL_NAMES]);
    expect(toolset.definitions()).toEqual(defs);
  });

  it('list_risks keeps its definition (name, filters, enums)', () => {
    const def = defs.find((d) => d.name === 'list_risks')!;
    expect(def.name).toBe('list_risks');
    expect(def.parameters).toMatchSnapshot();
  });

  it.each(defs.map((d) => [d.name, d] as const))('%s is a strict-mode schema', (_name, def) => {
    expect(strictSchemaViolations(def.parameters)).toEqual([]);
    const params = def.parameters as { additionalProperties: unknown; properties: Record<string, unknown>; required: string[] };
    expect(params.additionalProperties).toBe(false);
    expect([...params.required].sort()).toEqual(Object.keys(params.properties).sort());
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.description.length).toBeLessThanOrEqual(1024);
    expect(def.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('every optional (nullable) parameter accepts null and normalises it to undefined', () => {
    const { tools } = build();
    for (const tool of Object.values(tools)) {
      const props = (tool.parameters as { properties: Record<string, { type: unknown }> }).properties;
      const args: Record<string, unknown> = {};
      for (const [key, schema] of Object.entries(props)) {
        const nullable = Array.isArray(schema.type) && schema.type.includes('null');
        args[key] = nullable ? null : key === 'query' ? 'Acme' : 'ent1';
      }
      const parsed = tool.input.safeParse(args);
      expect(parsed.success).toBe(true);
      for (const [key, schema] of Object.entries(props)) {
        if (Array.isArray(schema.type) && schema.type.includes('null')) {
          expect((parsed.data as Record<string, unknown>)[key]).toBeUndefined();
        }
      }
    }
  });
});

describe('AskToolset.execute — model mistakes are ok:false, never thrown', () => {
  it('unknown tool', async () => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'drop_table', '{}');
    expect(out).toEqual({ ok: false, error: expect.stringContaining('Unknown tool "drop_table"'), json: expect.any(String) });
    expect(JSON.parse(out.json)).toEqual({ error: out.ok ? undefined : out.error });
  });

  it.each([
    ['not JSON', '{entity: ent1'],
    ['an array', '[1,2]'],
    ['a string', '"ent1"'],
    ['null', 'null'],
  ])('malformed arguments: %s', async (_label, raw) => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'get_entity', raw);
    expect(out.ok).toBe(false);
    expect(() => JSON.parse(out.json)).not.toThrow();
  });

  it('refuses over-long arguments', async () => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'search', JSON.stringify({ query: 'x'.repeat(9000) }));
    expect(out).toMatchObject({ ok: false, error: 'Arguments are too long.' });
  });

  it('Zod failures name the path, not the value', async () => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'search', JSON.stringify({ query: '', scope: 'everything', limit: 99 }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toMatch(/^Invalid arguments for search: /);
    expect(out.error).toContain('query');
    expect(out.error).not.toContain('everything');
  });

  it('an unregistered handle is a readable error', async () => {
    const { toolset, graphRead } = build();
    const out = await toolset.execute(makeCtx(), 'get_entity', JSON.stringify({ entity: 'ent9' }));
    expect(out).toMatchObject({ ok: false, error: 'Unknown entity reference ent9. Use search first.' });
    expect(graphRead.getEntity).not.toHaveBeenCalled();
  });

  it('a uuid is not a reference', async () => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'get_entity', JSON.stringify({ entity: ENTITY }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/is not a reference/);
  });

  it('a handle of the wrong kind names the kind expected', async () => {
    const { toolset } = build();
    const ctx = makeCtx();
    ctx.handles.register({ kind: 'ev', id: uid(9) });
    const out = await toolset.execute(ctx, 'timeline', JSON.stringify({ entity: 'ev1' }));
    expect(out).toMatchObject({ ok: false, error: 'ev1 is an evidence reference; this parameter takes entN.' });
  });

  it('a read service 404 (merged mid-turn) is ok:false', async () => {
    const { toolset } = build({ graphRead: { getEntity: jest.fn(async () => { throw new NotFoundException('Entity not found'); }) } });
    const ctx = makeCtx();
    seedEntity(ctx, ENTITY);
    const out = await toolset.execute(ctx, 'get_entity', JSON.stringify({ entity: 'ent1' }));
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/no longer available/) });
  });

  it('a genuine bug still throws', async () => {
    const { toolset } = build({ graphRead: { getEntity: jest.fn(async () => { throw new TypeError('boom'); }) } });
    const ctx = makeCtx();
    seedEntity(ctx, ENTITY);
    await expect(toolset.execute(ctx, 'get_entity', JSON.stringify({ entity: 'ent1' }))).rejects.toThrow(TypeError);
  });

  it('accepts an empty argument string as {}', async () => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'list_commitments', '');
    expect(out.ok).toBe(true);
  });
});

describe('AskToolset.execute — results', () => {
  it('serialises an array result as { items, truncated }', async () => {
    const { toolset } = build();
    const out = await toolset.execute(makeCtx(), 'list_commitments', '{}');
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.json)).toEqual({ items: [], truncated: false });
  });

  it('compacts an over-budget result to valid JSON and flags it', async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: uid(100 + i), type: 'Person', label: `Person ${i} ${'x'.repeat(300)}`, aliases: [] }));
    const { toolset } = build({ graphRead: { listEntities: jest.fn(async () => ({ items, nextCursor: null })) } });
    const out = await toolset.execute(makeCtx(), 'search', JSON.stringify({ query: 'Person', scope: 'entities', limit: 10 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const body = JSON.parse(out.json);
    expect(body.truncated).toBe(true);
    expect(out.result.truncated).toBe(true);
    expect(Math.ceil(out.json.length / 3)).toBeLessThanOrEqual(3000);
    expect(body.entities.length).toBeLessThan(40);
    expectNoUuid(out.json);
  });

  it('uses the context’s own token counter when given', async () => {
    const { toolset } = build();
    const countTokens = jest.fn(() => 1);
    await toolset.execute(makeCtx({ countTokens }), 'list_commitments', '{}');
    expect(countTokens).toHaveBeenCalled();
  });
});

describe('AskToolset.createContext', () => {
  it('starts a fresh registry with the §14 opt-in off', async () => {
    const { toolset } = build();
    const user = makeCtx().user;
    const ctx = await toolset.createContext(user, { scopeEntityId: ENTITY });
    expect(ctx.handles.issued().size).toBe(0);
    expect(ctx.personalFactsAllowed).toBe(false);
    expect(ctx.scopeEntityId).toBe(ENTITY);
    expect(ctx.user).toBe(user);
  });
});

describe('modelReadableError / formatZodError', () => {
  it('maps the read layer’s HTTP conventions', () => {
    expect(modelReadableError(new AskToolError('x'))).toBe('x');
    expect(modelReadableError(new BadRequestException({ message: 'Unknown types: Spaceship.' }))).toBe('Unknown types: Spaceship.');
    expect(modelReadableError(new ServiceUnavailableException())).toMatch(/too long/);
    expect(modelReadableError(new Error('bug'))).toBeNull();
  });

  it('keeps at most three issues', () => {
    const { tools } = build();
    const res = tools.neighbors.input.safeParse({ entity: 1, hops: 5, limit: 999, asOf: 'yesterday' });
    expect(res.success).toBe(false);
    if (!res.success) expect(formatZodError(res.error).split('; ').length).toBeLessThanOrEqual(3);
  });
});

describe('read-only by construction', () => {
  const WRITERS = [GraphWriteService, GraphEntitiesService, KVOX_JOBS, EntityDigestEnqueuer, GraphLayoutEnqueuer];

  it.each([AskToolset, ...ASK_TOOL_PROVIDERS].map((c) => [c.name, c] as const))(
    '%s depends on no write service',
    (_name, cls) => {
      const deps: unknown[] = Reflect.getMetadata('design:paramtypes', cls) ?? [];
      for (const writer of WRITERS) expect(deps).not.toContain(writer);
    },
  );

  it('calls the brief without moving the view marker or enqueueing a digest', () => {
    // Asserted per call in entity-brief.tool.spec.ts; here: the brief service is the only brief dependency.
    const deps: unknown[] = Reflect.getMetadata('design:paramtypes', EntityBriefTool) ?? [];
    expect(deps).toContain(EntityBriefService);
  });
});

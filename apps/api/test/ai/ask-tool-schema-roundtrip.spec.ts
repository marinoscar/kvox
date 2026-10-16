// =============================================================================
// Every Ask tool survives the trip to the platform (issue #476, epic #472)
// =============================================================================
//
// `PlatformKvoxAi.chat()` turns each `AskToolset.definitions()` entry into a platform
// `AiFunctionTool` whose `parameters` is `z.fromJSONSchema(def.parameters)`; the
// platform converts that back with `toJsonSchema` for the wire. The tool's own Zod
// `input` is never sent (it uses `.transform`, which JSON Schema cannot express).
// This spec runs all seven tools through the exact pair of calls and pins what must
// stay true for strict function calling:
//
//   * neither call throws;
//   * the object is still closed (`additionalProperties: false`);
//   * every key the tool declares is still `required` (optional ones are nullable);
//   * every enumerated value survives;
//   * every description survives (the bounds ride on them).
//
// It lives under `test/` because it reads Ask code, and `ai-port/` must not import a
// domain directory.
// =============================================================================

import { toJsonSchema } from '@marinoscar/platform-api/ai';

import { clearToolCache, toPlatformTools } from '../../src/ai-port/chat-mapping';
import { ASK_TOOL_NAMES, AskToolset } from '../../src/ask/tools/ask-toolset';
import { EntityBriefTool } from '../../src/ask/tools/entity-brief.tool';
import { EvidenceTool } from '../../src/ask/tools/evidence.tool';
import { GetEntityTool } from '../../src/ask/tools/get-entity.tool';
import { ListCommitmentsTool } from '../../src/ask/tools/list-commitments.tool';
import { NeighborsTool } from '../../src/ask/tools/neighbors.tool';
import { SearchTool } from '../../src/ask/tools/search.tool';
import { TimelineTool } from '../../src/ask/tools/timeline.tool';

type Node = Record<string, unknown>;

/** The collaborators are never called here: only `definitions()` is read. */
const none = {} as never;
const toolset = new AskToolset(
  new SearchTool(none, none, none),
  new GetEntityTool(none, none, none),
  new NeighborsTool(none, none),
  new TimelineTool(none, none),
  new EvidenceTool(none, none),
  new EntityBriefTool(none, none),
  new ListCommitmentsTool(none),
  none,
);

function nodes(root: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(root)) {
    for (const child of root) nodes(child, out);
  } else if (typeof root === 'object' && root !== null) {
    out.push(root as Node);
    for (const child of Object.values(root)) nodes(child, out);
  }
  return out;
}

/** Every enumerated string a schema can take (`enum` members and `const`), sorted. */
function enumeratedValues(root: unknown): string[] {
  const values = new Set<string>();
  for (const node of nodes(root)) {
    if (Array.isArray(node.enum)) for (const value of node.enum) if (typeof value === 'string') values.add(value);
    if (typeof node.const === 'string') values.add(node.const);
  }
  return [...values].sort();
}

function descriptions(root: unknown): string[] {
  return nodes(root)
    .map((node) => node.description)
    .filter((value): value is string => typeof value === 'string')
    .sort();
}

describe('AskToolset definitions through z.fromJSONSchema and toJsonSchema (#476)', () => {
  const definitions = toolset.definitions();

  beforeEach(() => clearToolCache());

  it('covers every tool the toolset lists', () => {
    expect(definitions.map((d) => d.name)).toEqual([...ASK_TOOL_NAMES]);
  });

  it.each(definitions.map((d) => [d.name, d] as const))(
    '%s keeps required, enum and additionalProperties: false',
    (_name, def) => {
      const [tool] = toPlatformTools([def]);
      expect(tool).toMatchObject({ type: 'function', name: def.name, description: def.description, strict: true });

      const back = toJsonSchema(tool.parameters) as Node;
      const original = def.parameters as Node;
      const keys = Object.keys(original.properties as Node).sort();

      expect(back.type).toBe('object');
      expect(back.additionalProperties).toBe(false);
      expect(Object.keys(back.properties as Node).sort()).toEqual(keys);
      // The converter omits an empty `required`; a tool with parameters lists them all.
      expect([...((back.required as string[] | undefined) ?? [])].sort()).toEqual(keys);
      expect(enumeratedValues(back)).toEqual(enumeratedValues(original));
      expect(descriptions(back)).toEqual(descriptions(original));
    },
  );

  it('a model argument set the tool accepts is accepted by the converted schema, and an extra key is not', () => {
    const search = definitions.find((d) => d.name === 'search')!;
    const [tool] = toPlatformTools([search]);

    expect(tool.parameters.safeParse({ query: 'Acme', scope: 'entities', limit: null }).success).toBe(true);
    expect(tool.parameters.safeParse({ query: 'Acme', scope: 'entities', limit: null, extra: 1 }).success).toBe(false);
  });
});

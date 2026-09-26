import { expectNoUuid, makeCtx, seedEntity, uid } from '../../../test/ask/ask-tool-fakes';
import { AskToolError } from './ask-tool';
import { GetEntityTool } from './get-entity.tool';

// =============================================================================
// `get_entity` (#377): attributes by label, sensitivity-filtered by their
// definition, entity_ref values as handles, uuids dropped, counts reshaped.
// =============================================================================

const SARAH = uid(1);
const ACME = uid(2);
const FOREIGN = uid(3);

const attr = (key: string, label: string, over: Record<string, unknown> = {}) => ({
  key,
  label,
  kind: 'text',
  list: false,
  options: null,
  sensitivity: 'business',
  deprecated: false,
  ...over,
});

const schema = {
  entityType: (key: string) =>
    key === 'Person'
      ? {
          attributes: [
            attr('title', 'Job title'),
            attr('u_home000001', 'Home town', { sensitivity: 'personal' }),
            attr('u_health0001', 'Diagnosis', { sensitivity: 'sensitive' }),
            attr('u_employer01', 'Employer', { kind: 'entity_ref' }),
            attr('u_mentors001', 'Mentors', { kind: 'entity_ref', list: true }),
            attr('u_level00001', 'Level', { kind: 'select', options: { choices: [{ value: 'sr', label: 'Senior' }] } }),
            attr('u_external01', 'External id'),
            attr('u_empty00001', 'Empty'),
          ],
        }
      : undefined,
};

function detail(props: Record<string, unknown>) {
  return {
    id: SARAH,
    type: 'Person',
    label: 'Sarah',
    props,
    aliases: [
      { id: uid(10), alias: 'Sarah', source: 'extraction' },
      { id: uid(11), alias: 'S. Chen', source: 'user' },
    ],
    occurredAt: null,
    reviewStatus: 'accepted',
    ontologyVersion: '1.0.0',
    firstSeenAt: '2026-01-02T09:00:00.000Z',
    lastSeenAt: '2026-09-01T09:00:00.000Z',
    counts: { relations: 4, mentions: 3, evidence: 5, items: { commitment: 2, decision: 1, claim: 0, person_fact: 7 }, openCommitments: 1 },
    createdAt: '2026-01-02T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
  };
}

function build(props: Record<string, unknown>) {
  const graphRead = { getEntity: jest.fn(async () => detail(props)) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => schema) };
  const prisma = {
    kgEntity: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes(ACME) ? [{ id: ACME, label: 'Acme', type: 'Organization' }] : [],
      ),
    },
  };
  return { tool: new GetEntityTool(graphRead as never, ontology as never, prisma as never), graphRead, prisma };
}

const PROPS = {
  title: 'CTO',
  u_home000001: 'Lisbon',
  u_health0001: 'something private',
  u_employer01: ACME,
  u_mentors001: [ACME, FOREIGN],
  u_level00001: 'sr',
  u_external01: uid(99),
  u_empty00001: '',
  notInSchema: 'dropped',
};

describe('GetEntityTool', () => {
  it('maps the detail, dropping sensitive and (by default) personal attributes', async () => {
    const { tool, graphRead, prisma } = build(PROPS);
    const ctx = makeCtx();
    const handle = seedEntity(ctx, SARAH, 'Sarah');
    const res = await tool.run(ctx, tool.input.parse({ entity: handle }));
    expect(graphRead.getEntity).toHaveBeenCalledWith(ctx.user, SARAH);
    expect(prisma.kgEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerId: ctx.user.id, mergedIntoId: null }) }),
    );
    expect(res.data).toEqual({
      ref: 'ent1',
      type: 'Person',
      label: 'Sarah',
      aliases: ['S. Chen'],
      attributes: {
        'Job title': 'CTO',
        Employer: { ref: 'ent2', label: 'Acme', type: 'Organization' },
        Mentors: [{ ref: 'ent2', label: 'Acme', type: 'Organization' }],
        Level: 'Senior',
      },
      counts: { relations: 4, commitments: 2, decisions: 1, claims: 0, openCommitments: 1 },
      firstSeen: '2026-01-02',
      lastSeen: '2026-09-01',
    });
    expect(res.summary).toBe('Looked up Sarah (Person)');
    expect(JSON.stringify(res.data)).not.toContain('Lisbon');
    expect(JSON.stringify(res.data)).not.toContain('private');
    expectNoUuid(res.data);
  });

  it('shows personal attributes only with the opt-in — never sensitive ones', async () => {
    const { tool } = build(PROPS);
    const ctx = makeCtx({ personalFactsAllowed: true });
    const res = await tool.run(ctx, tool.input.parse({ entity: seedEntity(ctx, SARAH) }));
    const attributes = (res.data as { attributes: Record<string, unknown> }).attributes;
    expect(attributes['Home town']).toBe('Lisbon');
    expect(attributes.Diagnosis).toBeUndefined();
  });

  it('refuses a handle this turn did not issue', async () => {
    const { tool, graphRead } = build(PROPS);
    await expect(tool.run(makeCtx(), tool.input.parse({ entity: 'ent4' }))).rejects.toThrow(AskToolError);
    expect(graphRead.getEntity).not.toHaveBeenCalled();
  });
});

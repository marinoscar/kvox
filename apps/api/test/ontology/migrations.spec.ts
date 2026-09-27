import {
  ONTOLOGY_MIGRATIONS,
  applyMigrationSteps,
  compareOntologyVersions,
  isMajorOntologyVersion,
  migrationsBetween,
  parseOntologyVersion,
  type MigratableRow,
  type OntologyMigration,
  type OntologyMigrationStep,
} from '@app/shared/ontology';

// =============================================================================
// The pure half of `kg.migrate` (#384; docs/specs/ontology.md §17.4):
// version comparison, migration selection, and every step op — including the
// one property the job's resumability rests on: applying a migration to its
// own output changes nothing.
// =============================================================================

const m = (to: string, ...steps: OntologyMigrationStep[]): OntologyMigration => ({ to, description: `to ${to}`, steps });

function entity(type: string, props: Record<string, unknown>, ontologyVersion = '1.0.0'): MigratableRow {
  return { table: 'entity', type, props, ontologyVersion };
}

/** Apply, then apply again to the output: the second pass must be a no-op. */
function applyTwice(row: MigratableRow, migrations: OntologyMigration[]) {
  const first = applyMigrationSteps(row, migrations);
  const second = applyMigrationSteps(first.row, migrations);
  return { first, second };
}

describe('ontology versions', () => {
  it('compares semver numerically, not lexically', () => {
    expect(compareOntologyVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareOntologyVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareOntologyVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareOntologyVersions('1.0.1', '1.0.0')).toBe(1);
  });

  it('refuses anything that is not strict MAJOR.MINOR.PATCH', () => {
    for (const bad of ['1.0', '1.0.0-rc.1', 'v1.0.0', '01.0.0', '', '1.0.0.0']) {
      expect(() => parseOntologyVersion(bad)).toThrow();
    }
    expect(parseOntologyVersion('10.2.3')).toEqual([10, 2, 3]);
  });

  it('recognises a major version', () => {
    expect(isMajorOntologyVersion('2.0.0')).toBe(true);
    expect(isMajorOntologyVersion('1.0.0')).toBe(true);
    expect(isMajorOntologyVersion('1.1.0')).toBe(false);
    expect(isMajorOntologyVersion('0.0.0')).toBe(false);
  });

  it('ships ONTOLOGY_MIGRATIONS empty at 1.x', () => {
    expect(ONTOLOGY_MIGRATIONS).toEqual([]);
    expect(migrationsBetween('1.0.0')).toEqual([]);
  });
});

describe('migrationsBetween', () => {
  const all = [m('1.1.0', { op: 'drop_attribute', typeKey: 'T', key: 'a' }), m('1.2.0'), m('2.0.0')];

  it('selects from < m.to <= to, ascending', () => {
    expect(migrationsBetween('1.0.0', '2.0.0', all).map((x) => x.to)).toEqual(['1.1.0', '1.2.0', '2.0.0']);
    expect(migrationsBetween('1.1.0', '2.0.0', all).map((x) => x.to)).toEqual(['1.2.0', '2.0.0']);
    expect(migrationsBetween('1.0.0', '1.2.0', all).map((x) => x.to)).toEqual(['1.1.0', '1.2.0']);
    expect(migrationsBetween('2.0.0', '2.0.0', all)).toEqual([]);
  });

  it('sorts even an unsorted input', () => {
    expect(migrationsBetween('0.0.0', '9.0.0', [all[2], all[0], all[1]]).map((x) => x.to)).toEqual(['1.1.0', '1.2.0', '2.0.0']);
  });
});

describe('applyMigrationSteps', () => {
  it('leaves the input unmutated and an untouched row at its own version', () => {
    const row = entity('Person', { title: 'CTO' });
    const out = applyMigrationSteps(row, [m('2.0.0', { op: 'retag_entity_type', from: 'Old', to: 'New' })]);
    expect(out.changed).toBe(false);
    expect(out.row).toEqual(row);
    expect(out.row.props).not.toBe(row.props);
    expect(out.dropped).toEqual([]);
  });

  it('re-versions a changed row to the LAST migration it was given', () => {
    const row = entity('Project', { startDate: '2026-01-02' });
    const out = applyMigrationSteps(row, [
      m('1.1.0', { op: 'rename_attribute', typeKey: 'Project', from: 'startDate', to: 'start' }),
      m('2.0.0', { op: 'retag_entity_type', from: 'OldType', to: 'NewType' }),
    ]);
    expect(out).toEqual({ row: { ...row, props: { start: '2026-01-02' }, ontologyVersion: '2.0.0' }, changed: true, dropped: [] });
  });

  describe('retag_entity_type / retag_relation_type', () => {
    const migrations = [
      m('2.0.0', { op: 'retag_entity_type', from: 'OldType', to: 'NewType' }, { op: 'retag_relation_type', from: 'OLD_REL', to: 'NEW_REL' }),
    ];

    it('retags only its own table', () => {
      expect(applyMigrationSteps(entity('OldType', {}), migrations).row.type).toBe('NewType');
      const relation: MigratableRow = { table: 'relation', type: 'OLD_REL', props: {}, ontologyVersion: '1.0.0' };
      expect(applyMigrationSteps(relation, migrations).row.type).toBe('NEW_REL');
      // An entity type key never matches in the relation table and vice versa.
      expect(applyMigrationSteps({ ...relation, type: 'OldType' }, migrations).changed).toBe(false);
      expect(applyMigrationSteps(entity('OLD_REL', {}), migrations).changed).toBe(false);
    });

    it('is idempotent', () => {
      const { first, second } = applyTwice(entity('OldType', { note: 'x' }), migrations);
      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(second.row).toEqual(first.row);
    });

    it('lets a later step in the same run see the new type', () => {
      const out = applyMigrationSteps(entity('OldType', { a: 1 }), [
        m('2.0.0', { op: 'retag_entity_type', from: 'OldType', to: 'NewType' }),
        m('2.1.0', { op: 'rename_attribute', typeKey: 'NewType', from: 'a', to: 'b' }),
      ]);
      expect(out.row).toMatchObject({ type: 'NewType', props: { b: 1 }, ontologyVersion: '2.1.0' });
    });
  });

  describe('rename_attribute', () => {
    const migrations = [m('1.1.0', { op: 'rename_attribute', typeKey: 'Project', from: 'startDate', to: 'start' })];

    it('moves the value to the new key, on the named type only', () => {
      expect(applyMigrationSteps(entity('Project', { startDate: 'd', status: 'active' }), migrations).row.props).toEqual({
        start: 'd',
        status: 'active',
      });
      expect(applyMigrationSteps(entity('Trip', { startDate: 'd' }), migrations).changed).toBe(false);
    });

    it('keeps an existing target value and counts the discarded source', () => {
      const out = applyMigrationSteps(entity('Project', { startDate: 'old', start: 'new' }), migrations);
      expect(out.row.props).toEqual({ start: 'new' });
      expect(out.dropped).toEqual(['Project.startDate']);
    });

    it('is idempotent', () => {
      const { first, second } = applyTwice(entity('Project', { startDate: 'd' }), migrations);
      expect(first.changed).toBe(true);
      expect(second).toEqual({ row: first.row, changed: false, dropped: [] });
    });
  });

  describe('coerce_attribute', () => {
    it('maps through a value map, dropping and counting unmapped values', () => {
      const migrations = [
        m('1.1.0', { op: 'coerce_attribute', typeKey: 'Project', key: 'phase', to: 'select', map: { Active: 'active', Done: 'done' } }),
      ];
      expect(applyMigrationSteps(entity('Project', { phase: 'Active' }), migrations).row.props).toEqual({ phase: 'active' });
      const unmapped = applyMigrationSteps(entity('Project', { phase: 'Someday', other: 1 }), migrations);
      expect(unmapped.row.props).toEqual({ other: 1 });
      expect(unmapped.dropped).toEqual(['Project.phase']);
      expect(unmapped.changed).toBe(true);
    });

    it('maps each element of a multi_select, counting each dropped element', () => {
      const migrations = [
        m('1.1.0', { op: 'coerce_attribute', typeKey: 'Meeting', key: 'topics', to: 'multi_select', map: { Budget: 'budget', Hiring: 'hiring' } }),
      ];
      const out = applyMigrationSteps(entity('Meeting', { topics: ['Budget', 'Nope', 'Hiring', 'budget', 'Zzz'] }), migrations);
      expect(out.row.props).toEqual({ topics: ['budget', 'hiring'] });
      expect(out.dropped).toEqual(['Meeting.topics', 'Meeting.topics']);
      // A bare string becomes a one-element list.
      expect(applyMigrationSteps(entity('Meeting', { topics: 'Budget' }), migrations).row.props).toEqual({ topics: ['budget'] });
    });

    it('coerces scalars without a map', () => {
      const to = (kind: 'number' | 'boolean' | 'date' | 'text', value: unknown) =>
        applyMigrationSteps(entity('T', { k: value }), [m('1.1.0', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: kind })]);
      expect(to('number', '42').row.props).toEqual({ k: 42 });
      expect(to('number', 'forty').row.props).toEqual({});
      expect(to('number', 'forty').dropped).toEqual(['T.k']);
      expect(to('boolean', 'true').row.props).toEqual({ k: true });
      expect(to('date', '2026-01-02T10:00:00Z').row.props).toEqual({ k: '2026-01-02' });
      expect(to('date', 'soon').row.props).toEqual({});
      expect(to('text', 7).row.props).toEqual({ k: '7' });
    });

    it('leaves null and absent values alone', () => {
      const migrations = [m('1.1.0', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: 'number' })];
      expect(applyMigrationSteps(entity('T', { k: null }), migrations).changed).toBe(false);
      expect(applyMigrationSteps(entity('T', {}), migrations).changed).toBe(false);
    });

    it.each([
      ['a map', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: 'select', map: { A: 'a' } } as const, { k: 'A' }],
      ['a multi_select map', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: 'multi_select', map: { A: 'a' } } as const, { k: ['A', 'x'] }],
      ['number', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: 'number' } as const, { k: '3.5' }],
      ['date', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: 'date' } as const, { k: '2026-01-02T00:00:00Z' }],
      ['text', { op: 'coerce_attribute', typeKey: 'T', key: 'k', to: 'text' } as const, { k: false }],
    ])('is idempotent (%s)', (_name, step, props) => {
      const { first, second } = applyTwice(entity('T', props), [m('1.1.0', step)]);
      expect(first.changed).toBe(true);
      expect(second).toEqual({ row: first.row, changed: false, dropped: [] });
    });
  });

  describe('drop_attribute', () => {
    const migrations = [m('1.1.0', { op: 'drop_attribute', typeKey: 'Decision', key: 'rejectedOption' })];

    it('removes the key and counts a non-null value', () => {
      const out = applyMigrationSteps(entity('Decision', { rejectedOption: 'plan B', x: 1 }), migrations);
      expect(out).toMatchObject({ changed: true, dropped: ['Decision.rejectedOption'] });
      expect(out.row.props).toEqual({ x: 1 });
      expect(applyMigrationSteps(entity('Decision', { rejectedOption: null }), migrations).dropped).toEqual([]);
    });

    it('is idempotent', () => {
      const { first, second } = applyTwice(entity('Decision', { rejectedOption: 'plan B' }), migrations);
      expect(first.changed).toBe(true);
      expect(second).toEqual({ row: first.row, changed: false, dropped: [] });
    });
  });

  describe('retag_item_status', () => {
    const migrations = [m('1.1.0', { op: 'retag_item_status', itemKind: 'commitment', from: 'dropped', to: 'superseded' })];
    const item = (kind: 'commitment' | 'decision', status: string): MigratableRow => ({
      table: 'item',
      type: kind === 'commitment' ? 'Commitment' : 'Decision',
      kind,
      status,
      props: {},
      ontologyVersion: '1.0.0',
    });

    it('retags the status of the named item kind only', () => {
      expect(applyMigrationSteps(item('commitment', 'dropped'), migrations).row).toMatchObject({ status: 'superseded', ontologyVersion: '1.1.0' });
      expect(applyMigrationSteps(item('commitment', 'open'), migrations).changed).toBe(false);
      expect(applyMigrationSteps(item('decision', 'dropped'), migrations).changed).toBe(false);
    });

    it('is idempotent', () => {
      const { first, second } = applyTwice(item('commitment', 'dropped'), migrations);
      expect(first.changed).toBe(true);
      expect(second).toEqual({ row: first.row, changed: false, dropped: [] });
    });
  });
});

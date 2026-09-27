// =============================================================================
// A test-only ontology migration definition (issue #384).
//
// The shipped ONTOLOGY_MIGRATIONS is empty at 1.x, so nothing in the real
// definition exercises `kg.migrate`. This builds the issue's acceptance fixture
// on top of the real registry instead of a hand-rolled one, so every other
// type still validates exactly as in production:
//
//   1.1.0  rename_attribute  Project.startDate → start   (startDate deprecated)
//   2.0.0  retag_entity_type OldType → NewType           (OldType deprecated)
//
// It is injected into `KgMigrateHandler` through `KG_MIGRATE_DEFINITION`.
// Never imported by production code.
// =============================================================================

import {
  CHANGELOG,
  ONTOLOGY,
  SHIPPED_KEYS,
  buildOntologyRegistry,
  type DomainModule,
  type EntityTypeSpec,
  type OntologyChangelogEntry,
  type OntologyMigration,
  type OntologyRegistry,
} from '@app/shared/ontology';

export const TEST_TARGET_VERSION = '2.0.0';

function testEntityType(key: string, deprecated: boolean): EntityTypeSpec {
  return {
    key,
    domain: 'work',
    label: key,
    pluralLabel: `${key}s`,
    description: `A test-only entity type (${key}) that exercises kg.migrate retagging.`,
    disambiguation: ['Only ever used by the kg.migrate tests.'],
    attributes: {
      note: { kind: 'text', label: 'Note', description: 'A free-text test attribute.' },
    },
    sensitivityDefault: 'business',
    ...(deprecated ? { deprecated: { since: '2.0.0', reason: 'Retagged to NewType.' } } : {}),
  };
}

function withTestTypes(domain: DomainModule): DomainModule {
  if (domain.key !== 'work') return domain;
  const entityTypes = domain.entityTypes.map((t) => {
    if (t.key !== 'Project') return t;
    return {
      ...t,
      attributes: {
        ...t.attributes,
        startDate: { ...t.attributes.startDate, deprecated: { since: '1.1.0', reason: 'Renamed to start.' } },
        start: { kind: 'date', label: 'Start', description: 'When the project started.', extractable: true },
      },
    } as EntityTypeSpec;
  });
  return {
    ...domain,
    entityTypes: [...entityTypes, testEntityType('OldType', true), testEntityType('NewType', false)],
  };
}

export interface MigrationTestDefinition {
  registry: OntologyRegistry;
  migrations: OntologyMigration[];
  changelog: OntologyChangelogEntry[];
  shippedKeys: string[];
  targetVersion: string;
}

export function buildMigrationTestDefinition(): MigrationTestDefinition {
  const registry = buildOntologyRegistry(ONTOLOGY.domains().map(withTestTypes), TEST_TARGET_VERSION);
  const migrations: OntologyMigration[] = [
    {
      to: '1.1.0',
      description: 'Project.startDate is renamed to start',
      steps: [{ op: 'rename_attribute', typeKey: 'Project', from: 'startDate', to: 'start' }],
    },
    {
      to: '2.0.0',
      description: 'OldType is retagged to NewType',
      steps: [{ op: 'retag_entity_type', from: 'OldType', to: 'NewType' }],
    },
  ];
  const changelog: OntologyChangelogEntry[] = [
    ...CHANGELOG,
    { version: '2.0.0', date: '2026-09-27', changes: ['test: OldType -> NewType'] },
  ];
  return {
    registry,
    migrations,
    changelog,
    shippedKeys: [...SHIPPED_KEYS, 'Project.start', 'OldType', 'OldType.note', 'NewType', 'NewType.note'],
    targetVersion: TEST_TARGET_VERSION,
  };
}

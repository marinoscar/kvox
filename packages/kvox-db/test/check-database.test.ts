import { describe, expect, it } from 'vitest';

import { checkDatabaseCatalog, checkKvoxInstall, readInventories, type DatabaseCatalog } from '../src/index.js';
import { PACKAGE_DIR, cleanup, freshHost } from './helpers.js';
import { afterEach } from 'vitest';

afterEach(cleanup);

const inventories = readInventories(PACKAGE_DIR);

/** A catalog that has every object the inventories ask for. */
function completeCatalog(): DatabaseCatalog {
  return {
    extensions: [
      { name: 'vector', version: '0.6.0' },
      { name: 'pg_trgm', version: '1.6' },
    ],
    indexes: inventories.rawSqlIndexes.map((index) => ({ name: index.name, table: index.table })),
    triggers: inventories.schemaObjects.triggers.map((t) => ({ name: t.name, table: t.table })),
    functions: inventories.schemaObjects.functions.map((f) => f.name),
    constraints: inventories.schemaObjects.checkConstraints,
    generatedColumns: inventories.schemaObjects.generatedColumns,
  };
}

describe('checkDatabaseCatalog', () => {
  it('accepts a complete catalog', () => {
    expect(checkDatabaseCatalog(completeCatalog(), inventories)).toEqual([]);
  });

  it('reports a missing extension with the statement a superuser must run', () => {
    const catalog = { ...completeCatalog(), extensions: [{ name: 'pg_trgm', version: '1.6' }] };
    const problems = checkDatabaseCatalog(catalog, inventories);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe('EXTENSION_MISSING');
    expect(problems[0]?.message).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
  });

  it('reports an extension older than minVersion', () => {
    const catalog = { ...completeCatalog(), extensions: [{ name: 'vector', version: '0.4.4' }, { name: 'pg_trgm', version: '1.6' }] };
    expect(checkDatabaseCatalog(catalog, inventories).map((p) => p.code)).toEqual(['EXTENSION_TOO_OLD']);
    const exact = { ...completeCatalog(), extensions: [{ name: 'vector', version: '0.5.0' }, { name: 'pg_trgm', version: '1.6' }] };
    expect(checkDatabaseCatalog(exact, inventories)).toEqual([]);
  });

  it('reports a dropped raw index, trigger, function, check and generated column', () => {
    const catalog = completeCatalog();
    catalog.indexes = catalog.indexes.filter((i) => i.name !== 'kg_items_live_statement_uniq_idx');
    catalog.triggers = catalog.triggers.filter((t) => t.name !== 'kg_items_evidence_trg');
    catalog.functions = [];
    catalog.constraints = catalog.constraints.filter((c) => c.name !== 'kg_distinct_pairs_order_chk');
    catalog.generatedColumns = catalog.generatedColumns.filter((c) => c.table !== 'notes');
    expect(checkDatabaseCatalog(catalog, inventories).map((p) => p.code)).toEqual([
      'INDEX_MISSING',
      'GENERATED_COLUMN_MISSING',
      'CONSTRAINT_MISSING',
      'FUNCTION_MISSING',
      'TRIGGER_MISSING',
    ]);
  });

  it('is wired into checkKvoxInstall with an injected catalog', async () => {
    const root = freshHost();
    const { applyKvoxSync, planKvoxSync } = await import('../src/index.js');
    applyKvoxSync(planKvoxSync({ root, platformSchemaDir: null }));
    const ok = await checkKvoxInstall({ root, database: true, catalog: completeCatalog() });
    expect(ok.ok).toBe(true);
    const broken = completeCatalog();
    broken.indexes = broken.indexes.slice(1);
    expect((await checkKvoxInstall({ root, database: true, catalog: broken })).problems.map((p) => p.code)).toEqual(['INDEX_MISSING']);
  });
});

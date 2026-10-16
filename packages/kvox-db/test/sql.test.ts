import { describe, expect, it } from 'vitest';

import { columnsOfDefinition, scanCreatedIndexes, scanTouchedTables, splitSqlStatements } from '../src/index.js';

describe('splitSqlStatements', () => {
  it('drops comments and splits on semicolons outside quotes and dollar bodies', () => {
    const sql = `-- header; with a semicolon
CREATE TABLE "a" ("x" TEXT DEFAULT 'a;b'); /* block; comment */
CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $body$;`;
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain("'a;b'");
    expect(statements[1]).toContain('RETURN NULL; END');
    expect(statements[2]).toContain('SELECT 1;');
  });
});

describe('scanCreatedIndexes', () => {
  it('reads partial, expression and method details', () => {
    const found = scanCreatedIndexes(
      splitSqlStatements(`
        CREATE UNIQUE INDEX "a_uniq" ON "t"("a", "b") WHERE "a" IS NOT NULL;
        CREATE INDEX b_idx ON public.t USING gin (lower(name) gin_trgm_ops);
        CREATE INDEX c_idx ON t USING hnsw (embedding vector_cosine_ops);
        CREATE INDEX d_idx ON t (x DESC, y);`),
    );
    expect(found).toEqual([
      { name: 'a_uniq', table: 't', unique: true, method: 'btree', columns: ['a', 'b'], partial: true },
      { name: 'b_idx', table: 't', unique: false, method: 'gin', columns: null, partial: false },
      { name: 'c_idx', table: 't', unique: false, method: 'hnsw', columns: ['embedding'], partial: false },
      { name: 'd_idx', table: 't', unique: false, method: 'btree', columns: ['x', 'y'], partial: false },
    ]);
  });

  it('reads the key columns of a pg_indexes definition', () => {
    expect(columnsOfDefinition('CREATE UNIQUE INDEX i ON public.t USING btree (conversation_id) WHERE (x = 1)')).toEqual(['conversation_id']);
    expect(columnsOfDefinition('CREATE UNIQUE INDEX i ON public.t USING btree ((true)) WHERE is_current')).toBeNull();
  });
});

describe('scanTouchedTables', () => {
  it('separates the tables a migration writes from the ones its foreign keys reference', () => {
    const touched = scanTouchedTables(
      splitSqlStatements(`
        CREATE TABLE "kg_a" ("id" UUID, "owner_id" UUID);
        ALTER TABLE "kg_a" ADD CONSTRAINT "fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id");
        CREATE INDEX i ON "kg_a"("owner_id");
        CREATE CONSTRAINT TRIGGER t AFTER INSERT ON kg_a DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();
        ALTER TABLE "users" ADD COLUMN "x" TEXT;
        UPDATE jobs SET type = 'x';`),
    );
    expect([...touched.targets].sort()).toEqual(['jobs', 'kg_a', 'users']);
    expect([...touched.references]).toEqual(['users']);
    expect([...touched.created]).toEqual(['kg_a']);
  });
});

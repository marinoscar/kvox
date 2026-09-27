import { ONTOLOGY, type OntologyMigration } from '@app/shared/ontology';

import type { ImportQuad } from './import-dataset';
import { literalValue, migrateQuads, negotiateVersion, readSourceVersion } from './version-negotiation';

// #387 — which version a file was written at, and what the import does about
// it: a newer major is refused, an older file is migrated in memory with #384's
// declared steps (injected here — the shipped list is empty at 1.x).

const NS = 'https://fixture.app/ns#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const iri = (value: string) => ({ termType: 'NamedNode' as const, value });
const lit = (value: string, datatype = `${XSD}string`) => ({ termType: 'Literal' as const, value, datatype });
const q = (s: string, p: string, o: ImportQuad['o']): ImportQuad => ({ s: iri(s), p, o });

describe('readSourceVersion', () => {
  it('reads owl:versionInfo on an owl:Ontology subject', () => {
    expect(readSourceVersion([q('https://x.example/onto', RDF_TYPE, iri(`${OWL}Ontology`)), q('https://x.example/onto', `${OWL}versionInfo`, lit('1.0.3'))], NS)).toBe('1.0.3');
  });

  it('reads it on the namespace IRI itself, where an export states it', () => {
    expect(readSourceVersion([q(NS, `${OWL}versionInfo`, lit('1.1.0'))], NS)).toBe('1.1.0');
  });

  it('falls back to the most common kv:ontologyVersion, then to null', () => {
    const v = `${NS}ontologyVersion`;
    expect(readSourceVersion([q('a:1', v, lit('1.0.0')), q('a:2', v, lit('1.1.0')), q('a:3', v, lit('1.0.0'))], NS)).toBe('1.0.0');
    expect(readSourceVersion([q('a:1', v, lit('not-a-version'))], NS)).toBeNull();
    expect(readSourceVersion([], NS)).toBeNull();
  });
});

describe('negotiateVersion', () => {
  const m = (to: string): OntologyMigration => ({ to, description: 'x', steps: [{ op: 'drop_attribute', typeKey: 'Person', key: 'old' }] });

  it('refuses a newer major and accepts a newer minor as is', () => {
    expect(negotiateVersion('2.0.0', '1.1.0', [])).toEqual({ kind: 'newer_major' });
    expect(negotiateVersion('1.4.0', '1.1.0', [])).toEqual({ kind: 'newer_compatible' });
  });

  it('treats the same version, and no version, as current', () => {
    expect(negotiateVersion('1.1.0', '1.1.0', [])).toEqual({ kind: 'current' });
    expect(negotiateVersion(null, '1.1.0', [])).toEqual({ kind: 'current' });
  });

  it('migrates an older file with the migrations between it and this build', () => {
    expect(negotiateVersion('1.0.0', '1.1.0', [])).toEqual({ kind: 'older', migrations: [] });
    const decision = negotiateVersion('1.0.0', '3.0.0', [m('2.0.0'), m('3.0.0'), m('4.0.0')]);
    expect(decision.kind === 'older' && decision.migrations.map((x) => x.to)).toEqual(['2.0.0', '3.0.0']);
  });
});

describe('migrateQuads', () => {
  it('retags a class and its attribute IRIs, renames, drops, retags status, coerces', () => {
    const quads: ImportQuad[] = [
      q('s:a', RDF_TYPE, iri(`${NS}Person`)),
      q('s:a', `${NS}Person.nick`, lit('Jo')),
      q('s:a', `${NS}Person.gone`, lit('x')),
      q('s:a', `${NS}WORKS_FOR`, iri('s:o')),
      q('s:r', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#predicate', iri(`${NS}WORKS_FOR`)),
      q('s:c', RDF_TYPE, iri(`${NS}Commitment`)),
      q('s:c', `${NS}status`, lit('pending')),
      q('s:o', `${NS}Organization.size`, lit('12')),
    ];
    const migration: OntologyMigration = {
      to: '2.0.0',
      description: 'fixture',
      steps: [
        { op: 'rename_attribute', typeKey: 'Person', from: 'nick', to: 'nickname' },
        { op: 'drop_attribute', typeKey: 'Person', key: 'gone' },
        { op: 'retag_relation_type', from: 'WORKS_FOR', to: 'EMPLOYED_BY' },
        { op: 'retag_item_status', itemKind: 'commitment', from: 'pending', to: 'open' },
        { op: 'coerce_attribute', typeKey: 'Organization', key: 'size', to: 'number' },
      ],
    };
    const out = migrateQuads(quads, NS, ONTOLOGY, [migration]);
    expect(out.find((x) => x.p === `${NS}Person.nickname`)?.o.value).toBe('Jo');
    expect(out.some((x) => x.p === `${NS}Person.gone`)).toBe(false);
    expect(out.some((x) => x.p === `${NS}EMPLOYED_BY`)).toBe(true);
    expect(out.find((x) => x.s.value === 's:r')?.o.value).toBe(`${NS}EMPLOYED_BY`);
    expect(out.find((x) => x.p === `${NS}status`)?.o.value).toBe('open');
    expect(out.find((x) => x.p === `${NS}Organization.size`)?.o).toEqual({ termType: 'Literal', value: '12', datatype: `${XSD}decimal` });
  });

  it('retags an entity class together with its attribute IRIs', () => {
    const out = migrateQuads(
      [q('s:a', RDF_TYPE, iri(`${NS}Project`)), q('s:a', `${NS}Project.status`, lit('active'))],
      NS,
      ONTOLOGY,
      [{ to: '2.0.0', description: 'x', steps: [{ op: 'retag_entity_type', from: 'Project', to: 'Initiative' }] }],
    );
    expect(out.map((x) => [x.p, x.o.value])).toEqual([
      [RDF_TYPE, `${NS}Initiative`],
      [`${NS}Initiative.status`, 'active'],
    ]);
  });

  it('drops a value a coercion cannot keep', () => {
    const out = migrateQuads([q('s:o', `${NS}Organization.size`, lit('lots'))], NS, ONTOLOGY, [
      { to: '2.0.0', description: 'x', steps: [{ op: 'coerce_attribute', typeKey: 'Organization', key: 'size', to: 'number' }] },
    ]);
    expect(out).toEqual([]);
  });
});

describe('literalValue', () => {
  it('reads booleans and numbers by datatype, strings otherwise', () => {
    expect(literalValue(lit('true', `${XSD}boolean`))).toBe(true);
    expect(literalValue(lit('7', `${XSD}integer`))).toBe(7);
    expect(literalValue(lit('7'))).toBe('7');
  });
});

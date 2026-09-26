import { createHash } from 'node:crypto';

import { ONTOLOGY_VERSION } from '@app/shared/ontology';

import { userDef } from '../../../test/graph/rdf/rdf-fixtures';
import type { GraphOntologyService } from '../ontology/graph-ontology.service';
import * as owl from './owl-generator';
import * as shacl from './shacl-generator';
import { GraphRdfService, LruCache, attributeDefsFingerprint, rdfETag } from './graph-rdf.service';

// =============================================================================
// GraphRdfService (#385): the ETag, the fingerprint, and the LRU.
// =============================================================================

const A = userDef({ id: '11111111-1111-4111-8111-111111111111', label: 'Tier' });
const B = userDef({ id: '22222222-2222-4222-8222-222222222222', label: 'Nickname' });

describe('attributeDefsFingerprint / rdfETag', () => {
  it('is independent of the order definitions arrive in', () => {
    expect(attributeDefsFingerprint([A, B])).toBe(attributeDefsFingerprint([B, A]));
  });

  it('changes when a definition is added, relabelled or deprecated', () => {
    const base = attributeDefsFingerprint([A]);
    expect(attributeDefsFingerprint([A, B])).not.toBe(base);
    expect(attributeDefsFingerprint([{ ...A, label: 'Renamed' }])).not.toBe(base);
    expect(attributeDefsFingerprint([{ ...A, deprecatedAt: '2026-09-01T00:00:00.000Z' }])).not.toBe(base);
  });

  it('is W/"sha256(ONTOLOGY_VERSION:fingerprint)"', () => {
    const expected = createHash('sha256').update(`${ONTOLOGY_VERSION}:${attributeDefsFingerprint([A])}`).digest('hex');
    expect(rdfETag([A])).toBe(`W/"${expected}"`);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry beyond its bound', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // `b` is now the least recently used
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });
});

describe('GraphRdfService', () => {
  const ontology = { attributeDefsFor: jest.fn() };
  let service: GraphRdfService;

  beforeEach(() => {
    jest.restoreAllMocks();
    ontology.attributeDefsFor.mockReset().mockResolvedValue([A]);
    service = new GraphRdfService(ontology as unknown as GraphOntologyService);
  });

  it('reads the caller’s definitions once and derives the ETag from them', async () => {
    const prepared = await service.prepare('user-1', 'owl');
    expect(ontology.attributeDefsFor).toHaveBeenCalledWith('user-1');
    expect(prepared.etag).toBe(rdfETag([A]));
  });

  it('generates nothing until the body is asked for (a 304 costs one query)', async () => {
    const spy = jest.spyOn(owl, 'generateOwl');
    await service.prepare('user-1', 'owl');
    expect(spy).not.toHaveBeenCalled();
  });

  it('generates each artefact once per ETag, then serves it from the cache', async () => {
    const owlSpy = jest.spyOn(owl, 'generateOwl');
    const shaclSpy = jest.spyOn(shacl, 'generateShacl');

    const first = (await service.prepare('user-1', 'owl')).body();
    const second = (await service.prepare('user-2', 'owl')).body();
    const shapes = (await service.prepare('user-1', 'shacl')).body();

    expect(second).toBe(first);
    expect(shapes).not.toBe(first);
    expect(owlSpy).toHaveBeenCalledTimes(1);
    expect(shaclSpy).toHaveBeenCalledTimes(1);

    ontology.attributeDefsFor.mockResolvedValue([A, B]);
    const changed = await service.prepare('user-1', 'owl');
    expect(changed.etag).not.toBe(rdfETag([A]));
    expect(changed.body()).toContain(B.id);
    expect(owlSpy).toHaveBeenCalledTimes(2);
  });
});

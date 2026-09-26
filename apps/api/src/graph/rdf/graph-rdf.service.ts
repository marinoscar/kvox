// =============================================================================
// GraphRdfService (issue #385, docs/specs/ontology.md §18.2)
// =============================================================================
//
// Serves the two generated ontology artefacts — OWL/RDFS and SHACL — for one
// caller. Both depend on exactly two inputs: the ontology definition (fixed for
// the life of the process, identified by ONTOLOGY_VERSION) and the caller's own
// attribute definitions. So:
//
//   ETag = W/"sha256(ONTOLOGY_VERSION + ':' + attrDefsFingerprint)"
//
// where the fingerprint is a SHA-256 over the definitions' canonical JSON. One
// owner-scoped query answers every request; a conditional request that
// matches is a 304 before anything is generated, and a miss is generated once
// and kept in a bounded in-memory LRU keyed by the ETag. Because the key is a
// hash of everything the output depends on, a cached body can never be stale —
// a renamed label or a new definition is a new key — and two callers with
// identical definitions (typically: none) share one entry.
//
// ⚠ Never log a body or a fingerprint input: they carry the caller's own
// attribute labels, which are their words about their own contacts.
// =============================================================================

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { APP_SLUG } from '@app/shared';
import { ONTOLOGY, ONTOLOGY_VERSION, kvNamespace, type UserAttributeDef } from '@app/shared/ontology';

import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { generateOwl } from './owl-generator';
import { generateShacl } from './shacl-generator';

export type RdfArtefact = 'owl' | 'shacl';

/** Distinct ETags kept in memory. Each entry holds at most two small Turtle documents. */
export const RDF_CACHE_MAX_ENTRIES = 500;

/** A SHA-256 over the definitions in a canonical order, with every field the output reads. */
export function attributeDefsFingerprint(defs: readonly UserAttributeDef[]): string {
  const canonical = defs
    .map((d) => ({
      id: d.id,
      entityType: d.entityType,
      key: d.key,
      label: d.label,
      kind: d.kind,
      options: d.options,
      sensitivity: d.sensitivity,
      deprecatedAt: d.deprecatedAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The weak ETag both artefacts carry for this ontology version and these definitions. */
export function rdfETag(defs: readonly UserAttributeDef[]): string {
  const digest = createHash('sha256').update(`${ONTOLOGY_VERSION}:${attributeDefsFingerprint(defs)}`).digest('hex');
  return `W/"${digest}"`;
}

/** A least-recently-used map on top of `Map`'s insertion order. */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface RdfPreparation {
  etag: string;
  /** Generates (or reads from the cache) the body. Not called for a 304. */
  body(): string;
}

@Injectable()
export class GraphRdfService {
  private readonly ns = kvNamespace(APP_SLUG);
  private readonly cache = new LruCache<Partial<Record<RdfArtefact, string>>>(RDF_CACHE_MAX_ENTRIES);

  constructor(private readonly ontology: GraphOntologyService) {}

  /**
   * Reads the caller's attribute definitions (the one query) and returns the
   * ETag, plus a lazy body so a matching conditional request generates nothing.
   */
  async prepare(userId: string, artefact: RdfArtefact): Promise<RdfPreparation> {
    const defs = await this.ontology.attributeDefsFor(userId);
    const etag = rdfETag(defs);
    return { etag, body: () => this.body(etag, artefact, defs) };
  }

  private body(etag: string, artefact: RdfArtefact, defs: readonly UserAttributeDef[]): string {
    const entry = this.cache.get(etag) ?? {};
    const cached = entry[artefact];
    if (cached !== undefined) return cached;
    const generated =
      artefact === 'owl' ? generateOwl(ONTOLOGY, defs, this.ns) : generateShacl(ONTOLOGY, defs, this.ns);
    this.cache.set(etag, { ...entry, [artefact]: generated });
    return generated;
  }
}

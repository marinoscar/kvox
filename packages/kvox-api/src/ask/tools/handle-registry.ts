// =============================================================================
// HandleRegistry (#377, epic #348; docs/specs/ontology.md §21.3)
// =============================================================================
//
// The Ask agent never sees a uuid. Every id a tool reads is registered here and
// replaced by a short, per-turn HANDLE — `ent3`, `itm1`, `rel2`, `ev7`, `doc1` —
// which is what the model reads, passes back into later tool calls, and cites
// in `[^…]` markers. Two properties follow by construction:
//
//   - A handle resolves ONLY if this turn issued it, and this turn issues
//     handles only for ids an owner-scoped read returned. A model that invents
//     `ent99` (or pastes a uuid) resolves to nothing; it cannot reach another
//     owner's row because it never sees, and cannot send, an id.
//   - Checking a citation is a map lookup (#378), not a database query.
//
// PURE: no Nest, no Prisma. One registry per assistant turn; `toJSON()` is what
// #378 persists to map the answer's citation markers back to ids.
//
// The five prefixes are a shared contract with #378 (marker parsing), #380
// (rendering) and #382 (scoring). They are permanent.
// =============================================================================

export const HANDLE_KINDS = ['ent', 'itm', 'rel', 'ev', 'doc'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];

/** Strict: a prefix and a positive decimal counter, nothing around it. */
export const HANDLE_PATTERN = /^(ent|itm|rel|ev|doc)([1-9]\d*)$/;

export interface HandleTarget {
  kind: HandleKind;
  /** The row id: entity, item, relation, evidence, or transcript/note id. */
  id: string;
  /** Entity label, item label, source title — for rendering, never for lookup. */
  label?: string;
  /** `doc` handles only. */
  documentKind?: 'transcript' | 'note';
  /** `doc` handles only: where in the recording the cited passage starts. */
  startMs?: number | null;
}

/** Human names for error messages ("ev3 is an evidence reference, …"). */
export const HANDLE_KIND_NOUNS: Record<HandleKind, string> = {
  ent: 'entity',
  itm: 'item',
  rel: 'relation',
  ev: 'evidence',
  doc: 'document',
};

/** Whether `value` is shaped like a handle (any kind), issued or not. */
export function isHandleShaped(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

/** The kind a handle-shaped string names, or null. */
export function handleKindOf(value: string): HandleKind | null {
  const match = HANDLE_PATTERN.exec(value);
  return match ? (match[1] as HandleKind) : null;
}

export class HandleRegistry {
  private readonly byHandle = new Map<string, HandleTarget>();
  private readonly byKey = new Map<string, string>();
  private readonly counters: Record<HandleKind, number> = { ent: 0, itm: 0, rel: 0, ev: 0, doc: 0 };

  /**
   * The same (kind, id) — and for a `doc`, the same `startMs` — always gets the
   * same handle; anything new gets the kind's next counter (`ent1`, `ent2`, …).
   * A later registration may fill in a label the first one lacked; it never
   * replaces one.
   */
  register(target: HandleTarget): string {
    if (!(HANDLE_KINDS as readonly string[]).includes(target.kind)) {
      throw new Error(`unknown handle kind '${String(target.kind)}'`);
    }
    if (typeof target.id !== 'string' || target.id.length === 0) {
      throw new Error('a handle target needs an id');
    }
    const key = HandleRegistry.keyOf(target);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const stored = this.byHandle.get(existing)!;
      if (stored.label === undefined && target.label !== undefined) stored.label = target.label;
      return existing;
    }
    const handle = `${target.kind}${++this.counters[target.kind]}`;
    this.byHandle.set(handle, HandleRegistry.copy(target));
    this.byKey.set(key, handle);
    return handle;
  }

  /** The target an issued handle names, or null for anything else. */
  resolve(handle: string): HandleTarget | null {
    if (typeof handle !== 'string' || !HANDLE_PATTERN.test(handle)) return null;
    const target = this.byHandle.get(handle);
    return target ? HandleRegistry.copy(target) : null;
  }

  /** Every handle issued this turn, in issue order. */
  issued(): ReadonlyMap<string, HandleTarget> {
    return new Map([...this.byHandle].map(([h, t]) => [h, HandleRegistry.copy(t)]));
  }

  /** Persisted by #378 for citation mapping. */
  toJSON(): Record<string, HandleTarget> {
    const out: Record<string, HandleTarget> = {};
    for (const [handle, target] of this.byHandle) out[handle] = HandleRegistry.copy(target);
    return out;
  }

  /**
   * Rebuild a registry from `toJSON()` output, continuing each kind's counter
   * after the highest handle present. Malformed entries are skipped.
   */
  static fromJSON(record: Record<string, HandleTarget>): HandleRegistry {
    const registry = new HandleRegistry();
    for (const [handle, target] of Object.entries(record ?? {})) {
      const match = HANDLE_PATTERN.exec(handle);
      if (!match || !target || target.kind !== match[1] || typeof target.id !== 'string') continue;
      const kind = match[1] as HandleKind;
      const n = Number(match[2]);
      registry.byHandle.set(handle, HandleRegistry.copy(target));
      registry.byKey.set(HandleRegistry.keyOf(target), handle);
      registry.counters[kind] = Math.max(registry.counters[kind], n);
    }
    return registry;
  }

  private static keyOf(target: HandleTarget): string {
    return target.kind === 'doc' ? `doc:${target.id}:${target.startMs ?? ''}` : `${target.kind}:${target.id}`;
  }

  private static copy(target: HandleTarget): HandleTarget {
    const out: HandleTarget = { kind: target.kind, id: target.id };
    if (target.label !== undefined) out.label = target.label;
    if (target.documentKind !== undefined) out.documentKind = target.documentKind;
    if (target.startMs !== undefined) out.startMs = target.startMs;
    return out;
  }
}

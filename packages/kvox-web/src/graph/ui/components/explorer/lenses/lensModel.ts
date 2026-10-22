/**
 * Lenses (GIC-17, #678): a named bundle of what the explorer shows, so a user can
 * come back to "my stakeholder map for the Copilot rollout" (the Bloom "perspective").
 *
 * A lens holds the seeds, the node and relation types SHOWN, the layout and the pinned
 * positions (a time range joins when the TimeBar lands). Everything a lens sets is URL
 * state (`seed`, `types`, `relTypes`, `layout`) except the pins, which go to the same
 * session store the layout reads.
 *
 * Pure: no React, no storage. The built-in presets are described by the keys they WANT and
 * resolved against the caller's ontology, so a preset never names a type that does not
 * exist: missing members are skipped.
 */

/**
 * The layouts a lens may name; the same words the `layout` URL parameter uses.
 *
 * @stability experimental
 */
export type LensLayout = 'force' | 'concentric' | 'static';

/**
 * A pinned node position of a lens.
 *
 * @stability experimental
 */
export interface LensPin {
  /** Horizontal position in layout space. */
  x: number;
  /** Vertical position in layout space. */
  y: number;
}

/**
 * A saved or built-in lens.
 *
 * @stability experimental
 */
export interface ExplorerLens {
  /** Stable id: a generated one for a user lens, `builtin:<key>` for a preset. */
  id: string;
  /** The name shown in the menu. */
  name: string;
  /** Entity ids to start from; empty keeps the seeds already open. At most {@link LENS_LIMITS.maxSeeds}. */
  seeds: string[];
  /** Node types SHOWN; `null` shows all. */
  types: string[] | null;
  /** Relation types SHOWN; `null` shows all. */
  relTypes: string[] | null;
  /** The layout, or `null` for the explorer's own choice. */
  layout: LensLayout | null;
  /** Pinned positions by node id; at most {@link LENS_LIMITS.maxPins}. */
  pins: Record<string, LensPin>;
}

/**
 * A built-in preset: a lens plus the sentence the menu shows under it.
 *
 * @stability experimental
 */
export interface BuiltInLens extends ExplorerLens {
  /** One line on what the lens is for. */
  description: string;
}

/**
 * The limits the settings API enforces (`graph.explorer.lenses`); the web checks them first so the message is friendly.
 *
 * @stability experimental
 */
export const LENS_LIMITS: LensLimits = { maxLenses: 20, maxPins: 300, maxSeeds: 10, maxNameLength: 60 };

/**
 * The limits on saved lenses.
 *
 * @stability experimental
 */
export interface LensLimits {
  /** Most lenses one user may save. */
  readonly maxLenses: 20;
  /** Most pinned positions one lens may hold. */
  readonly maxPins: 300;
  /** Most seeds one lens may hold. */
  readonly maxSeeds: 10;
  /** Longest lens name, in characters. */
  readonly maxNameLength: 60;
}

/** The key of the lens list inside the per-user `graph` settings namespace. */
export const LENS_SETTINGS_KEY = 'graph.explorer.lenses';

/** Prefix of a built-in lens id. */
export const BUILT_IN_PREFIX = 'builtin:';

interface PresetSpec {
  key: string;
  name: string;
  description: string;
  types: readonly string[];
  relations: readonly string[];
  layout: LensLayout | null;
}

const PRESETS: readonly PresetSpec[] = [
  {
    key: 'people-network',
    name: 'People network',
    description: 'People and organizations, and how they work together.',
    types: ['Person', 'Organization'],
    relations: ['WORKS_FOR', 'REPORTS_TO', 'HAS_ROLE', 'INVOLVED_IN'],
    layout: 'force',
  },
  {
    key: 'project-map',
    name: 'Project map',
    description: 'Projects, products, topics and risks, and who is on them.',
    types: ['Project', 'Product', 'Topic', 'risk', 'Person'],
    relations: ['INVOLVED_IN', 'USES', 'CONCERNS', 'PART_OF'],
    layout: 'force',
  },
  {
    key: 'stakeholders-stance',
    name: 'Stakeholders & stance',
    description: 'Who is involved in what, and where they stand.',
    // INVOLVED_IN runs Person -> Project | Topic | Product | Organization; its edges carry the stance.
    types: ['Person', 'Organization', 'Project', 'Product', 'Topic'],
    relations: ['INVOLVED_IN'],
    layout: 'concentric',
  },
  {
    key: 'commitments-risks',
    name: 'Commitments & risks',
    description: 'What was promised, decided or flagged, and by whom.',
    types: ['commitment', 'decision', 'risk', 'claim', 'Person', 'Project'],
    relations: ['ASSIGNED_TO', 'OWED_TO', 'CREATED_IN', 'DECIDED_IN', 'CONCERNS'],
    layout: 'force',
  },
];

/**
 * The built-in lenses for an ontology: each preset limited to the types and relations that exist.
 *
 * @param nodeKeys - Every node type key of the caller's ontology (entity types and item kinds).
 * @param relationKeys - Every relation type key.
 * @returns The presets that still have something to show, in the order above. A preset whose every member is missing is left out; one with some missing members is trimmed.
 *
 * @stability experimental
 */
export function builtInLenses(nodeKeys: readonly string[], relationKeys: readonly string[]): BuiltInLens[] {
  const nodes = new Set(nodeKeys);
  const relations = new Set(relationKeys);
  const out: BuiltInLens[] = [];
  for (const preset of PRESETS) {
    const types = preset.types.filter((key) => nodes.has(key));
    const relTypes = preset.relations.filter((key) => relations.has(key));
    // A preset with no relation left would show isolated nodes; one with no type left shows nothing.
    if (types.length === 0 || relTypes.length === 0) continue;
    out.push({
      id: `${BUILT_IN_PREFIX}${preset.key}`,
      name: preset.name,
      description: preset.description,
      seeds: [],
      types,
      relTypes,
      layout: preset.layout,
      pins: {},
    });
  }
  return out;
}

/** Whether an id names a built-in lens. */
export function isBuiltInLens(id: string): boolean {
  return id.startsWith(BUILT_IN_PREFIX);
}

/**
 * Writes a lens into the explorer's URL parameters.
 *
 * @remarks
 * Types and relations the ontology does not have are dropped from the lists first, so a lens saved under an older ontology still applies. A lens with no seeds leaves `seed` alone. `lens` records which lens was applied; `focus`, `sel` and `tab` are cleared because the selection belongs to the view being left.
 *
 * @param params - The parameters to change, in place.
 * @param lens - The lens to apply.
 * @param nodeKeys - Every node type key of the ontology.
 * @param relationKeys - Every relation type key.
 *
 * @stability experimental
 */
export function applyLensToParams(
  params: URLSearchParams,
  lens: ExplorerLens,
  nodeKeys: readonly string[],
  relationKeys: readonly string[],
): void {
  const setList = (name: string, wanted: readonly string[] | null, universe: readonly string[]) => {
    const known = wanted ? wanted.filter((key) => universe.includes(key)) : null;
    // Nothing left of the list means "no restriction", never "show nothing".
    if (!known || known.length === 0 || known.length === universe.length) params.delete(name);
    else params.set(name, known.join(','));
  };
  setList('types', lens.types, nodeKeys);
  setList('relTypes', lens.relTypes, relationKeys);
  if (lens.layout) params.set('layout', lens.layout);
  else params.delete('layout');
  if (lens.seeds.length > 0) {
    params.set('seed', lens.seeds.slice(0, LENS_LIMITS.maxSeeds).join(','));
    params.delete('cluster');
  }
  params.set('lens', lens.id);
  params.delete('focus');
  params.delete('sel');
  params.delete('tab');
}

/**
 * What the explorer shows now, as a lens would hold it.
 *
 * @stability experimental
 */
export interface LensView {
  /** Seed ids on screen. */
  seeds: readonly string[];
  /** Hidden node types. */
  hiddenTypes: ReadonlySet<string>;
  /** Hidden relation types. */
  hiddenRelationTypes: ReadonlySet<string>;
  /** Every node type key. */
  nodeKeys: readonly string[];
  /** Every relation type key. */
  relationKeys: readonly string[];
  /** The layout in force. */
  layout: LensLayout | null;
  /** Pinned positions by node id. */
  pins: ReadonlyMap<string, LensPin>;
}

function shown(hidden: ReadonlySet<string>, universe: readonly string[]): string[] | null {
  if (hidden.size === 0) return null;
  return universe.filter((key) => !hidden.has(key));
}

/**
 * Captures the current view as a lens.
 *
 * @param view - What the explorer shows now.
 * @param id - The id to give it.
 * @param name - The name to give it (trimmed).
 * @returns The lens. Seeds are capped at {@link LENS_LIMITS.maxSeeds}; pins are NOT capped here, {@link addLens} refuses an oversize lens with a message.
 *
 * @stability experimental
 */
export function captureLens(view: LensView, id: string, name: string): ExplorerLens {
  return {
    id,
    name: name.trim(),
    seeds: view.seeds.slice(0, LENS_LIMITS.maxSeeds),
    types: shown(view.hiddenTypes, view.nodeKeys),
    relTypes: shown(view.hiddenRelationTypes, view.relationKeys),
    layout: view.layout,
    pins: Object.fromEntries([...view.pins].map(([nodeId, pin]) => [nodeId, { x: pin.x, y: pin.y }])),
  };
}

/**
 * Whether the view still matches a lens (its types, relations, layout and, when it names seeds, its seeds), so the menu can say "modified".
 *
 * @stability experimental
 */
export function lensMatchesView(lens: ExplorerLens, view: LensView): boolean {
  const same = (a: readonly string[] | null, b: readonly string[] | null, universe: readonly string[]) => {
    const left = new Set(a ?? universe);
    const right = new Set(b ?? universe);
    // A list is compared as the set it resolves to among the keys that exist.
    const known = (set: Set<string>) => [...set].filter((key) => universe.includes(key)).sort().join('\u0000');
    return known(left) === known(right);
  };
  if (!same(lens.types, shown(view.hiddenTypes, view.nodeKeys), view.nodeKeys)) return false;
  if (!same(lens.relTypes, shown(view.hiddenRelationTypes, view.relationKeys), view.relationKeys)) return false;
  if (lens.layout && view.layout && lens.layout !== view.layout) return false;
  if (lens.seeds.length > 0) {
    const a = [...lens.seeds].sort().join(',');
    const b = [...view.seeds].sort().join(',');
    if (a !== b) return false;
  }
  return true;
}

/**
 * The outcome of changing the saved list.
 *
 * @stability experimental
 */
export type LensEdit = { ok: true; lenses: ExplorerLens[] } | { ok: false; message: string };

/** Shown when the 20-lens limit is hit. */
export const TOO_MANY_LENSES = `You can save up to ${LENS_LIMITS.maxLenses} lenses. Delete one to make room.`;
/** Shown when a lens would pin too many nodes. */
export const TOO_MANY_PINS = `A lens can hold up to ${LENS_LIMITS.maxPins} pinned nodes. Unpin some, then save again.`;
/** Shown for a blank name. */
export const BLANK_LENS_NAME = 'Give the lens a name.';

function nameProblem(name: string, lenses: readonly ExplorerLens[], exceptId?: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return BLANK_LENS_NAME;
  if (trimmed.length > LENS_LIMITS.maxNameLength) return `Keep the name to ${LENS_LIMITS.maxNameLength} characters.`;
  const taken = lenses.some((lens) => lens.id !== exceptId && lens.name.toLowerCase() === trimmed.toLowerCase());
  return taken ? 'You already have a lens with that name.' : null;
}

/** Adds a lens, or says why it cannot be (a blank or taken name, 20 lenses, more than 300 pins). */
export function addLens(lenses: readonly ExplorerLens[], lens: ExplorerLens): LensEdit {
  const problem = nameProblem(lens.name, lenses);
  if (problem) return { ok: false, message: problem };
  if (lenses.length >= LENS_LIMITS.maxLenses) return { ok: false, message: TOO_MANY_LENSES };
  if (Object.keys(lens.pins).length > LENS_LIMITS.maxPins) return { ok: false, message: TOO_MANY_PINS };
  return { ok: true, lenses: [...lenses, { ...lens, name: lens.name.trim() }] };
}

/** Renames a lens, or says why it cannot be. */
export function renameLens(lenses: readonly ExplorerLens[], id: string, name: string): LensEdit {
  const problem = nameProblem(name, lenses, id);
  if (problem) return { ok: false, message: problem };
  return { ok: true, lenses: lenses.map((lens) => (lens.id === id ? { ...lens, name: name.trim() } : lens)) };
}

/** Removes a lens. */
export function deleteLens(lenses: readonly ExplorerLens[], id: string): ExplorerLens[] {
  return lenses.filter((lens) => lens.id !== id);
}

/** A new id for a user lens. */
export function newLensId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // fall through to the timestamp id
  }
  return `lens-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The key the layout reads pins under for one view; the page and the lens menu must agree on it. */
export function explorerPinsKey(seedKey: string, asOf: string | null, lensId?: string | null): string {
  // The lens is part of the key so that applying one re-reads the pins it carries, and pins set afterwards stay with it.
  return `explore:${seedKey}:${asOf ?? ''}${lensId ? `:${lensId}` : ''}`;
}

/**
 * One lens action for the command palette.
 *
 * @stability experimental
 */
export interface LensPaletteAction {
  /** A stable id: `lens:<lens id>`. */
  id: string;
  /** What the palette shows: `Lens: <name>`. */
  label: string;
  /** The palette group the action belongs to. */
  group: 'Lenses';
  /** Applies the lens. */
  run: () => void;
}

/**
 * The lens actions the command palette offers (GIC-16, #670), as plain data.
 *
 * @remarks
 * The explorer page maps each entry into the command palette's Actions section (an icon is added there); a host that builds its own palette can do the same. Each entry applies the lens through `onApply`.
 *
 * @stability experimental
 */
export function lensPaletteActions(
  lenses: readonly ExplorerLens[],
  onApply: (lens: ExplorerLens) => void,
): LensPaletteAction[] {
  return lenses.map((lens) => ({ id: `lens:${lens.id}`, label: `Lens: ${lens.name}`, group: 'Lenses' as const, run: () => onApply(lens) }));
}

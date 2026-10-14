// =============================================================================
// Generic typed registry primitive (issue #459, mirrors EnterpriseAppBase
// `core/registry/registry.ts`)
// =============================================================================
//
// One implementation of "an additive, typed, string-keyed list", so every closed
// list KVox turns into a registry shares ONE duplicate rule, ONE ordering rule
// and ONE set of error codes. The names (`defineRegistry`, `RegistryOptions`,
// `Registry`, `RegistryError`, `freezeAllRegistries`, `listDefinedRegistries`)
// match the platform's so Epic 1 can swap the import path and nothing else.
//
// FRAMEWORK-FREE ON PURPOSE. This file imports nothing: no `@nestjs/*`, no
// Prisma, no application code. Static registries are read where no Nest
// container exists (the seed, scripts, DTO classes built while their module is
// evaluated).
//
// STATIC registries: `defineRegistry(...)` at module scope, filled at import
// time by the app manifest, frozen by `RegistryFreezeService` once the Nest
// application has bootstrapped. Never filled from `onModuleInit`.
// =============================================================================

/**
 * The default pattern every registry id must match: a letter or digit first,
 * then letters, digits and `. _ : / @ -`.
 */
export const DEFAULT_REGISTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** The longest id any registry accepts, in UTF-16 code units. */
export const REGISTRY_ID_MAX_LENGTH = 128;

/**
 * Why a registry refused an operation. Stable: callers may switch on it.
 *
 * - `INVALID_ID`: the id is not a string, is empty, too long, or fails the pattern.
 * - `INVALID_ENTRY`: the registry's `validate` hook threw.
 * - `DUPLICATE_ID`: the id is already registered and the policy is `'throw'`.
 * - `FROZEN`: a write after {@link Registry.freeze}.
 * - `UNKNOWN_ID`: {@link Registry.require} found no entry.
 * - `DUPLICATE_REGISTRY`: {@link defineRegistry} was given a name already in use.
 */
export type RegistryErrorCode =
  | 'INVALID_ID'
  | 'INVALID_ENTRY'
  | 'DUPLICATE_ID'
  | 'FROZEN'
  | 'UNKNOWN_ID'
  | 'DUPLICATE_REGISTRY';

/** The single error type every registry operation throws. */
export class RegistryError extends Error {
  /** Machine-readable reason; see {@link RegistryErrorCode}. */
  readonly code: RegistryErrorCode;
  /** The `name` of the registry that refused the operation. */
  readonly registry: string;
  /** The entry id involved, when there is one. */
  readonly id?: string;

  constructor(
    code: RegistryErrorCode,
    registry: string,
    message: string,
    details: { id?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'RegistryError';
    this.code = code;
    this.registry = registry;
    if (details.id !== undefined) this.id = details.id;
  }
}

/** How a registry identifies, checks, de-duplicates and orders its entries. */
export interface RegistryOptions<T> {
  /** Name used in errors and introspection. Unique among `defineRegistry` registries. */
  name: string;
  /** Extracts the entry's id. Called once per registration. */
  idOf: (entry: T) => string;
  /** Pattern every id must match. Default {@link DEFAULT_REGISTRY_ID_PATTERN}. */
  idPattern?: RegExp;
  /**
   * Rejects an entry by throwing (any value); wrapped as `INVALID_ENTRY`. Runs
   * after the id check and before the duplicate check.
   */
  validate?: (entry: T, registry: Registry<T>) => void;
  /** What a second entry with an existing id does. Default `'throw'`. */
  onDuplicate?: 'throw' | 'replace';
  /** Called for each replacement under `onDuplicate: 'replace'`, after commit. */
  onReplace?: (previous: T, next: T) => void;
  /** Custom `DUPLICATE_ID` message. */
  describeDuplicate?: (existing: T, incoming: T) => string;
  /**
   * The order of {@link Registry.list} and {@link Registry.ids}. Default
   * `'registration'`; `'id'` sorts by code unit; a comparator sorts entries
   * (ties keep registration order).
   */
  order?: 'registration' | 'id' | ((a: T, b: T) => number);
}

/** The introspection shape of {@link Registry.snapshot}. */
export interface RegistrySnapshot {
  name: string;
  frozen: boolean;
  ids: string[];
}

/** Opaque saved state; see {@link Registry._captureState}. @internal */
export interface RegistryState<T> {
  readonly entries: ReadonlyMap<string, T>;
  readonly frozen: boolean;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An additive, typed, string-keyed list with a duplicate policy, deterministic
 * order and an optional freeze. Entries are stored as given (never cloned);
 * {@link list} and {@link ids} return fresh arrays.
 */
export class Registry<T> {
  readonly name: string;

  private entries = new Map<string, T>();
  private frozenFlag = false;
  private readonly idPattern: RegExp;

  constructor(private readonly options: RegistryOptions<T>) {
    if (typeof options.name !== 'string' || options.name.trim() === '') {
      throw new RegistryError('INVALID_ID', String(options.name), 'A registry name must be a non-empty string.');
    }
    this.name = options.name;
    const pattern = options.idPattern ?? DEFAULT_REGISTRY_ID_PATTERN;
    this.idPattern = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
  }

  /**
   * Adds one entry.
   * @throws RegistryError `FROZEN`, `INVALID_ID`, `INVALID_ENTRY` or `DUPLICATE_ID`;
   * the registry is unchanged when it throws.
   */
  register(entry: T): void {
    this.registerAll([entry]);
  }

  /**
   * Adds every entry, all or nothing: each entry is checked (id, `validate`,
   * duplicates against the registry AND earlier entries of the same batch)
   * before any is added.
   */
  registerAll(entries: readonly T[]): void {
    this.assertWritable();

    const staged = new Map(this.entries);
    const replacements: Array<[previous: T, next: T]> = [];

    for (const entry of entries) {
      const id = this.checkedId(entry);

      if (this.options.validate) {
        try {
          this.options.validate(entry, this);
        } catch (err) {
          throw new RegistryError(
            'INVALID_ENTRY',
            this.name,
            `Invalid entry "${id}" in registry "${this.name}": ${messageOf(err)}`,
            { id, cause: err },
          );
        }
      }

      if (staged.has(id)) {
        const existing = staged.get(id) as T;
        if ((this.options.onDuplicate ?? 'throw') === 'throw') {
          const message = this.options.describeDuplicate
            ? this.options.describeDuplicate(existing, entry)
            : `Duplicate id "${id}" in registry "${this.name}".`;
          throw new RegistryError('DUPLICATE_ID', this.name, message, { id });
        }
        replacements.push([existing, entry]);
      }

      // Map#set on an existing key keeps its insertion position.
      staged.set(id, entry);
    }

    this.entries = staged;

    for (const [previous, next] of replacements) {
      this.options.onReplace?.(previous, next);
    }
  }

  /** The entry registered under `id`, or `undefined`. */
  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  /** The entry registered under `id`. @throws RegistryError `UNKNOWN_ID`. */
  require(id: string): T {
    const entry = this.entries.get(id);
    if (entry === undefined && !this.entries.has(id)) {
      const known = this.ids();
      const shown = known.length > 20 ? `${known.slice(0, 20).join(', ')}, ...` : known.join(', ');
      throw new RegistryError(
        'UNKNOWN_ID',
        this.name,
        `Unknown id "${id}" in registry "${this.name}". Known ids: ${shown || '(none)'}.`,
        { id },
      );
    }
    return entry as T;
  }

  /** Whether an entry is registered under `id`. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Every id, as a fresh array, in {@link list} order. */
  ids(): string[] {
    return this.sortedEntries().map(([id]) => id);
  }

  /** Every entry, as a fresh array, in the order {@link RegistryOptions.order} names. */
  list(): T[] {
    return this.sortedEntries().map(([, entry]) => entry);
  }

  /** How many entries are registered. */
  get size(): number {
    return this.entries.size;
  }

  /** Refuses every later write with `FROZEN`. Reads keep working. Idempotent. */
  freeze(): void {
    this.frozenFlag = true;
  }

  /** Whether {@link freeze} has been called. */
  isFrozen(): boolean {
    return this.frozenFlag;
  }

  /** Alias of {@link isFrozen} (the platform exposes this as a getter). */
  get frozen(): boolean {
    return this.frozenFlag;
  }

  /** Name, frozen state and ids, for logs, diagnostics and snapshot tests. */
  snapshot(): RegistrySnapshot {
    return { name: this.name, frozen: this.frozenFlag, ids: this.ids() };
  }

  /** Saves the entries and frozen state. For `testing.ts` only. @internal */
  _captureState(): RegistryState<T> {
    return { entries: new Map(this.entries), frozen: this.frozenFlag };
  }

  /** Restores a state saved by {@link _captureState}. For `testing.ts` only. @internal */
  _restoreState(state: RegistryState<T>): void {
    this.entries = new Map(state.entries);
    this.frozenFlag = state.frozen;
  }

  /** Allows writes again. For `testing.ts` only. @internal */
  _unfreeze(): void {
    this.frozenFlag = false;
  }

  /** Removes every entry and allows writes again. For `testing.ts` only. @internal */
  _clear(): void {
    this.entries = new Map();
    this.frozenFlag = false;
  }

  private assertWritable(): void {
    if (this.frozenFlag) {
      throw new RegistryError(
        'FROZEN',
        this.name,
        `Registry "${this.name}" is frozen: entries are registered before the application bootstraps.`,
      );
    }
  }

  private checkedId(entry: T): string {
    const id: unknown = this.options.idOf(entry);
    const fail = (why: string): never => {
      throw new RegistryError(
        'INVALID_ID',
        this.name,
        `Invalid id ${JSON.stringify(id)} in registry "${this.name}": ${why}.`,
        { id: typeof id === 'string' ? id : undefined },
      );
    };

    if (typeof id !== 'string') return fail('an id must be a string');
    if (id.length === 0) return fail('an id must not be empty');
    if (id.length > REGISTRY_ID_MAX_LENGTH) return fail(`an id must be at most ${REGISTRY_ID_MAX_LENGTH} characters`);
    if (!this.idPattern.test(id)) return fail(`an id must match ${this.idPattern}`);
    return id;
  }

  private sortedEntries(): Array<[string, T]> {
    const pairs = [...this.entries];
    const order = this.options.order ?? 'registration';
    if (order === 'id') {
      pairs.sort(([a], [b]) => compareCodeUnits(a, b));
    } else if (typeof order === 'function') {
      pairs.sort(([, a], [, b]) => order(a, b));
    }
    return pairs;
  }
}

// -----------------------------------------------------------------------------
// The catalogue of static (module-level) registries
// -----------------------------------------------------------------------------

const definedRegistries = new Map<string, Registry<unknown>>();

/**
 * Creates a module-level ("static") registry and records it in the catalogue,
 * so {@link freezeAllRegistries} (called by `RegistryFreezeService` after
 * bootstrap) freezes it and {@link listDefinedRegistries} reports it.
 *
 * @throws RegistryError `DUPLICATE_REGISTRY` when a defined registry already has that name.
 */
export function defineRegistry<T>(options: RegistryOptions<T>): Registry<T> {
  if (definedRegistries.has(options.name)) {
    throw new RegistryError(
      'DUPLICATE_REGISTRY',
      options.name,
      `A registry named "${options.name}" is already defined. Registry names must be unique.`,
    );
  }
  const registry = new Registry<T>(options);
  definedRegistries.set(registry.name, registry as Registry<unknown>);
  return registry;
}

/** Every registry created with {@link defineRegistry}, in definition order. */
export function listDefinedRegistries(): ReadonlyArray<Registry<unknown>> {
  return [...definedRegistries.values()];
}

/** Freezes every registry created with {@link defineRegistry}. Idempotent. */
export function freezeAllRegistries(): void {
  for (const registry of definedRegistries.values()) registry.freeze();
}

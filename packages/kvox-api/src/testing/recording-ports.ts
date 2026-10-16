import { KvoxEventEmitterEvents } from '../core/index.js';
import type {
  KvoxAuditEvent,
  KvoxAuditPort,
  KvoxEventsPort,
  KvoxNotificationEventDef,
  KvoxNotifyPort,
  KvoxSecretStatus,
  KvoxSecretsPort,
  KvoxSettingsNamespaceDef,
  KvoxSettingsPort,
} from '../ports/index.js';

/**
 * One `notify` call a {@link RecordingKvoxNotify} received.
 *
 * @stability experimental
 */
export interface RecordedKvoxNotification {
  /** The event key. */
  eventKey: string;
  /** The recipient. */
  userId: string;
  /** The event data. */
  data: unknown;
}

/**
 * A {@link KvoxNotifyPort} that records instead of delivering.
 *
 * @stability experimental
 */
export interface RecordingKvoxNotify extends KvoxNotifyPort {
  /** The events declared so far. */
  readonly events: KvoxNotificationEventDef[];
  /** Every `notify` call, in order. */
  readonly sent: RecordedKvoxNotification[];
}

/**
 * Builds a notification port that records. `notify` returns at once and never
 * throws, like the real one.
 *
 * @returns the recording port.
 * @stability experimental
 */
export function createRecordingKvoxNotify(): RecordingKvoxNotify {
  const events: KvoxNotificationEventDef[] = [];
  const sent: RecordedKvoxNotification[] = [];
  return {
    events,
    sent,
    registerEvents(defs) {
      for (const def of defs) {
        if (!events.some((known) => known.key === def.key)) events.push(def);
      }
    },
    notify(eventKey, userId, data) {
      sent.push({ eventKey, userId, data });
    },
  };
}

/**
 * A {@link KvoxAuditPort} that records.
 *
 * @stability experimental
 */
export interface RecordingKvoxAudit extends KvoxAuditPort {
  /** Every event recorded, in order. */
  readonly recorded: KvoxAuditEvent[];
}

/**
 * Builds an audit port that keeps what it is given.
 *
 * @returns the recording port.
 * @stability experimental
 */
export function createRecordingKvoxAudit(): RecordingKvoxAudit {
  const recorded: KvoxAuditEvent[] = [];
  return {
    recorded,
    async record(e) {
      recorded.push(e);
    },
  };
}

/**
 * Builds an in-process events port (an emitter of its own).
 *
 * @returns the port.
 * @stability experimental
 */
export function createInMemoryKvoxEvents(): KvoxEventsPort {
  return new KvoxEventEmitterEvents();
}

/**
 * An in-memory {@link KvoxSettingsPort}.
 *
 * @stability experimental
 */
export interface InMemoryKvoxSettings extends KvoxSettingsPort {
  /** The declared namespaces, by `scope:name`. */
  readonly namespaces: ReadonlyMap<string, KvoxSettingsNamespaceDef>;
}

/**
 * Builds in-memory settings. A patch is merged into the stored value and the
 * result is validated against the namespace's schema; a system namespace carries
 * a version that starts at 1 and rises by one on every patch.
 *
 * @returns the port.
 * @stability experimental
 */
export function createInMemoryKvoxSettings(): InMemoryKvoxSettings {
  const namespaces = new Map<string, KvoxSettingsNamespaceDef>();
  const system = new Map<string, { value: unknown; version: number }>();
  const user = new Map<string, unknown>();

  const declared = (scope: 'system' | 'user', name: string): KvoxSettingsNamespaceDef => {
    const def = namespaces.get(`${scope}:${name}`);
    if (!def) throw new Error(`Unknown ${scope} settings namespace "${name}"`);
    return def;
  };
  const merged = (def: KvoxSettingsNamespaceDef, current: unknown, patch: unknown): unknown =>
    def.schema.parse({ ...(current as object), ...(patch as object) });

  return {
    namespaces,

    registerNamespace(def) {
      namespaces.set(`${def.scope}:${def.name}`, def);
    },

    async readSystem<T>(name: string) {
      const def = declared('system', name);
      const held = system.get(name) ?? { value: def.defaults, version: 1 };
      return { value: held.value as T, version: held.version };
    },

    async patchSystem<T>(
      name: string,
      patch: Partial<T>,
      ctx: { actorUserId: string; ifMatchVersion?: number },
    ) {
      const def = declared('system', name);
      const held = system.get(name) ?? { value: def.defaults, version: 1 };
      if (ctx.ifMatchVersion !== undefined && ctx.ifMatchVersion !== held.version) {
        throw new Error(`Settings "${name}" are at version ${held.version}, not ${ctx.ifMatchVersion}`);
      }
      const next = { value: merged(def, held.value, patch), version: held.version + 1 };
      system.set(name, next);
      return { value: next.value as T, version: next.version };
    },

    async readUser<T>(userId: string, name: string) {
      const def = declared('user', name);
      return (user.get(`${userId}:${name}`) ?? def.defaults) as T;
    },

    async patchUser<T>(userId: string, name: string, patch: Partial<T>) {
      const def = declared('user', name);
      const next = merged(def, user.get(`${userId}:${name}`) ?? def.defaults, patch);
      user.set(`${userId}:${name}`, next);
      return next as T;
    },
  };
}

/**
 * An in-memory {@link KvoxSecretsPort}.
 *
 * @stability experimental
 */
export interface InMemoryKvoxSecrets extends KvoxSecretsPort {
  /** The declared purposes and their labels. */
  readonly purposes: ReadonlyMap<string, string>;
}

/**
 * Builds an in-memory secret store. `status` reports a four-character hint at
 * most and never the value; a purpose must be registered before it is used.
 *
 * @returns the port.
 * @stability experimental
 */
export function createInMemoryKvoxSecrets(): InMemoryKvoxSecrets {
  const purposes = new Map<string, string>();
  const held = new Map<string, { value: string; updatedAt: string }>();
  const address = (purpose: string, name: string): string => {
    if (!purposes.has(purpose)) throw new Error(`Credential purpose "${purpose}" is not registered`);
    return `${purpose}/${name}`;
  };

  return {
    purposes,

    registerPurpose(purpose, label) {
      purposes.set(purpose, label);
    },

    async get(purpose, name) {
      return held.get(address(purpose, name))?.value ?? null;
    },

    async set(purpose, name, value) {
      held.set(address(purpose, name), { value, updatedAt: new Date().toISOString() });
    },

    async delete(purpose, name) {
      held.delete(address(purpose, name));
    },

    async status(purpose, name): Promise<KvoxSecretStatus> {
      const entry = held.get(address(purpose, name));
      if (!entry) return { configured: false, hint: null, updatedAt: null };
      return {
        configured: true,
        hint: entry.value.length > 8 ? `…${entry.value.slice(-4)}` : null,
        updatedAt: entry.updatedAt,
      };
    },
  };
}

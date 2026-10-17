import {
  type DynamicModule,
  Global,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OptionalFactoryDependency,
  type Provider,
  type Type,
} from '@nestjs/common';

import {
  KVOX_AI,
  KVOX_AUDIT,
  KVOX_EVENTS,
  KVOX_IDENTITY,
  KVOX_JOBS,
  KVOX_NOTIFY,
  KVOX_OBJECT_STORE,
  KVOX_PRISMA,
  KVOX_SECRETS,
  KVOX_SETTINGS,
  type KvoxAiPort,
  type KvoxAuditPort,
  type KvoxEventsPort,
  type KvoxIdentityPort,
  type KvoxJobsPort,
  type KvoxNotifyPort,
  type KvoxObjectStorePort,
  type KvoxPrismaClientLike,
  type KvoxSecretsPort,
  type KvoxSettingsPort,
} from '../../ports/index.js';
import { DEFAULT_KVOX_BRAND, KVOX_BRAND, type KvoxBrand } from '../brand/kvox-brand.js';
import { KvoxEventEmitterEvents } from '../events/kvox-event-emitter.events.js';

/** The optional peer that provides Nest's shared event emitter, loaded on first use. */
const EVENT_EMITTER_PACKAGE = '@nestjs/event-emitter';

/**
 * Binds a port to a class Nest instantiates.
 *
 * @stability experimental
 */
export interface KvoxClassBinding<T> {
  /** The class; it must be `@Injectable` and its dependencies resolvable. */
  useClass: Type<T>;
}

/**
 * Binds a port to a provider that already exists.
 *
 * @stability experimental
 */
export interface KvoxExistingBinding<T> {
  /** The existing provider's class or token. */
  useExisting: Type<T> | string | symbol;
}

/**
 * Binds a port to a ready value.
 *
 * @stability experimental
 */
export interface KvoxValueBinding<T> {
  /** The instance. */
  useValue: T;
}

/**
 * Binds a port to a factory.
 *
 * @stability experimental
 */
export interface KvoxFactoryBinding<T> {
  /** Builds the port from its dependencies. */
  useFactory: (...deps: any[]) => T | Promise<T>;
  /** The dependencies passed to `useFactory`. */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
}

/**
 * How a host binds one port: a class, an existing provider, a ready value or a
 * factory. The same four shapes as a Nest custom provider, minus the token.
 *
 * @stability experimental
 */
export type KvoxPortBinding<T> =
  | KvoxClassBinding<T>
  | KvoxExistingBinding<T>
  | KvoxValueBinding<T>
  | KvoxFactoryBinding<T>;

/**
 * The bindings of every port. The first eight are required; `events` and `audit`
 * are optional and default to an in-process emitter and a no-op.
 *
 * @extensionPoint token
 * @stability experimental
 */
export interface KvoxPortBindings {
  /** The model port, bound to `KVOX_AI`. */
  ai: KvoxPortBinding<KvoxAiPort>;
  /** The object-store port, bound to `KVOX_OBJECT_STORE`. */
  objectStore: KvoxPortBinding<KvoxObjectStorePort>;
  /** The job port, bound to `KVOX_JOBS`. */
  jobs: KvoxPortBinding<KvoxJobsPort>;
  /** The identity port, bound to `KVOX_IDENTITY`. */
  identity: KvoxPortBinding<KvoxIdentityPort>;
  /** The notification port, bound to `KVOX_NOTIFY`. */
  notify: KvoxPortBinding<KvoxNotifyPort>;
  /** The database port, bound to `KVOX_PRISMA`. */
  prisma: KvoxPortBinding<KvoxPrismaClientLike>;
  /** The settings port, bound to `KVOX_SETTINGS`. */
  settings: KvoxPortBinding<KvoxSettingsPort>;
  /** The secrets port, bound to `KVOX_SECRETS`. */
  secrets: KvoxPortBinding<KvoxSecretsPort>;
  /** The event port, bound to `KVOX_EVENTS`. Optional; defaults to {@link KvoxEventEmitterEvents}. */
  events?: KvoxPortBinding<KvoxEventsPort>;
  /** The audit port, bound to `KVOX_AUDIT`. Optional; defaults to a no-op. */
  audit?: KvoxPortBinding<KvoxAuditPort>;
  /** Modules the bindings' providers need (a binding by `useClass` resolves its dependencies from them). */
  imports?: ModuleMetadata['imports'];
}

/**
 * The options of {@link KvoxPortsModule.forRoot}.
 *
 * @stability experimental
 */
export interface KvoxPortsOptions {
  /** The port bindings. */
  ports: KvoxPortBindings;
  /**
   * What the host calls itself (`KVOX_BRAND`); the slices that print a product
   * name read it. Default {@link DEFAULT_KVOX_BRAND}.
   */
  brand?: KvoxBrand;
}

/**
 * An audit port that records nothing: the default when a host binds none.
 *
 * @stability experimental
 */
export const NOOP_KVOX_AUDIT: KvoxAuditPort = Object.freeze({
  async record(): Promise<void> {
    // Intentionally empty.
  },
});

type RequiredPort = Exclude<keyof KvoxPortBindings, 'events' | 'audit' | 'imports'>;

/** Required ports in the order they are reported, with their tokens. */
const REQUIRED: ReadonlyArray<readonly [RequiredPort, symbol, string]> = [
  ['ai', KVOX_AI, 'KVOX_AI'],
  ['objectStore', KVOX_OBJECT_STORE, 'KVOX_OBJECT_STORE'],
  ['jobs', KVOX_JOBS, 'KVOX_JOBS'],
  ['identity', KVOX_IDENTITY, 'KVOX_IDENTITY'],
  ['notify', KVOX_NOTIFY, 'KVOX_NOTIFY'],
  ['prisma', KVOX_PRISMA, 'KVOX_PRISMA'],
  ['settings', KVOX_SETTINGS, 'KVOX_SETTINGS'],
  ['secrets', KVOX_SECRETS, 'KVOX_SECRETS'],
];

function isBinding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return ['useClass', 'useExisting', 'useValue', 'useFactory'].some((key) => key in value);
}

function provider(token: symbol, binding: KvoxPortBinding<unknown>): Provider {
  return { provide: token, ...binding } as Provider;
}

/** Nest's `EventEmitter2` class when the optional peer is installed, else `undefined`. */
function sharedEmitterToken(): Type | undefined {
  try {
    return (require(EVENT_EMITTER_PACKAGE) as { EventEmitter2?: Type }).EventEmitter2;
  } catch {
    return undefined;
  }
}

function defaultEvents(): Provider {
  const emitter = sharedEmitterToken();
  return {
    provide: KVOX_EVENTS,
    useFactory: (shared?: ConstructorParameters<typeof KvoxEventEmitterEvents>[0]) =>
      new KvoxEventEmitterEvents(shared),
    inject: emitter ? [{ token: emitter, optional: true }] : [],
  };
}

/**
 * Binds the host ports to Nest's container, globally, so a slice injects
 * `KVOX_AI`, `KVOX_JOBS` and the rest without importing anything.
 *
 * `forRoot` throws, naming every missing required port, when the host forgot
 * one, so a missing binding fails at start-up and not at the first request.
 *
 * @example
 * ```ts
 * KvoxPortsModule.forRoot({
 *   ports: {
 *     ai: { useClass: MyAiAdapter },
 *     objectStore: { useClass: MyStoreAdapter },
 *     jobs: { useClass: MyJobsAdapter },
 *     identity: { useClass: MyIdentityAdapter },
 *     notify: { useClass: MyNotifyAdapter },
 *     prisma: { useExisting: PrismaService },
 *     settings: { useClass: MySettingsAdapter },
 *     secrets: { useClass: MySecretsAdapter },
 *   },
 * });
 * ```
 *
 * @extensionPoint token
 * @stability experimental
 */
@Global()
@Module({})
export class KvoxPortsModule {
  /**
   * Builds the global module.
   *
   * @param options - the port bindings.
   * @returns the dynamic module.
   * @throws Error naming every required port that has no binding.
   */
  static forRoot(options: KvoxPortsOptions): DynamicModule {
    const bindings = (options?.ports ?? {}) as Partial<KvoxPortBindings>;

    const missing = REQUIRED.filter(([key]) => !isBinding(bindings[key])).map(
      ([key, , token]) => `${token} (ports.${key})`,
    );
    if (missing.length > 0) {
      throw new Error(
        `KvoxPortsModule.forRoot: no binding for ${missing.length === 1 ? 'port' : 'ports'} ${missing.join(
          ', ',
        )}. Every required port must be bound; see @marinoscar/kvox-api/ports.`,
      );
    }

    const providers: Provider[] = REQUIRED.map(([key, token]) =>
      provider(token, bindings[key] as KvoxPortBinding<unknown>),
    );
    providers.push(
      isBinding(bindings.events)
        ? provider(KVOX_EVENTS, bindings.events as KvoxPortBinding<unknown>)
        : defaultEvents(),
      isBinding(bindings.audit)
        ? provider(KVOX_AUDIT, bindings.audit as KvoxPortBinding<unknown>)
        : { provide: KVOX_AUDIT, useValue: NOOP_KVOX_AUDIT },
      { provide: KVOX_BRAND, useValue: options.brand ?? DEFAULT_KVOX_BRAND },
    );

    return {
      module: KvoxPortsModule,
      global: true,
      imports: bindings.imports ?? [],
      providers,
      exports: [...REQUIRED.map(([, token]) => token), KVOX_EVENTS, KVOX_AUDIT, KVOX_BRAND],
    };
  }
}

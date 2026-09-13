import { APP_GUARD } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { AuthModule } from '../../auth/auth.module';
import { MaintenanceGuard } from './maintenance.guard';
import { MaintenanceModeService } from './maintenance-mode.service';
import { MaintenanceModule } from './maintenance.module';

/**
 * Structural tests over the module graph.
 *
 * These assert a DEPENDENCY DIRECTION, which is not something a runtime test
 * can notice going wrong: importing `AuthModule` here would work perfectly
 * until the day something in the auth graph needed the maintenance state, and
 * the failure then is the whole application refusing to boot on a circular
 * import — in the module that runs in front of every request.
 */

type ModuleRef = { module?: unknown; imports?: unknown[] } | unknown;

/** Every module reachable from `root` through static and dynamic imports. */
function reachableModules(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const queue: ModuleRef[] = [root];

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) {
      continue;
    }

    // A dynamic module (`JwtModule.registerAsync(...)`) is an object carrying
    // the class under `module`; a static import is the class itself.
    const moduleClass =
      typeof entry === 'object' && entry !== null && 'module' in entry
        ? (entry as { module: unknown }).module
        : entry;

    if (!moduleClass || seen.has(moduleClass)) {
      continue;
    }
    seen.add(moduleClass);

    const imports =
      (Reflect.getMetadata('imports', moduleClass as object) as unknown[]) ?? [];
    queue.push(...imports);

    if (typeof entry === 'object' && entry !== null && 'imports' in entry) {
      queue.push(...(((entry as { imports?: unknown[] }).imports ?? []) as unknown[]));
    }
  }

  return seen;
}

describe('MaintenanceModule', () => {
  it('does not import AuthModule, directly or transitively', () => {
    // ACCEPTANCE CRITERION (#257). `AuthModule` exports `JwtModule`, so
    // importing it would be the shortest path to a `JwtService` — and would
    // drag `UsersModule`, `PatModule`, `AllowlistModule`, `NotificationsModule`
    // and both Passport strategies behind a guard that runs on every request.
    // This module registers its own `JwtModule` against the same secret
    // instead; see maintenance.module.ts.
    const reachable = reachableModules(MaintenanceModule);

    expect(reachable.has(AuthModule)).toBe(false);
    expect([...reachable].map((m) => (m as { name?: string })?.name)).not.toContain(
      'AuthModule',
    );
  });

  it('reaches only the settings module and a JwtModule of its own', () => {
    const names = [...reachableModules(MaintenanceModule)]
      .map((m) => (m as { name?: string })?.name)
      .filter((name): name is string => typeof name === 'string')
      .sort();

    // Pinned as a whole rather than as "not AuthModule": the criterion is a
    // narrow graph, and a future import of something equally heavy would
    // otherwise pass a test aimed at the wrong specific name.
    expect(names).toEqual([
      // ConfigHostModule is ConfigModule's own internal companion, pulled in by
      // `ConfigModule.forRoot`; it holds the loaded configuration and nothing
      // else.
      'ConfigHostModule',
      'ConfigModule',
      'JwtModule',
      'MaintenanceModule',
      'SettingsModule',
    ]);
  });

  it('exports the guard so the root module can alias it to APP_GUARD', () => {
    const exports = Reflect.getMetadata('exports', MaintenanceModule) as unknown[];

    expect(exports).toContain(MaintenanceGuard);
    expect(exports).toContain(MaintenanceModeService);
  });

  it('does not re-export JwtModule, which would shadow AuthModule’s', () => {
    // Both register a `JwtService`; two exported bindings in the root context
    // could shadow one another, including for the helpers the test suite
    // resolves from the root injector to sign tokens.
    const exports = (Reflect.getMetadata('exports', MaintenanceModule) as unknown[]).map(
      (entry) => (entry as { name?: string })?.name,
    );

    expect(exports).not.toContain('JwtModule');
  });
});

describe('AppModule', () => {
  it('registers the maintenance guard as the application’s global guard', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as Array<
      Record<string, unknown>
    >;

    const globalGuards = providers.filter(
      (provider) => provider?.provide === APP_GUARD,
    );

    // Exactly one: this is the repository's first APP_GUARD, and a second one
    // added later should be a deliberate decision that updates this test.
    expect(globalGuards).toHaveLength(1);
    expect(globalGuards[0].useExisting).toBe(MaintenanceGuard);
  });

  it('imports MaintenanceModule, which is where that guard is constructed', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];

    expect(imports).toContain(MaintenanceModule);
  });
});

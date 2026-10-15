import { z } from 'zod';

// =============================================================================
// Settings namespace registries (issue #459)
// =============================================================================
//
// The registries and the `requestBodiesComposed` flags are MODULE-LEVEL state,
// and `defineRegistry` refuses a second registry of the same name, so every
// test loads a fresh copy of the module graph with `jest.isolateModules`
// instead of resetting shared state. Nothing here touches the real manifest.
// =============================================================================

type Registry = typeof import('./index');
type RegistryPrimitive = typeof import('../../common/registry/define-registry');

function load(): { settings: Registry; primitive: RegistryPrimitive } {
  let settings!: Registry;
  let primitive!: RegistryPrimitive;
  jest.isolateModules(() => {
    primitive = require('../../common/registry/define-registry');
    settings = require('./index');
  });
  return { settings, primitive };
}

const MANIFEST_MESSAGE =
  'Settings namespaces are not registered: import apps/api/src/kvox.manifest first';

function system(
  key: string,
  overrides: Record<string, unknown> = {},
): import('./system-settings-namespace').SystemSettingsNamespace {
  const stored = z.object({ on: z.boolean() });
  return {
    key,
    description: `The ${key} namespace.`,
    storedSchema: stored,
    patchSchema: z.object({ on: z.boolean().optional() }),
    putSchema: stored,
    wirePatchSchema: z.object({ on: z.boolean().optional() }),
    responseSchema: z.object({ on: z.boolean() }),
    defaults: { on: false },
    requiredOnPut: false,
    ...overrides,
  };
}

function user(
  key: string,
  overrides: Record<string, unknown> = {},
): import('./user-settings-namespace').UserSettingsNamespace {
  return {
    key,
    description: `The ${key} namespace.`,
    schema: z.object({ n: z.number() }),
    patchSchema: z.object({ n: z.number().nullable().optional() }),
    merge: (current, patch) => (patch === undefined ? current : patch === null ? undefined : (patch as never)),
    ...overrides,
  };
}

function codeOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? `non-registry:${(err as Error).message}`;
  }
  return undefined;
}

describe('system settings namespace registry', () => {
  it('throws DUPLICATE_ID when a key is registered twice, leaving the registry unchanged', () => {
    const { settings } = load();
    settings.registerSystemSettingsNamespaces([system('jobs')]);

    expect(codeOf(() => settings.registerSystemSettingsNamespaces([system('jobs')]))).toBe('DUPLICATE_ID');
    expect(settings.systemSettingsNamespaceRegistry.ids()).toEqual(['jobs']);
  });

  it('registers all or nothing: a bad second entry leaves the first unregistered', () => {
    const { settings } = load();

    expect(
      codeOf(() => settings.registerSystemSettingsNamespaces([system('good'), system('Bad-Key')])),
    ).toBe('INVALID_ID');
    expect(settings.systemSettingsNamespaceRegistry.ids()).toEqual([]);
  });

  it('refuses a namespace registered after the request bodies were composed', () => {
    const { settings } = load();
    settings.registerSystemSettingsNamespaces([system('jobs')]);
    settings.markSystemSettingsRequestBodiesComposed();

    expect(() => settings.registerSystemSettingsNamespaces([system('late')])).toThrow(
      /request bodies were already composed/,
    );
    expect(settings.systemSettingsNamespaceRegistry.has('late')).toBe(false);
  });

  it('refuses a secret-named field anywhere in a schema', () => {
    const { settings } = load();
    const leaky = z.object({ nested: z.object({ apiKey: z.string() }) });

    expect(codeOf(() => settings.registerSystemSettingsNamespaces([system('leaky', { storedSchema: leaky })]))).toBe(
      'INVALID_ENTRY',
    );
  });

  it('honours forbiddenKeys on top of the global deny-list', () => {
    const { settings } = load();
    const stored = z.object({ webhookUrl: z.string() });

    expect(
      codeOf(() =>
        settings.registerSystemSettingsNamespaces([
          system('hooks', { storedSchema: stored, forbiddenKeys: ['webhookUrl'], defaults: { webhookUrl: '' } }),
        ]),
      ),
    ).toBe('INVALID_ENTRY');
  });

  it('refuses defaults that do not satisfy storedSchema', () => {
    const { settings } = load();

    expect(codeOf(() => settings.registerSystemSettingsNamespaces([system('jobs', { defaults: { on: 'yes' } })]))).toBe(
      'INVALID_ENTRY',
    );
  });

  it('refuses a key the response reserves for a core field', () => {
    const { settings } = load();

    expect(codeOf(() => settings.registerSystemSettingsNamespaces([system('version')]))).toBe('INVALID_ENTRY');
  });
});

describe('user settings namespace registry', () => {
  it('throws DUPLICATE_ID when a key is registered twice', () => {
    const { settings } = load();
    settings.registerUserSettingsNamespaces([user('graph')]);

    expect(codeOf(() => settings.registerUserSettingsNamespaces([user('graph')]))).toBe('DUPLICATE_ID');
  });

  it('refuses a namespace registered after the request bodies were composed', () => {
    const { settings } = load();
    settings.registerUserSettingsNamespaces([user('graph')]);
    settings.markUserSettingsRequestBodiesComposed();

    expect(() => settings.registerUserSettingsNamespaces([user('late')])).toThrow(
      /request bodies were already composed/,
    );
  });

  it('refuses a .default() anywhere: absent must stay absent', () => {
    const { settings } = load();
    const defaulted = z.object({ n: z.number().default(1) });

    expect(codeOf(() => settings.registerUserSettingsNamespaces([user('graph', { schema: defaulted })]))).toBe(
      'INVALID_ENTRY',
    );
  });

  it('refuses a key that is a core field', () => {
    const { settings } = load();

    expect(codeOf(() => settings.registerUserSettingsNamespaces([user('theme')]))).toBe('INVALID_ENTRY');
    expect(codeOf(() => settings.registerUserSettingsNamespaces([user('profile')]))).toBe('INVALID_ENTRY');
  });

  it('requires a merge function', () => {
    const { settings } = load();

    expect(codeOf(() => settings.registerUserSettingsNamespaces([user('graph', { merge: undefined })]))).toBe(
      'INVALID_ENTRY',
    );
  });
});

describe('composers', () => {
  it('throw the manifest message when the registry is empty (never compose an empty schema)', () => {
    const { settings } = load();

    const systemComposers = [
      settings.composeSystemSettingsSchema,
      settings.composeSystemSettingsPatchSchema,
      settings.composeUpdateSystemSettingsSchema,
      settings.composePatchSystemSettingsSchema,
      settings.composeSystemSettingsResponseSchema,
      settings.composeDefaultSystemSettings,
    ];
    const userComposers = [
      settings.composeUserSettingsSchema,
      settings.composeUserSettingsPatchSchema,
      settings.composeUpdateUserSettingsSchema,
      settings.composePatchUserSettingsSchema,
      settings.composeUserSettingsResponseSchema,
    ];

    for (const compose of [...systemComposers, ...userComposers]) {
      expect(() => compose()).toThrow(MANIFEST_MESSAGE);
    }
  });

  it('compose in registration order and apply each branch rule', () => {
    const { settings } = load();
    settings.registerSystemSettingsNamespaces([
      system('first', { requiredOnPut: true }),
      system('second'),
      system('hidden', { responseSchema: null }),
    ]);
    settings.registerUserSettingsNamespaces([user('alpha'), user('beta', { responseSchema: null })]);

    const keys = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape);

    expect(keys(settings.composeSystemSettingsSchema())).toEqual(['first', 'second', 'hidden']);
    expect(keys(settings.composeSystemSettingsResponseSchema())).toEqual([
      'security',
      'first',
      'second',
      'updatedAt',
      'updatedBy',
      'version',
    ]);
    expect(Object.keys(settings.composeDefaultSystemSettings())).toEqual(['first', 'second', 'hidden']);

    // requiredOnPut: a PUT omitting `first` fails, omitting `second`/`hidden` passes.
    const put = settings.composeUpdateSystemSettingsSchema();
    expect(put.safeParse({ first: { on: true } }).success).toBe(true);
    expect(put.safeParse({ second: { on: true } }).success).toBe(false);
    // PATCH branches are optional.
    expect(settings.composePatchSystemSettingsSchema().safeParse({}).success).toBe(true);

    expect(keys(settings.composeUserSettingsSchema())).toEqual(['theme', 'profile', 'alpha', 'beta']);
    expect(keys(settings.composeUserSettingsResponseSchema())).toEqual([
      'theme',
      'profile',
      'alpha',
      'updatedAt',
      'version',
    ]);
    // `null` clears a user namespace in a PATCH, but is not a valid PUT value.
    expect(settings.composePatchUserSettingsSchema().safeParse({ alpha: null }).success).toBe(true);
    expect(
      settings
        .composeUpdateUserSettingsSchema()
        .safeParse({ theme: 'dark', profile: { imageSource: 'none' }, alpha: null }).success,
    ).toBe(false);
  });

  it('memoise on the registry entries and recompose when one is added', () => {
    const { settings } = load();
    settings.registerSystemSettingsNamespaces([system('first')]);

    const before = settings.composeSystemSettingsSchema();
    expect(settings.composeSystemSettingsSchema()).toBe(before);

    settings.registerSystemSettingsNamespaces([system('second')]);
    const after = settings.composeSystemSettingsSchema();
    expect(after).not.toBe(before);
    expect(Object.keys(after.shape)).toEqual(['first', 'second']);
  });

  it('accept an explicit namespace list without touching the registry', () => {
    const { settings } = load();

    const schema = settings.composeSystemSettingsSchema([system('only')]);

    expect(Object.keys(schema.shape)).toEqual(['only']);
    expect(settings.systemSettingsNamespaceRegistry.size).toBe(0);
  });
});

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_AUTH_PERMISSIONS, KVOX_PERMISSION_KEYS_KEY, KvoxAuthGuard } from '../src/core/index.js';
import { KVOX_SECRETS, KVOX_SETTINGS } from '../src/ports/index.js';
import {
  createFakeKvoxExecutionContext,
  createFakeKvoxIdentity,
  createKvoxTestingModule,
  kvoxPrincipal,
} from '../src/testing/index.js';
import {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  TRANSCRIPTION_SETTINGS_DEFAULTS,
  TranscriptionConfigController,
  TranscriptionConfigService,
  TranscriptionModule,
  TranscriptionProviderRegistry,
  TranscriptionSettingsController,
  TranscriptionSettingsService,
  type TranscriptionModuleOptions,
} from '../src/transcription/index.js';
import { createFakeTranscriptionProvider } from '../src/transcription/testing/index.js';

// =============================================================================
// TranscriptionModule.forRoot over the fake ports (issue #492, epic #491)
// =============================================================================
//
// What the module promises a host: it boots on the ports alone, declares its
// namespace and credential purpose, registers the built-in provider unless told
// not to, registers an extra provider class and lets it be selected, and takes
// its permission strings from the host.
// =============================================================================

/** An extra provider as a host writes it: a plain injectable class. */
class WhisperProvider {
  readonly delegate = createFakeTranscriptionProvider({ id: 'whisper' });
  readonly id = this.delegate.id;
  readonly label = 'Whisper';
  readonly capabilities = this.delegate.capabilities;
  readonly settingsSchema = this.delegate.settingsSchema;
  readonly fieldDescriptors = this.delegate.fieldDescriptors;
  testConnection = this.delegate.testConnection;
  submit = this.delegate.submit;
  getStatus = this.delegate.getStatus;
  fetchResult = this.delegate.fetchResult;
  deleteRemote = this.delegate.deleteRemote;
}

async function boot(options?: TranscriptionModuleOptions): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({ overrides: { identity: createFakeKvoxIdentity() } }),
      TranscriptionModule.forRoot(options),
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('TranscriptionModule.forRoot', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('boots on the ports alone and exports the three services', async () => {
    moduleRef = await boot();

    expect(moduleRef.get(TranscriptionProviderRegistry)).toBeInstanceOf(TranscriptionProviderRegistry);
    expect(moduleRef.get(TranscriptionSettingsService)).toBeInstanceOf(TranscriptionSettingsService);
    expect(moduleRef.get(TranscriptionConfigService)).toBeInstanceOf(TranscriptionConfigService);
  });

  it('declares its namespace and credential purpose through the ports', async () => {
    moduleRef = await boot();

    const settings = moduleRef.get(KVOX_SETTINGS) as { namespaces: Map<string, { defaults: unknown }> };
    const secrets = moduleRef.get(KVOX_SECRETS) as { purposes: Map<string, string> };

    expect(settings.namespaces.get('system:transcription')?.defaults).toEqual(TRANSCRIPTION_SETTINGS_DEFAULTS);
    expect(secrets.purposes.get(TRANSCRIPTION_CREDENTIAL_PURPOSE)).toBe('Transcription provider API key');
  });

  it('registers the AssemblyAI provider by default and not when switched off', async () => {
    moduleRef = await boot();
    expect(moduleRef.get(TranscriptionProviderRegistry).ids()).toEqual(['assemblyai']);
    await moduleRef.close();

    moduleRef = await boot({ providers: { assemblyai: false } });
    expect(moduleRef.get(TranscriptionProviderRegistry).ids()).toEqual([]);
  });

  describe('extraProviders', () => {
    it('registers an extra provider class with the registry', async () => {
      moduleRef = await boot({ extraProviders: [WhisperProvider as never] });

      expect(moduleRef.get(TranscriptionProviderRegistry).ids().sort()).toEqual(['assemblyai', 'whisper']);
    });

    it('lets an administrator select it (the provider id vocabulary is open)', async () => {
      moduleRef = await boot({ extraProviders: [WhisperProvider as never] });
      const service = moduleRef.get(TranscriptionSettingsService);

      await service.update({ settings: { provider: 'whisper' } }, 'admin-1');

      expect((await service.get()).provider).toBe('whisper');
    });

    it('refuses an id nothing registered, naming the registered ids, and writes nothing', async () => {
      moduleRef = await boot({ extraProviders: [WhisperProvider as never] });
      const service = moduleRef.get(TranscriptionSettingsService);

      const error = await service.update({ settings: { provider: 'nonesuch' } }, 'admin-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('assemblyai');
      expect((error as Error).message).toContain('whisper');
      expect((await service.get()).provider).toBeNull();
    });

    it('refuses a settings block for a provider nothing registered', async () => {
      moduleRef = await boot();
      const service = moduleRef.get(TranscriptionSettingsService);

      await expect(
        service.update({ settings: { providers: { whisper: { model: 'base' } } } }, 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports an extra provider with a stored key as available', async () => {
      moduleRef = await boot({ extraProviders: [WhisperProvider as never] });
      const service = moduleRef.get(TranscriptionSettingsService);

      await service.update({ settings: { enabled: true, provider: 'whisper' }, apiKey: 'fake-test-key' }, 'admin-1');

      expect(await moduleRef.get(TranscriptionConfigService).getConfig()).toMatchObject({
        available: true,
        providerLabel: 'Whisper',
      });
    });
  });

  describe('permissions', () => {
    const keysOf = (controller: object, method: string): unknown =>
      Reflect.getMetadata(KVOX_PERMISSION_KEYS_KEY, (controller as Record<string, object>)[method]);

    it('names options on the controllers, and maps them to the web edition\'s strings by default', async () => {
      moduleRef = await boot();

      expect(keysOf(TranscriptionSettingsController.prototype, 'getSettings')).toEqual(['settingsRead']);
      for (const method of ['updateSettings', 'testConnection', 'removeCredential']) {
        expect(keysOf(TranscriptionSettingsController.prototype, method)).toEqual(['settingsWrite']);
      }
      expect(keysOf(TranscriptionConfigController.prototype, 'getConfig')).toEqual(['configRead']);

      expect(moduleRef.get(KVOX_AUTH_PERMISSIONS)).toEqual({
        settingsRead: 'system_settings:read',
        settingsWrite: 'system_settings:write',
        configRead: 'transcripts:read',
      });
    });

    it('takes the host\'s strings, keeping the default of any it leaves out', async () => {
      moduleRef = await boot({ permissions: { settingsWrite: 'desktop:admin', configRead: undefined } });

      expect(moduleRef.get(KVOX_AUTH_PERMISSIONS)).toEqual({
        settingsRead: 'system_settings:read',
        settingsWrite: 'desktop:admin',
        configRead: 'transcripts:read',
      });
    });

    it('is enforced by the guard through the module\'s own map', async () => {
      moduleRef = await boot({ permissions: { settingsRead: 'desktop:settings' } });
      const guardFor = (permissions: string[]) =>
        new KvoxAuthGuard(
          createFakeKvoxIdentity({ principal: kvoxPrincipal({ permissions }) }),
          new Reflector(),
          moduleRef?.get(KVOX_AUTH_PERMISSIONS),
        );
      const readRoute = () => {
        const context = createFakeKvoxExecutionContext({ authorization: 'Bearer x' });
        (context as unknown as { getHandler: () => unknown }).getHandler = () =>
          TranscriptionSettingsController.prototype.getSettings;
        (context as unknown as { getClass: () => unknown }).getClass = () => TranscriptionSettingsController;
        return context;
      };

      // The default string no longer opens the read route; the host's does.
      const refused = await guardFor(['system_settings:read']).canActivate(readRoute()).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ForbiddenException);
      expect((refused as Error).message).toContain('desktop:settings');
      await expect(guardFor(['desktop:settings']).canActivate(readRoute())).resolves.toBe(true);
    });
  });
});

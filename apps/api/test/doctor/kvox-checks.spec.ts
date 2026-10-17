// =============================================================================
// This app's Doctor checks (issue #464, epic #462)
// =============================================================================
//
// `<slug>.db.extensions` and `<slug>.transcription.configured`. The decision of
// each check is a pure function, driven here without a database; the `run()` of
// each is driven over doubles to prove it reads what it should and writes
// nothing. Whether the whole Doctor stays read-only is the platform
// `doctor-read-only` suite's job (`test/conformance.spec.ts`).
// =============================================================================

import { APP_SLUG } from '@app/shared';
import {
  DoctorCheckRegistry,
  type DoctorCheckOutcome,
} from '@marinoscar/platform-api/doctor';
import {
  createRecordingPrisma,
  describeDoctorCheckConformance,
  runDoctorCheck,
} from '@marinoscar/platform-api/doctor/testing';

import {
  DbExtensionsDoctorCheck,
  REQUIRED_DB_EXTENSIONS,
  decideDbExtensions,
} from '../../src/doctor/checks/db-extensions.doctor-check';
import {
  TRANSCRIPTION_CREDENTIAL_PURPOSE,
  transcriptionCredentialName,
} from '@marinoscar/kvox-api/transcription';
import {
  TranscriptionConfiguredDoctorCheck,
  decideTranscriptionConfigured,
} from '../../src/kvox/transcription/transcription-configured.doctor-check';

/** Every string value the outcome would put on the wire (`detail`, `remedy`, `data`). */
function wireText(outcome: DoctorCheckOutcome): string {
  return JSON.stringify([outcome.detail, outcome.remedy, outcome.data]);
}

describe(`${APP_SLUG}.db.extensions`, () => {
  describe('decideDbExtensions', () => {
    it('passes when both extensions are installed', () => {
      const outcome = decideDbExtensions(['vector', 'pg_trgm']);

      expect(outcome.status).toBe('pass');
      expect(outcome.data).toEqual({ required: 'vector,pg_trgm', missing: '' });
    });

    it('passes when other extensions are installed too', () => {
      expect(decideDbExtensions(['plpgsql', 'vector', 'pg_trgm', 'uuid-ossp']).status).toBe('pass');
    });

    it.each([
      ['vector', ['pg_trgm']],
      ['pg_trgm', ['vector']],
    ])('fails with the remedy when %s is missing', (missing, installed) => {
      const outcome = decideDbExtensions(installed);

      expect(outcome.status).toBe('fail');
      expect(outcome.remedy).toBe('create the extension as a superuser before migrating');
      expect(outcome.detail).toContain(missing);
      expect(outcome.data).toEqual({ required: 'vector,pg_trgm', missing });
    });

    it('fails naming both when none is installed', () => {
      const outcome = decideDbExtensions([]);

      expect(outcome.status).toBe('fail');
      expect(outcome.data).toEqual({ required: 'vector,pg_trgm', missing: 'vector,pg_trgm' });
    });

    it('exposes extension names only in the details', () => {
      const outcome = decideDbExtensions(['pg_trgm']);

      expect(Object.keys(outcome.data ?? {}).sort()).toEqual(['missing', 'required']);
      const names = new Set<string>(REQUIRED_DB_EXTENSIONS);
      for (const value of Object.values(outcome.data ?? {})) {
        for (const part of String(value).split(',').filter(Boolean)) {
          expect(names.has(part)).toBe(true);
        }
      }
    });

    it('ignores the order of the installed extensions', () => {
      expect(decideDbExtensions(['pg_trgm', 'vector']).status).toBe('pass');
    });
  });

  describe('run', () => {
    it('is registered under the app slug, in the core category, after the connection check', () => {
      const registry = new DoctorCheckRegistry();
      const check = new DbExtensionsDoctorCheck(registry, createRecordingPrisma().client);

      check.onModuleInit();

      expect(check.id).toBe(`${APP_SLUG}.db.extensions`);
      expect(check.dependsOn).toEqual(['db.connection']);
      expect(registry.get(check.id)).toBe(check);
    });

    it('reads pg_extension with one query and fails when the catalog lacks an extension', async () => {
      const prisma = createRecordingPrisma({ results: { $queryRaw: [{ extname: 'pg_trgm' }] } });
      const check = new DbExtensionsDoctorCheck(new DoctorCheckRegistry(), prisma.client);

      const run = await runDoctorCheck(check);

      expect(run.outcome?.status).toBe('fail');
      expect(run.outcome?.data).toEqual({ required: 'vector,pg_trgm', missing: 'vector' });
      expect(prisma.operations()).toHaveLength(1);
      expect(prisma.violations()).toEqual([]);
    });

    it('passes when the catalog lists both extensions', async () => {
      const prisma = createRecordingPrisma({
        results: { $queryRaw: [{ extname: 'vector' }, { extname: 'pg_trgm' }] },
      });
      const check = new DbExtensionsDoctorCheck(new DoctorCheckRegistry(), prisma.client);

      expect((await runDoctorCheck(check)).outcome?.status).toBe('pass');
    });
  });

  describeDoctorCheckConformance(
    `${APP_SLUG}.db.extensions`,
    ({ prisma }) => new DbExtensionsDoctorCheck(new DoctorCheckRegistry(), prisma.client),
    {
      scenarios: [
        { name: 'both installed', prisma: { results: { $queryRaw: [{ extname: 'vector' }, { extname: 'pg_trgm' }] } }, expectStatus: 'pass' },
        { name: 'one missing', prisma: { results: { $queryRaw: [{ extname: 'vector' }] } }, expectStatus: 'fail' },
      ],
    },
  );
});

describe(`${APP_SLUG}.transcription.configured`, () => {
  describe('decideTranscriptionConfigured', () => {
    it('warns when no provider is configured', () => {
      const outcome = decideTranscriptionConfigured({ enabled: true, provider: null }, false);

      expect(outcome.status).toBe('warn');
      expect(outcome.remedy).toBeTruthy();
      expect(outcome.data).toEqual({ provider: null, keyStored: false, enabled: true });
    });

    it('warns when no provider is configured, even if transcription is switched off', () => {
      expect(decideTranscriptionConfigured({ enabled: false, provider: null }, false).status).toBe('warn');
    });

    it('warns when the selected provider has no stored key', () => {
      const outcome = decideTranscriptionConfigured({ enabled: true, provider: 'assemblyai' }, false);

      expect(outcome.status).toBe('warn');
      expect(outcome.detail).toContain('assemblyai');
      expect(outcome.remedy).toBeTruthy();
      expect(outcome.data).toEqual({ provider: 'assemblyai', keyStored: false, enabled: true });
    });

    it('passes when the selected provider has a stored key', () => {
      const outcome = decideTranscriptionConfigured({ enabled: true, provider: 'assemblyai' }, true);

      expect(outcome.status).toBe('pass');
      expect(outcome.remedy).toBeUndefined();
      expect(outcome.data).toEqual({ provider: 'assemblyai', keyStored: true, enabled: true });
    });

    it('passes when transcription is switched off but a provider and key are in place', () => {
      const outcome = decideTranscriptionConfigured({ enabled: false, provider: 'assemblyai' }, true);

      expect(outcome.status).toBe('pass');
      expect(outcome.detail).toContain('switched off');
      expect(outcome.data).toEqual({ provider: 'assemblyai', keyStored: true, enabled: false });
    });

    it('never fails: a deployment without speech-to-text is a valid one', () => {
      for (const provider of [null, 'assemblyai']) {
        for (const keyStored of [false, true]) {
          for (const enabled of [false, true]) {
            expect(decideTranscriptionConfigured({ enabled, provider }, keyStored).status).not.toBe('fail');
          }
        }
      }
    });
  });

  describe('run', () => {
    function build(policy: { enabled?: boolean; provider?: string | null }, keyStored: boolean) {
      const settings = { get: jest.fn().mockResolvedValue(policy) };
      const credentials = {
        describe: jest.fn().mockResolvedValue(keyStored ? { name: 'x', createdAt: new Date() } : null),
      };
      const registry = new DoctorCheckRegistry();
      const check = new TranscriptionConfiguredDoctorCheck(registry, settings as never, credentials as never);
      return { check, settings, credentials, registry };
    }

    it('registers itself under the app slug', () => {
      const { check, registry } = build({}, false);

      check.onModuleInit();

      expect(check.id).toBe(`${APP_SLUG}.transcription.configured`);
      expect(registry.get(check.id)).toBe(check);
    });

    it('does not look for a key when no provider is selected', async () => {
      const { check, credentials } = build({ enabled: true, provider: null }, false);

      const outcome = await check.run();

      expect(outcome.status).toBe('warn');
      expect(credentials.describe).not.toHaveBeenCalled();
    });

    it('asks only whether the selected provider has a stored key (presence, no decryption)', async () => {
      const { check, credentials } = build({ enabled: true, provider: 'assemblyai' }, true);

      const outcome = await check.run();

      expect(outcome.status).toBe('pass');
      expect(credentials.describe).toHaveBeenCalledTimes(1);
      expect(credentials.describe).toHaveBeenCalledWith(
        TRANSCRIPTION_CREDENTIAL_PURPOSE,
        transcriptionCredentialName('assemblyai'),
      );
    });

    it('warns for a selected provider without a key', async () => {
      const { check } = build({ enabled: true, provider: 'assemblyai' }, false);

      expect((await check.run()).status).toBe('warn');
    });

    it('passes when transcription is switched off but configured', async () => {
      const { check } = build({ enabled: false, provider: 'assemblyai' }, true);

      expect((await check.run()).status).toBe('pass');
    });

    it('treats a missing `enabled` as off', async () => {
      const { check } = build({ provider: 'assemblyai' }, true);

      expect((await check.run()).data).toMatchObject({ enabled: false });
    });

    it('carries no key material in anything it reports', async () => {
      const secret = 'sk-live-do-not-leak';
      const { check, credentials } = build({ enabled: true, provider: 'assemblyai' }, true);
      credentials.describe.mockResolvedValue({ name: 'assemblyai', createdAt: new Date(), value: secret });

      expect(wireText(await check.run())).not.toContain(secret);
    });
  });
});

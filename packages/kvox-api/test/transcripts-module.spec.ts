import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_PERMISSIONS_KEY, KvoxAuthGuard } from '../src/core/index.js';
import { KVOX_JOBS } from '../src/ports/index.js';
import {
  OwnerOnlyTranscriptSharing,
  TRANSCRIPT_JOB_TYPES,
  TRANSCRIPTS_NOTIFICATION_EVENTS,
  TRANSCRIPTS_PERMISSIONS,
  TranscriptAccessService,
  TranscriptExporterRegistry,
  TranscriptNameChecksController,
  TranscriptPipelineService,
  TranscriptSharing,
  TranscriptsController,
  TranscriptsHousekeepingEnqueuer,
  TranscriptsModule,
  TranscriptsService,
  type TranscriptsModuleOptions,
} from '../src/transcripts/index.js';
import {
  DEFAULT_PLAYBACK_URL_TTL_SECONDS,
  DEFAULT_STALE_UPLOAD_HOURS,
  TRANSCRIPTS_MODULE_OPTIONS,
} from '../src/transcripts/transcripts.options.js';
import { TranscriptsHousekeepingTask } from '../src/transcripts/tasks/transcripts-housekeeping.task.js';
import {
  createFakeKvoxAi,
  createFakeKvoxIdentity,
  createKvoxTestingModule,
  type FakeKvoxJobs,
} from '../src/testing/index.js';

// =============================================================================
// TranscriptsModule.forRoot over the fake ports (issue #493, epic #491)
// =============================================================================
//
// What the module promises a host: it boots on the ports alone, registers its nine job types
// through the job port, binds owner-only sharing unless the host brings its own, takes its
// numbers from options (never the environment), lets the cron and the transcoder be left
// out, and carries the permission strings the routes enforce.
// =============================================================================

async function boot(options?: TranscriptsModuleOptions): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({ overrides: { identity: createFakeKvoxIdentity(), ai: createFakeKvoxAi() } }),
      TranscriptsModule.forRoot(options),
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('TranscriptsModule.forRoot', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('boots on the ports alone and exports the services other slices use', async () => {
    moduleRef = await boot();

    expect(moduleRef.get(TranscriptsService)).toBeInstanceOf(TranscriptsService);
    expect(moduleRef.get(TranscriptAccessService)).toBeInstanceOf(TranscriptAccessService);
    expect(moduleRef.get(TranscriptPipelineService)).toBeInstanceOf(TranscriptPipelineService);
    expect(moduleRef.get(TranscriptsHousekeepingEnqueuer)).toBeInstanceOf(TranscriptsHousekeepingEnqueuer);
  });

  it('is not global: only a module that imports it can reach its providers', () => {
    expect(TranscriptsModule.forRoot().global).toBe(false);
  });

  it('registers every job type through the job port when the module starts', async () => {
    moduleRef = await boot();

    const jobs = moduleRef.get(KVOX_JOBS) as FakeKvoxJobs;

    for (const type of TRANSCRIPT_JOB_TYPES) expect({ type, registered: jobs.isRegistered(type) }).toEqual({ type, registered: true });
  });

  it('leaves the transcoder out when media.transcode is false', async () => {
    moduleRef = await boot({ media: { transcode: false } });

    const jobs = moduleRef.get(KVOX_JOBS) as FakeKvoxJobs;

    expect(jobs.isRegistered('media.audio.transcode')).toBe(false);
    expect(jobs.isRegistered('transcription.submit')).toBe(true);
  });

  it('binds owner-only sharing unless the host brings its own', async () => {
    moduleRef = await boot();

    expect(moduleRef.get(TranscriptSharing, { strict: false })).toBeInstanceOf(OwnerOnlyTranscriptSharing);
  });

  it('uses the sharing class a host passes', async () => {
    class HostSharing extends OwnerOnlyTranscriptSharing {}

    moduleRef = await boot({ sharing: HostSharing });

    expect(moduleRef.get(TranscriptSharing, { strict: false })).toBeInstanceOf(HostSharing);
  });

  describe('schedules', () => {
    it('provides the housekeeping cron by default and omits it with schedules: false', async () => {
      const withCron = TranscriptsModule.forRoot();
      const without = TranscriptsModule.forRoot({ schedules: false });

      expect(withCron.providers).toContain(TranscriptsHousekeepingTask);
      expect(without.providers).not.toContain(TranscriptsHousekeepingTask);
      // The enqueuer is always there: a host that schedules itself calls `enqueue()`.
      expect(without.providers).toContain(TranscriptsHousekeepingEnqueuer);
    });

    it('the cron only enqueues: its handler delegates to the enqueuer', async () => {
      const enqueuer = { enqueue: jest.fn().mockResolvedValue(undefined) };
      const task = new TranscriptsHousekeepingTask(...([] as unknown as ConstructorParameters<typeof TranscriptsHousekeepingTask>));

      Object.assign(task, { enqueue: enqueuer.enqueue });

      await task.handleCron();

      expect(enqueuer.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('options', () => {
    it('defaults the numbers and reads nothing from the environment', async () => {
      moduleRef = await boot();

      expect(moduleRef.get(TRANSCRIPTS_MODULE_OPTIONS, { strict: false })).toMatchObject({
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        playbackUrlTtlSeconds: DEFAULT_PLAYBACK_URL_TTL_SECONDS,
        staleUploadHours: DEFAULT_STALE_UPLOAD_HOURS,
      });
      expect(DEFAULT_PLAYBACK_URL_TTL_SECONDS).toBe(21_600);
      expect(DEFAULT_STALE_UPLOAD_HOURS).toBe(72);
    });

    it('takes the binaries, the TTL and the stale window from the host', async () => {
      moduleRef = await boot({
        media: { ffmpegPath: '/opt/ffmpeg', ffprobePath: '/opt/ffprobe' },
        playbackUrlTtlSeconds: 600,
        staleUploadHours: 24,
        appUrl: () => 'https://app.example.test',
      });

      const resolved = moduleRef.get(TRANSCRIPTS_MODULE_OPTIONS, { strict: false }) as {
        ffmpegPath: string;
        appUrl: () => string | undefined;
      };

      expect(resolved).toMatchObject({
        ffmpegPath: '/opt/ffmpeg',
        ffprobePath: '/opt/ffprobe',
        playbackUrlTtlSeconds: 600,
        staleUploadHours: 24,
      });
      expect(resolved.appUrl()).toBe('https://app.example.test');
    });

    it('registers the three built-in exporters, and drops the ones switched off', async () => {
      moduleRef = await boot();
      expect(moduleRef.get(TranscriptExporterRegistry).formats()).toEqual(['json', 'markdown', 'pdf']);

      await moduleRef.close();
      moduleRef = await boot({ exporters: { pdf: false } });
      expect(moduleRef.get(TranscriptExporterRegistry).formats()).toEqual(['json', 'markdown']);
    });
  });

  describe('permissions and routes', () => {
    it('declares the two strings the routes enforce, org-scoped and held by the three org roles', () => {
      expect(TRANSCRIPTS_PERMISSIONS.map((permission) => permission.id)).toEqual([
        'transcripts:read',
        'transcripts:write',
      ]);

      for (const permission of TRANSCRIPTS_PERMISSIONS) {
        expect(permission.scope).toBe('org');
      }
    });

    it('declares the two notification events the pipeline emits', () => {
      expect(TRANSCRIPTS_NOTIFICATION_EVENTS.map((event) => event.key).sort()).toEqual([
        'transcripts.transcript_failed',
        'transcripts.transcript_ready',
      ]);
    });

    it('puts KvoxAuthGuard on every route of both controllers, with a read or write permission', () => {
      for (const controller of [TranscriptsController, TranscriptNameChecksController]) {
        const methods = Object.getOwnPropertyNames(controller.prototype).filter((name) => {
          const handler = (controller.prototype as unknown as Record<string, object>)[name];

          return name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, handler as object) !== undefined;
        });

        expect(methods.length).toBeGreaterThan(0);

        for (const method of methods) {
          const handler = (controller.prototype as unknown as Record<string, object>)[method]!;
          const permissions = Reflect.getMetadata(KVOX_PERMISSIONS_KEY, handler) as string[];

          expect(Reflect.getMetadata('__guards__', handler)).toContain(KvoxAuthGuard);
          expect({ method, permissions: permissions.length }).toEqual({ method, permissions: 1 });
          expect(['transcripts:read', 'transcripts:write']).toContain(permissions[0]);
        }
      }
    });

    it('mounts the routes where the web application has always had them', () => {
      expect(Reflect.getMetadata(PATH_METADATA, TranscriptsController)).toBe('transcripts');
      expect(Reflect.getMetadata(PATH_METADATA, TranscriptNameChecksController)).toBe('transcripts');

      const nameCreate = (TranscriptNameChecksController.prototype as unknown as Record<string, object>)['create']!;

      expect(Reflect.getMetadata(PATH_METADATA, nameCreate)).toBe(':id/name-checks');

      const create = (TranscriptsController.prototype as unknown as Record<string, object>)['create']!;

      expect(Reflect.getMetadata(METHOD_METADATA, create)).toBe(RequestMethod.POST);
    });
  });
});

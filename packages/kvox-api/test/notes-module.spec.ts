import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_PERMISSIONS_KEY, KvoxAuthGuard } from '../src/core/index.js';
import { KVOX_JOBS } from '../src/ports/index.js';
import { SearchIndexingModule } from '../src/search/index.js';
import { TranscriptsModule } from '../src/transcripts/index.js';
import {
  NOTE_JOB_TYPES,
  NOTE_TEMPLATES_PERMISSIONS,
  NOTES_NOTIFICATION_EVENTS,
  NOTES_PERMISSIONS,
  NoteAccessService,
  NoteExporterRegistry,
  NoteGenerationStreamController,
  NoteSourcesController,
  NoteTemplatesController,
  NotesController,
  NotesHousekeepingEnqueuer,
  NotesModule,
  NotesService,
  NotesUserDataService,
  type NotesModuleOptions,
} from '../src/notes/index.js';
import { NOTES_MODULE_OPTIONS } from '../src/notes/notes.options.js';
import { NotesHousekeepingTask } from '../src/notes/tasks/notes-housekeeping.task.js';
import {
  createFakeKvoxAi,
  createFakeKvoxIdentity,
  createKvoxTestingModule,
  type FakeKvoxJobs,
} from '../src/testing/index.js';

// =============================================================================
// NotesModule.forRoot over the fake ports (issue #495, epic #491)
// =============================================================================
//
// What the module promises a host: it boots on the ports alone with the peer slices it is
// given, registers its six job types through the job port, takes its numbers from options
// (never the environment), lets the cron and an exporter be left out, and carries the
// permission strings the routes enforce.
// =============================================================================

async function boot(options: NotesModuleOptions = {}): Promise<TestingModule> {
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({ schedules: false, peers: { searchIndexing } });
  const moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({ overrides: { identity: createFakeKvoxIdentity(), ai: createFakeKvoxAi() } }),
      NotesModule.forRoot({ schedules: false, peers: { transcripts, searchIndexing }, ...options }),
    ],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

describe('NotesModule.forRoot', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('boots on the ports and the peer slices and exports the services other slices use', async () => {
    moduleRef = await boot();

    expect(moduleRef.get(NotesService)).toBeInstanceOf(NotesService);
    expect(moduleRef.get(NoteAccessService)).toBeInstanceOf(NoteAccessService);
    expect(moduleRef.get(NotesUserDataService)).toBeInstanceOf(NotesUserDataService);
    expect(moduleRef.get(NotesHousekeepingEnqueuer)).toBeInstanceOf(NotesHousekeepingEnqueuer);
  });

  it('is not global: only a module that imports it can reach its providers', () => {
    expect(NotesModule.forRoot({ schedules: false }).global).toBe(false);
  });

  it('registers every job type through the job port when the module starts', async () => {
    moduleRef = await boot();

    const jobs = moduleRef.get(KVOX_JOBS) as FakeKvoxJobs;

    expect([...NOTE_JOB_TYPES].sort()).toEqual([
      'note.export',
      'note.generate',
      'note.purge',
      'note.retitle',
      'note.source.extract',
      'notes.housekeeping',
    ]);

    for (const type of NOTE_JOB_TYPES) expect({ type, registered: jobs.isRegistered(type) }).toEqual({ type, registered: true });
  });

  describe('schedules', () => {
    it('provides the housekeeping cron by default and omits it with schedules: false', () => {
      const withCron = NotesModule.forRoot();
      const without = NotesModule.forRoot({ schedules: false });

      expect(withCron.providers).toContain(NotesHousekeepingTask);
      expect(without.providers).not.toContain(NotesHousekeepingTask);
      // The enqueuer is always there: a host that schedules itself calls `enqueue()`.
      expect(without.providers).toContain(NotesHousekeepingEnqueuer);
    });

    it('the cron only enqueues: its handler delegates to the enqueuer', async () => {
      const task = new NotesHousekeepingTask(...([] as unknown as ConstructorParameters<typeof NotesHousekeepingTask>));
      const enqueue = jest.fn().mockResolvedValue(undefined);

      Object.assign(task, { enqueue });

      await task.handleCron();

      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe('options', () => {
    it('reads nothing from the environment and takes the app URL from the host', async () => {
      moduleRef = await boot({ appUrl: () => 'https://app.example.test' });

      const resolved = moduleRef.get(NOTES_MODULE_OPTIONS, { strict: false }) as {
        appUrl: () => string | undefined;
        documentPdf: boolean;
        documentText: boolean;
      };

      expect(resolved.appUrl()).toBe('https://app.example.test');
      expect(resolved).toMatchObject({ documentPdf: true, documentText: true });
    });

    it('registers the three built-in exporters, and drops the ones switched off', async () => {
      moduleRef = await boot();
      expect(moduleRef.get(NoteExporterRegistry).formats()).toEqual(['docx', 'markdown', 'pdf']);

      await moduleRef.close();
      moduleRef = await boot({ exporters: { pdf: false, docx: false } });
      expect(moduleRef.get(NoteExporterRegistry).formats()).toEqual(['markdown']);
    });
  });

  describe('permissions and routes', () => {
    it('declares the notes and template strings, org-scoped, held by the three org roles', () => {
      expect([...NOTES_PERMISSIONS, ...NOTE_TEMPLATES_PERMISSIONS].map((permission) => permission.id)).toEqual([
        'notes:read',
        'notes:write',
        'note_templates:read',
        'note_templates:write',
      ]);

      for (const permission of [...NOTES_PERMISSIONS, ...NOTE_TEMPLATES_PERMISSIONS]) {
        expect(permission.scope).toBe('org');
        expect(permission.defaultGrants).toEqual(['org_admin', 'contributor', 'viewer']);
      }
    });

    it('declares the two notification events the pipeline emits', () => {
      expect(NOTES_NOTIFICATION_EVENTS.map((event) => event.key).sort()).toEqual([
        'notes.note_failed',
        'notes.note_ready',
      ]);
    });

    it('puts KvoxAuthGuard on every route of the four controllers, with one permission', () => {
      const allowed = ['notes:read', 'notes:write', 'note_templates:read', 'note_templates:write'];

      for (const controller of [
        NotesController,
        NoteSourcesController,
        NoteTemplatesController,
        NoteGenerationStreamController,
      ]) {
        const methods = Object.getOwnPropertyNames(controller.prototype).filter((name) => {
          const handler = (controller.prototype as unknown as Record<string, object>)[name];

          return name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, handler as object) !== undefined;
        });

        expect(methods.length).toBeGreaterThan(0);

        for (const method of methods) {
          const handler = (controller.prototype as unknown as Record<string, object>)[method]!;
          const permissions = Reflect.getMetadata(KVOX_PERMISSIONS_KEY, handler) as string[];

          expect(Reflect.getMetadata('__guards__', handler)).toContain(KvoxAuthGuard);
          expect({ controller: controller.name, method, permissions: permissions.length }).toEqual({
            controller: controller.name,
            method,
            permissions: 1,
          });
          expect(allowed).toContain(permissions[0]);
        }
      }
    });

    it('mounts the routes where the web application has always had them', () => {
      expect(Reflect.getMetadata(PATH_METADATA, NotesController)).toBe('notes');
      expect(Reflect.getMetadata(PATH_METADATA, NoteSourcesController)).toBe('notes/sources');
      expect(Reflect.getMetadata(PATH_METADATA, NoteTemplatesController)).toBe('note-templates');
    });
  });
});

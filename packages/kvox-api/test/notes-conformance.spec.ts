import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_JOBS, type KvoxJobHandler } from '../src/ports/index.js';
import { MarkdownNoteExporter } from '../src/notes/export/markdown.exporter.js';
import { PdfNoteExporter } from '../src/notes/export/pdf.exporter.js';
import { WordNoteExporter } from '../src/notes/export/word.exporter.js';
import { SearchIndexingModule } from '../src/search/index.js';
import { TranscriptsModule } from '../src/transcripts/index.js';
import { NotesModule } from '../src/notes/notes.module.js';
import { describeNoteExporterConformance, describeNotesConformance } from '../src/notes/testing/index.js';
import {
  createFakeKvoxAi,
  createFakeKvoxIdentity,
  createKvoxTestingModule,
  type FakeKvoxJobs,
} from '../src/testing/index.js';

// =============================================================================
// The notes conformance suites over the package's own binding (issue #495, epic #491)
// =============================================================================
//
// The slice exports `describeNotesConformance` and `describeNoteExporterConformance`
// (`@marinoscar/kvox-api/notes/testing`) so a host proves ITS binding with the same assertions.
// This is the package's run: the real module booted over the fake ports, its six handlers as
// the job port registered them. The web application runs the same suites over its own binding
// in `apps/api/test/conformance.spec.ts`.
// =============================================================================

let moduleRef: TestingModule | undefined;

async function boot(): Promise<TestingModule> {
  // One object per peer, as a host holds them: a slice imported twice with separately built
  // options would register its handler twice.
  const searchIndexing = SearchIndexingModule.forRoot();
  const transcripts = TranscriptsModule.forRoot({ schedules: false, peers: { searchIndexing } });

  moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({
        overrides: {
          identity: createFakeKvoxIdentity(),
          ai: createFakeKvoxAi(),
        },
      }),
      NotesModule.forRoot({ schedules: false, peers: { transcripts, searchIndexing } }),
    ],
  }).compile();

  await moduleRef.init();

  return moduleRef;
}

afterAll(async () => {
  await moduleRef?.close();
});

describeNotesConformance(
  'the package binding over the fake ports',
  async () => {
    const app = await boot();
    const jobs = app.get(KVOX_JOBS) as FakeKvoxJobs;

    return { handlers: jobs.handlers as readonly KvoxJobHandler[] };
  },
  { describe, it, expect },
);

const registry = { register: () => undefined } as never;

describeNoteExporterConformance(new MarkdownNoteExporter(registry), { describe, it, expect });

describeNoteExporterConformance(new PdfNoteExporter(registry, undefined, undefined), { describe, it, expect }, { minBytes: 500 });

describeNoteExporterConformance(new WordNoteExporter(registry), { describe, it, expect }, { minBytes: 500 });

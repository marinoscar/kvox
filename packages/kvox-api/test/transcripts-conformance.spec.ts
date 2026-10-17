import { Test, type TestingModule } from '@nestjs/testing';

import { KVOX_JOBS, type KvoxJobHandler } from '../src/ports/index.js';
import { JsonTranscriptExporter } from '../src/transcripts/export/json.exporter.js';
import { MarkdownTranscriptExporter } from '../src/transcripts/export/markdown.exporter.js';
import { PdfTranscriptExporter } from '../src/transcripts/export/pdf.exporter.js';
import { TranscriptPipelineService } from '../src/transcripts/transcript-pipeline.service.js';
import { TranscriptsModule } from '../src/transcripts/transcripts.module.js';
import { resolveTranscriptsOptions } from '../src/transcripts/transcripts.options.js';
import {
  describeTranscriptExporterConformance,
  describeTranscriptsConformance,
} from '../src/transcripts/testing/index.js';
import {
  createFakeKvoxAi,
  createFakeKvoxIdentity,
  createKvoxTestingModule,
  type FakeKvoxJobs,
} from '../src/testing/index.js';

// =============================================================================
// The transcripts conformance suites over the package's own binding (issue #493, epic #491)
// =============================================================================
//
// The slice exports `describeTranscriptsConformance` and
// `describeTranscriptExporterConformance` (`@marinoscar/kvox-api/transcripts/testing`) so a
// host proves ITS binding with the same assertions. This is the package's run: the real
// module booted over the fake ports, its nine handlers as the job port registered them.
// The web application runs the same suites over its own binding in
// `apps/api/test/conformance.spec.ts`.
// =============================================================================

let moduleRef: TestingModule | undefined;

async function boot(): Promise<TestingModule> {
  moduleRef = await Test.createTestingModule({
    imports: [
      createKvoxTestingModule({
        overrides: {
          identity: createFakeKvoxIdentity(),
          ai: createFakeKvoxAi(),
        },
      }),
      TranscriptsModule.forRoot({ schedules: false }),
    ],
  }).compile();

  await moduleRef.init();

  return moduleRef;
}

afterAll(async () => {
  await moduleRef?.close();
});

describeTranscriptsConformance(
  'the package binding over the fake ports',
  async () => {
    const app = await boot();
    const jobs = app.get(KVOX_JOBS) as FakeKvoxJobs;

    return {
      handlers: jobs.handlers as readonly KvoxJobHandler[],
      // The same service class over the given port: enqueuing is the only thing the poll
      // invariant exercises, and it reads nothing else.
      pipelineFor: (port) =>
        new TranscriptPipelineService(
          {} as never,
          port,
          {} as never,
          resolveTranscriptsOptions({}),
          {} as never,
          {} as never,
        ),
    };
  },
  { describe, it, expect },
);

describeTranscriptExporterConformance(new JsonTranscriptExporter({ register: () => undefined } as never), {
  describe,
  it,
  expect,
});

describeTranscriptExporterConformance(new MarkdownTranscriptExporter({ register: () => undefined } as never), {
  describe,
  it,
  expect,
});

describeTranscriptExporterConformance(
  new PdfTranscriptExporter({ register: () => undefined } as never, undefined, undefined),
  { describe, it, expect },
  { minBytes: 500 },
);

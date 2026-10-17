import { BadRequestException, InternalServerErrorException } from '@nestjs/common';

import { TranscriptsController } from '../../src/transcripts/transcripts.controller.js';
import type { TranscriptImportService } from '../../src/transcripts/import/transcript-import.service.js';

function makeController(imports: unknown) {
  return new TranscriptsController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    imports as TranscriptImportService,
    { maxImportBytes: 1024 } as never,
  );
}

// A host that never registered `@fastify/multipart` leaves the request without `isMultipart`.
// The route must answer a 500 naming the plugin, not a bare TypeError (issue #592).
describe('TranscriptsController.importTranscript without @fastify/multipart', () => {
  it('throws an InternalServerErrorException naming @fastify/multipart', async () => {
    const imports = { start: jest.fn() };
    const controller = makeController(imports);

    const call = controller.importTranscript({} as never, { id: 'user-1' } as never);

    await expect(call).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(call).rejects.toThrow('@fastify/multipart');
    expect(imports.start).not.toHaveBeenCalled();
  });

  it('still answers a 400 when the request is not multipart', async () => {
    const file = jest.fn();
    const controller = makeController({});

    const call = controller.importTranscript(
      { isMultipart: () => false, file } as never,
      { id: 'user-1' } as never,
    );

    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    expect(file).not.toHaveBeenCalled();
  });
});

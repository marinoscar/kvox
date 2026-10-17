import { InternalServerErrorException } from '@nestjs/common';

import { NoteSourcesController } from '../../src/notes/note-sources.controller.js';
import type { NoteSourcesService } from '../../src/notes/note-sources.service.js';

// A host that never registered `@fastify/multipart` leaves the request without `isMultipart`.
// The route must answer a 500 naming the plugin, not a bare TypeError (issue #592).
describe('NoteSourcesController without @fastify/multipart', () => {
  it('throws an InternalServerErrorException naming @fastify/multipart', async () => {
    const maxDocumentBytes = jest.fn();
    const controller = new NoteSourcesController({ maxDocumentBytes } as unknown as NoteSourcesService);

    const call = controller.uploadDocument({} as never, 'user-1');

    await expect(call).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(call).rejects.toThrow('@fastify/multipart');
    expect(maxDocumentBytes).not.toHaveBeenCalled();
  });
});

import { InternalServerErrorException } from '@nestjs/common';

import { GraphImportController } from '../../src/graph-rdf/import/graph-import.controller.js';
import type { GraphImportService } from '../../src/graph-rdf/import/graph-import.service.js';

// A host that never registered `@fastify/multipart` leaves the request without `isMultipart`.
// The route must answer a 500 naming the plugin, not a bare TypeError (issue #592).
describe('GraphImportController without @fastify/multipart', () => {
  it('throws an InternalServerErrorException naming @fastify/multipart', async () => {
    const imports = { start: jest.fn() } as unknown as GraphImportService;
    const controller = new GraphImportController(imports, {} as never);

    const call = controller.upload({} as never, { id: 'user-1' } as never);

    await expect(call).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(call).rejects.toThrow('@fastify/multipart');
  });
});

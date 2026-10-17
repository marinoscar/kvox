import { type Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath, type ApiResponseSchemaHost } from '@nestjs/swagger';

// =============================================================================
// Documenting a response that travels in the `{ data: ... }` envelope (issue #494)
// =============================================================================
//
// The host wraps every response in `{ data }` with a global interceptor. A route
// documented with a bare `@ApiResponse({ type: Dto })` advertises the bare inner
// object, so the document would describe a shape the server never sends. This
// declares the envelope once, naming the DTO the way the web edition's own
// `ApiDataResponse` does, so a route that moved out of the application keeps its
// entry in the generated API document byte for byte. A host that does not wrap its
// responses simply never reads the envelope.
//
// Internal to the slice: the shape is the web edition's contract, not an export.
// =============================================================================

/**
 * `@ApiResponse` for a payload wrapped in `{ data }`.
 *
 * @param model - the DTO class the `data` property holds.
 * @param options - the status (default 200) and the description.
 * @returns the decorator.
 */
export function apiDataResponse(model: Type<unknown>, options: { status?: number; description?: string } = {}) {
  const { status = 200, description } = options;

  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status,
      description,
      schema: {
        type: 'object',
        required: ['data'],
        properties: { data: { $ref: getSchemaPath(model) } },
      } as ApiResponseSchemaHost['schema'],
    }),
  );
}

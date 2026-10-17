import { type Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath, type ApiResponseSchemaHost } from '@nestjs/swagger';

// =============================================================================
// ApiDataResponse for the graph controllers (issue #496, epic #491)
// =============================================================================
//
// Documents a response that wraps its payload in the `{ data: ... }` envelope the
// host's global interceptor produces, exactly as the web edition's own
// `ApiDataResponse` does for a single model (the only shape these controllers
// use), so the published API document is unchanged by the move. A host without the
// envelope documents nothing extra: the schema simply describes what the route
// returns inside it.
// =============================================================================

/**
 * What `ApiDataResponse` takes besides the model.
 *
 * @stability experimental
 */
export interface ApiDataResponseOptions {
  /** The HTTP status; 200 by default. */
  status?: number;
  /** The response description. */
  description?: string;
}

/**
 * `@ApiResponse` for a payload wrapped in `{ data }`.
 *
 * @param model - the DTO class the `data` property holds.
 * @param options - the status (default 200) and the description.
 * @returns the decorator.
 * @stability experimental
 */
export function ApiDataResponse(model: Type<unknown>, options: ApiDataResponseOptions = {}) {
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

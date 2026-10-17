import { assertStrictJsonSchema } from '../../src/ai-port/strict-json-schema';
import { goodAnswer, makeContext, makeInput, schemaFor } from './extraction-fixtures';
import {
  DIGEST_RESPONSE_SCHEMA,
  buildAdjudicationOutputSchema,
  buildExtractionContext,
  buildExtractionOutputSchema,
  buildItemAdjudicationOutputSchema,
  extractionRowCaps,
} from './package-internals';

// =============================================================================
// The graph's structured-output schemas pass the platform's strict-mode pre-flight (#358, #496)
// =============================================================================
//
// `@marinoscar/kvox-api/graph*` hands the AI port a `jsonSchema` for every structured call (the
// extraction answer, the two adjudication answers, the entity digest). The platform adapter refuses a
// schema that is not strict-mode valid (no `maxItems`, no optional property, `additionalProperties:
// false`), and `assertStrictJsonSchema` is that check. The package cannot run it (it is the host's), so
// these assertions moved here with the slices: they would otherwise be the one thing the move lost.
// =============================================================================

describe('the graph schemas are strict-mode valid', () => {
  it('the extraction answer, with every domain and with the core types only', () => {
    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(makeContext()))).not.toThrow();
    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(makeContext({ effectiveSchema: schemaFor(['core']) })))).not.toThrow();
  });

  it('a capped extraction answer (no maxItems slipping past the pre-flight)', () => {
    const caps = extractionRowCaps(16_000, 'none');

    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(makeContext(), caps))).not.toThrow();
  });

  it('an extraction answer for a note with and without a Context (#440)', () => {
    const withContext = makeInput();
    withContext.note.contextText = 'EY, Consulting';
    const withoutContext = makeInput();
    withoutContext.note.contextText = '   ';

    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(buildExtractionContext(withContext)))).not.toThrow();
    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(buildExtractionContext(withoutContext)))).not.toThrow();
  });

  it('the entity adjudication, the work-item adjudication and the digest answers', () => {
    expect(() => assertStrictJsonSchema(buildAdjudicationOutputSchema())).not.toThrow();
    expect(() => assertStrictJsonSchema(buildItemAdjudicationOutputSchema())).not.toThrow();
    expect(() => assertStrictJsonSchema(DIGEST_RESPONSE_SCHEMA)).not.toThrow();
  });

  it('the fixture answer is still the shape the schema describes (the fixtures did not drift)', () => {
    expect(Object.keys(goodAnswer())).toEqual(expect.arrayContaining(['entities', 'relations', 'items']));
  });
});

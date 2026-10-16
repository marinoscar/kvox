import { computeEffectiveSchema, buildPropsJsonSchema, extractableEntityTypes, extractableRelationTypes } from '@app/shared/ontology';

import { assertStrictJsonSchema } from '../../src/ai-port/strict-json-schema';

// =============================================================================
// Cross-check of the ontology's props JSON Schema against the API's strict-mode
// assertion (#358, `ai-port/strict-json-schema.ts`). The walker that pins the
// strict subset itself moved with the ontology to
// `packages/kvox-contract/test/ontology/json-schema.test.ts` (issue #488); this
// file stays in the API because the assertion is an AI-port concern.
// =============================================================================

describe('buildPropsJsonSchema passes assertStrictJsonSchema (#358)', () => {
  const schema = computeEffectiveSchema({ enabledDomains: ['work'], userAttributes: [] });

  it.each(extractableEntityTypes(schema).map((key) => [key]))('entity type %s', (key: string) => {
    expect(() => assertStrictJsonSchema(buildPropsJsonSchema(schema, key))).not.toThrow();
  });

  it.each(extractableRelationTypes(schema).map((key) => [key]))('relation type %s', (key: string) => {
    expect(() => assertStrictJsonSchema(buildPropsJsonSchema(schema, key, { relation: true }))).not.toThrow();
  });
});

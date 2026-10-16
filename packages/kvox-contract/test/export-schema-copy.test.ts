import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The transcript export JSON schema is published twice: as the contract's
// `./schemas/transcript-export.v1.json` subpath (the source of truth) and as
// `docs/specs/transcript-export.v1.schema.json`, where the spec, the API
// reference and the template-identity guard have always pointed. The docs copy
// stays so no link or consumer breaks; this test is what keeps it honest.
const PACKAGE_COPY = new URL('../schemas/transcript-export.v1.schema.json', import.meta.url);
const DOCS_COPY = new URL('../../../docs/specs/transcript-export.v1.schema.json', import.meta.url);

describe('transcript-export.v1 schema copies', () => {
  it('the docs copy is byte-identical to the package copy', () => {
    expect(readFileSync(DOCS_COPY).equals(readFileSync(PACKAGE_COPY))).toBe(true);
  });

  it('keeps the permanent $id', () => {
    const schema = JSON.parse(readFileSync(PACKAGE_COPY, 'utf8')) as { $id: string };
    expect(schema.$id).toBe('https://kvox.dev/schemas/kvox.transcript/v1');
  });
});

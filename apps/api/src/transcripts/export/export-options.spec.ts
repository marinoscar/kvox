import {
  canonicalJson,
  defaultOptions,
  hashExportRequest,
  optionsSchemaFor,
  type ExportOptionField,
} from './export-options';

// =============================================================================
// Export options and the reuse hash (issue #28, epic #19, spec §8.5)
// =============================================================================

const FIELDS: readonly ExportOptionField[] = [
  {
    key: 'includeTimestamps',
    label: 'Include timestamps',
    description: 'Timestamps beside each turn.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'mergeConsecutive',
    label: 'Merge consecutive turns',
    description: 'One paragraph per run of turns.',
    type: 'boolean',
    default: false,
  },
];

describe('optionsSchemaFor', () => {
  const schema = optionsSchemaFor(FIELDS);

  it('applies every declared default when the request sends nothing', () => {
    expect(schema.parse({})).toEqual({ includeTimestamps: true, mergeConsecutive: false });
  });

  it('keeps a value the request did send', () => {
    expect(schema.parse({ mergeConsecutive: true })).toEqual({
      includeTimestamps: true,
      mergeConsecutive: true,
    });
  });

  it('refuses an unknown key rather than stripping it', () => {
    // A stripped key is the worst outcome: `includeTimestamp` (singular) would
    // render without timestamps, report success, and hash identically to the
    // default request — so the typo'd caller would also be handed somebody
    // else's already-rendered file.
    const result = schema.safeParse({ includeTimestamp: true });

    expect(result.success).toBe(false);
  });

  it('refuses a non-boolean for a boolean field', () => {
    expect(schema.safeParse({ mergeConsecutive: 'yes' }).success).toBe(false);
  });

  it('has no options at all for an exporter that declares none', () => {
    expect(optionsSchemaFor([]).parse({})).toEqual({});
  });
});

describe('defaultOptions', () => {
  it('is the same object the schema produces for an empty request', () => {
    expect(defaultOptions(FIELDS)).toEqual(optionsSchemaFor(FIELDS).parse({}));
  });
});

describe('canonicalJson', () => {
  it('sorts object keys, so insertion order cannot change the hash', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('renders null and primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(3)).toBe('3');
  });
});

describe('hashExportRequest', () => {
  const base = { format: 'markdown', version: 3, options: { includeTimestamps: true } };

  it('is stable for the same request', () => {
    expect(hashExportRequest(base)).toBe(hashExportRequest({ ...base }));
  });

  it('is a 64-character sha256 hex digest', () => {
    expect(hashExportRequest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the format', () => {
    expect(hashExportRequest({ ...base, format: 'json' })).not.toBe(hashExportRequest(base));
  });

  it('changes with the version', () => {
    expect(hashExportRequest({ ...base, version: 4 })).not.toBe(hashExportRequest(base));
  });

  it('changes with an option', () => {
    expect(hashExportRequest({ ...base, options: { includeTimestamps: false } })).not.toBe(
      hashExportRequest(base),
    );
  });

  it('makes an omitted option and an explicit default the SAME export', () => {
    // The hash is over the PARSED options, so `{}` and `{includeTimestamps:
    // true, mergeConsecutive: false}` describe one file and reuse one render.
    const schema = optionsSchemaFor(FIELDS);

    expect(
      hashExportRequest({ format: 'markdown', version: 1, options: schema.parse({}) }),
    ).toBe(
      hashExportRequest({
        format: 'markdown',
        version: 1,
        options: schema.parse({ includeTimestamps: true, mergeConsecutive: false }),
      }),
    );
  });
});

import {
  canonicalJson,
  defaultOptions,
  hashExportRequest,
  optionsSchemaFor,
  type ExportOptionField,
  type ExportOptions,
} from '@marinoscar/platform-api/exports';

// =============================================================================
// The reuse hash is frozen (epic #478, issue #479)
// =============================================================================
//
// `transcript_exports` and `note_exports` are content-addressed on
// `(id, version, format, options_hash)`. If `hashExportRequest` ever returns a
// different hex string for the same request, nothing fails: every repeat request
// just renders again, because the stored rows no longer match. This spec is the
// alarm for that.
//
// The expected strings below were computed from this app's own implementation
// (`apps/api/src/export/export-options.ts`, since deleted) BEFORE the swap to
// `@marinoscar/platform-api/exports`, and the package was checked to return the
// identical value for every row. They are the stored truth.
//
// Never "fix" a failure here by editing the table. A change means every stored
// export would stop being reused; it needs a migration plan, not a new fixture.
// =============================================================================

type HashInput = Parameters<typeof hashExportRequest>[0];

// [document kind, request, sha256 hex]. The kind is documentation only: both
// document types share one hash function.
const FROZEN: ReadonlyArray<readonly [string, HashInput, string]> = [
  [
    'transcript',
    {
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: true, mergeConsecutive: false },
    },
    '0f9d9f2c8b74bc5523fdf2cce20bff5c13c36716c6d759dadb8292e2ed3b4def',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: true, mergeConsecutive: false },
      contentFingerprint: null,
    },
    '0f9d9f2c8b74bc5523fdf2cce20bff5c13c36716c6d759dadb8292e2ed3b4def',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: true, mergeConsecutive: false },
      contentFingerprint: 'speakers:abc123',
    },
    'd1aff0db3af6b4880965ed72efaefceaa63dbc53b564ee2c2189e6011bbff787',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 12,
      options: { includeTimestamps: true, mergeConsecutive: false },
    },
    '3cff9706a9aa6656da6b7f357245f9c7518a8d7ad2da81d5c88441f8deb3381e',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 12,
      options: { includeTimestamps: true, mergeConsecutive: false },
      contentFingerprint: null,
    },
    '3cff9706a9aa6656da6b7f357245f9c7518a8d7ad2da81d5c88441f8deb3381e',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 12,
      options: { includeTimestamps: true, mergeConsecutive: false },
      contentFingerprint: 'speakers:abc123',
    },
    '6705d00d640aef4627a4b3db35c51b3c5a8335367c7378ea9e722059468c77a0',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: false, mergeConsecutive: true },
    },
    '391049e857b15f2423b04ee52311bd701c5e7f401bc5c045fdba031b31b54322',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: false, mergeConsecutive: true },
      contentFingerprint: null,
    },
    '391049e857b15f2423b04ee52311bd701c5e7f401bc5c045fdba031b31b54322',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: false, mergeConsecutive: true },
      contentFingerprint: 'speakers:abc123',
    },
    'd00f36797245412d3e27ab6a9a72f1541f5676c3bcc532b000b611c89a67bb1a',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 12,
      options: { includeTimestamps: false, mergeConsecutive: true },
    },
    'e8dbaeb241b0c90b98fd3a4c57c18aab8978a4535d234f4891603c2106b5fc85',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 12,
      options: { includeTimestamps: false, mergeConsecutive: true },
      contentFingerprint: null,
    },
    'e8dbaeb241b0c90b98fd3a4c57c18aab8978a4535d234f4891603c2106b5fc85',
  ],
  [
    'transcript',
    {
      format: 'markdown',
      version: 12,
      options: { includeTimestamps: false, mergeConsecutive: true },
      contentFingerprint: 'speakers:abc123',
    },
    '5afd3f18c47c6b9173bc2a7a6a794b5d10b419a4811ddefb8cfdebb29bb4ff8e',
  ],
  [
    'transcript',
    { format: 'json', version: 1, options: { includeWords: false } },
    'f2e91a08ce6839f92a359e5f5d947300f222ff34fc085d48c50f775766766a54',
  ],
  [
    'transcript',
    { format: 'json', version: 1, options: { includeWords: false }, contentFingerprint: null },
    'f2e91a08ce6839f92a359e5f5d947300f222ff34fc085d48c50f775766766a54',
  ],
  [
    'transcript',
    {
      format: 'json',
      version: 1,
      options: { includeWords: false },
      contentFingerprint: 'speakers:abc123',
    },
    '7336affbb449baf59224412c3adb0cdc206bf57707efffdec5a3e51c93e0d07c',
  ],
  [
    'transcript',
    { format: 'json', version: 12, options: { includeWords: false } },
    '67fb85ee34d749b6cd47c5792cb47a5a03a8a9a042c5e4bc4449960c1b211922',
  ],
  [
    'transcript',
    { format: 'json', version: 12, options: { includeWords: false }, contentFingerprint: null },
    '67fb85ee34d749b6cd47c5792cb47a5a03a8a9a042c5e4bc4449960c1b211922',
  ],
  [
    'transcript',
    {
      format: 'json',
      version: 12,
      options: { includeWords: false },
      contentFingerprint: 'speakers:abc123',
    },
    '6fd102b7372521061a4b8c14409e1f6c0216167f0633c83718cb8fcfc10d65ea',
  ],
  [
    'transcript',
    { format: 'json', version: 1, options: { includeWords: true } },
    'f80ae08dbe46c9f6246512e91d373f55c31f733fd7fad79a35750f9c54dfead6',
  ],
  [
    'transcript',
    { format: 'json', version: 1, options: { includeWords: true }, contentFingerprint: null },
    'f80ae08dbe46c9f6246512e91d373f55c31f733fd7fad79a35750f9c54dfead6',
  ],
  [
    'transcript',
    {
      format: 'json',
      version: 1,
      options: { includeWords: true },
      contentFingerprint: 'speakers:abc123',
    },
    'ba62626794ecf41d5d8d2d499f50a7ba3a5ff81675284f5e94db67eabd9620ef',
  ],
  [
    'transcript',
    { format: 'json', version: 12, options: { includeWords: true } },
    '28b1ee3afca69db49e25c6e11122bef278fc87d6daf3699d0aa0ed4376bbc608',
  ],
  [
    'transcript',
    { format: 'json', version: 12, options: { includeWords: true }, contentFingerprint: null },
    '28b1ee3afca69db49e25c6e11122bef278fc87d6daf3699d0aa0ed4376bbc608',
  ],
  [
    'transcript',
    {
      format: 'json',
      version: 12,
      options: { includeWords: true },
      contentFingerprint: 'speakers:abc123',
    },
    '5bbf2e8c3ccb9e3cdc19f536c8945d0a7f80c6428db11f7ff73ca82c50474ea4',
  ],
  [
    'transcript',
    { format: 'pdf', version: 1, options: { includeCover: true, includeTimestamps: true } },
    '8491f847df3854f0dc6d433854a6e5c834972ee3c569debbade2dbae1df5e75e',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 1,
      options: { includeCover: true, includeTimestamps: true },
      contentFingerprint: null,
    },
    '8491f847df3854f0dc6d433854a6e5c834972ee3c569debbade2dbae1df5e75e',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 1,
      options: { includeCover: true, includeTimestamps: true },
      contentFingerprint: 'speakers:abc123',
    },
    'fc130e6294456de146172164322dbac8236a2faab00e76fabe97c3e70901f765',
  ],
  [
    'transcript',
    { format: 'pdf', version: 12, options: { includeCover: true, includeTimestamps: true } },
    '779d7813eacb437337b6b2b8169ac607680d238f0211006ed777598d975a2701',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 12,
      options: { includeCover: true, includeTimestamps: true },
      contentFingerprint: null,
    },
    '779d7813eacb437337b6b2b8169ac607680d238f0211006ed777598d975a2701',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 12,
      options: { includeCover: true, includeTimestamps: true },
      contentFingerprint: 'speakers:abc123',
    },
    '348b2e70795c0f455f268b2eb80d72560d5c8e3db7e87f9853765b0e38e4cdcb',
  ],
  [
    'transcript',
    { format: 'pdf', version: 1, options: { includeCover: false, includeTimestamps: false } },
    '3219550efe7ca2bdd2f7cd5599f018283386e9384d3c2857a40515786a337e36',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 1,
      options: { includeCover: false, includeTimestamps: false },
      contentFingerprint: null,
    },
    '3219550efe7ca2bdd2f7cd5599f018283386e9384d3c2857a40515786a337e36',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 1,
      options: { includeCover: false, includeTimestamps: false },
      contentFingerprint: 'speakers:abc123',
    },
    '6e247bb2da418cbd9c0634840673061e33f97e3aa5115e2f52e585fa2838948f',
  ],
  [
    'transcript',
    { format: 'pdf', version: 12, options: { includeCover: false, includeTimestamps: false } },
    'dcd3a2848e41916cf9409d4fe08448152fb53062fe3049810346f77b6aae8287',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 12,
      options: { includeCover: false, includeTimestamps: false },
      contentFingerprint: null,
    },
    'dcd3a2848e41916cf9409d4fe08448152fb53062fe3049810346f77b6aae8287',
  ],
  [
    'transcript',
    {
      format: 'pdf',
      version: 12,
      options: { includeCover: false, includeTimestamps: false },
      contentFingerprint: 'speakers:abc123',
    },
    'cfcd58878481ad0bffa700523e2722958c78dbb5f0d197d6ea63ad885dbd89a8',
  ],
  [
    'note',
    { format: 'markdown', version: 1, options: { includeFrontMatter: true } },
    'f346cb51b627d19ae65e2a94ba835ab8efa1b49a2e18ac7d52f6ff61b289c460',
  ],
  [
    'note',
    { format: 'markdown', version: 12, options: { includeFrontMatter: true } },
    '0f1bb45a206adbf8a160b008eb88750b8bb5544421c5a6d9a1b7080bb924cd10',
  ],
  [
    'note',
    { format: 'markdown', version: 1, options: { includeFrontMatter: false } },
    'b36bd05d637473f372cba1e39143d46609f3ffb288e798972aea79bf7e68d5be',
  ],
  [
    'note',
    { format: 'markdown', version: 12, options: { includeFrontMatter: false } },
    '0f364b7e7adeb10f09d2dbc9b6db32767a9de66640a82824f7c71a8ed66f2dde',
  ],
  [
    'note',
    { format: 'pdf', version: 1, options: { includePageNumbers: true } },
    'a3c27ff8fae01fcc7766b3c8924c2e5e0c55ef8a7b787f23b9fc3a002fa47a60',
  ],
  [
    'note',
    { format: 'pdf', version: 12, options: { includePageNumbers: true } },
    'c00f407e0ab423ac29bac341a14d63edd22bcb19a72c6d7897731a06ce72fad9',
  ],
  [
    'note',
    { format: 'pdf', version: 1, options: { includePageNumbers: false } },
    'f7aa6f1a312299359bb64ad39c1a464109af45b662df2236646eef5220645cab',
  ],
  [
    'note',
    { format: 'pdf', version: 12, options: { includePageNumbers: false } },
    '2f7d4b3dff6faf5e790fcd034f9cbccce2a6f71d3e9eba6de49fbf195306a38d',
  ],
  [
    'note',
    { format: 'docx', version: 1, options: { includePageNumbers: true } },
    'c88e86d38b40362a7534f993dbe59068f2adc4300d6866d94b6b20b446e113ef',
  ],
  [
    'note',
    { format: 'docx', version: 12, options: { includePageNumbers: true } },
    '75edd7a108539cc4bfe43d5c1a406945896f5b887513d6135aa8fd13004c7824',
  ],
  [
    'note',
    { format: 'docx', version: 1, options: { includePageNumbers: false } },
    '4c483af99db4526c800271b8d153fd004c8bad6a510dd7b6e1a3dca6d6652143',
  ],
  [
    'note',
    { format: 'docx', version: 12, options: { includePageNumbers: false } },
    'f2eba480fe3c2ba357b7cfd771605879eac6d65c03d71c6e61e0cca9b60759d2',
  ],
];

describe('hashExportRequest (frozen against the stored options_hash values)', () => {
  it.each(FROZEN)('%s %j', (_kind, input, expected) => {
    expect(hashExportRequest(input)).toBe(expected);
  });

  it('is independent of option key order', () => {
    const a = hashExportRequest({
      format: 'markdown',
      version: 1,
      options: { includeTimestamps: true, mergeConsecutive: false },
    });
    const b = hashExportRequest({
      format: 'markdown',
      version: 1,
      options: { mergeConsecutive: false, includeTimestamps: true },
    });

    expect(a).toBe(b);
  });

  it('treats an absent, null and empty contentFingerprint as the same request', () => {
    const base = { format: 'json', version: 3, options: { includeWords: false } };

    expect(hashExportRequest({ ...base, contentFingerprint: null })).toBe(hashExportRequest(base));
    expect(hashExportRequest({ ...base, contentFingerprint: '' })).toBe(hashExportRequest(base));
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: [2, { z: 1, y: undefined }] } })).toBe(
      '{"a":{"c":[2,{"z":1}],"d":true},"b":1}'
    );
  });
});

// The default and strictness behaviour the export dialog and the API rely on,
// for the field lists the exporters in this app declare.
const SCHEMA_CASES: ReadonlyArray<readonly [string, readonly ExportOptionField[], ExportOptions]> =
  [
    [
      'transcript markdown',
      [field('includeTimestamps', true), field('mergeConsecutive', false)],
      { includeTimestamps: true, mergeConsecutive: false },
    ],
    ['transcript json', [field('includeWords', false)], { includeWords: false }],
    [
      'transcript pdf',
      [field('includeCover', true), field('includeTimestamps', true)],
      { includeCover: true, includeTimestamps: true },
    ],
    ['note markdown', [field('includeFrontMatter', true)], { includeFrontMatter: true }],
    ['note pdf and docx', [field('includePageNumbers', true)], { includePageNumbers: true }],
  ];

function field(key: string, def: boolean): ExportOptionField {
  return { key, label: key, description: key, type: 'boolean', default: def };
}

describe('optionsSchemaFor', () => {
  it.each(SCHEMA_CASES)('%s: an empty body parses to the declared defaults', (_n, fields, want) => {
    expect(optionsSchemaFor(fields).parse({})).toEqual(want);
    expect(defaultOptions(fields)).toEqual(want);
  });

  it('refuses an unknown key rather than stripping it', () => {
    expect(
      optionsSchemaFor([field('includeWords', false)]).safeParse({ includeWord: true }).success
    ).toBe(false);
  });
});

import {
  MAX_PARTS,
  MIN_PART_SIZE,
  computePartSize,
  computeTotalParts,
  formatBytes,
  isMimeTypeAllowed,
  normaliseMimeType,
  resolveMimeType,
} from './upload-constraints';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('computePartSize', () => {
  it('uses the configured size when it already fits inside the part limit', () => {
    expect(computePartSize(5 * GIB, 10 * MIB)).toBe(10 * MIB);
  });

  it('never returns a size below the S3 minimum', () => {
    expect(computePartSize(1024, MIN_PART_SIZE)).toBe(MIN_PART_SIZE);
  });

  it('always returns a whole number of MiB', () => {
    for (const size of [1, 100 * MIB, 3 * GIB, 137 * GIB, 1024 * GIB]) {
      expect(computePartSize(size, 10 * MIB) % MIB).toBe(0);
    }
  });

  // THE PROPERTY THE WHOLE ISSUE TURNS ON: no size a caller can send produces
  // more than 10,000 parts, so the "file too large for multipart upload"
  // rejection is unreachable rather than merely avoided.
  it.each([
    [1],
    [100 * MIB],
    [5 * GIB],
    [97 * GIB],
    [500 * GIB],
    [1024 * GIB],
    [10 * 1024 * GIB],
  ])('keeps a %p-byte file inside the 10,000-part limit', (size) => {
    const partSize = computePartSize(size, 10 * MIB);

    expect(computeTotalParts(size, partSize)).toBeLessThanOrEqual(MAX_PARTS);
    // And every byte is still covered.
    expect(partSize * computeTotalParts(size, partSize)).toBeGreaterThanOrEqual(size);
  });

  it('rounds UP, never down — rounding down would put the part count back over the limit', () => {
    // 10,000 parts of exactly 10 MiB + 1 byte: the required size is 10 MiB + a
    // fraction, which must become 11 MiB, not 10.
    const size = MAX_PARTS * 10 * MIB + 1;

    expect(computePartSize(size, 5 * MIB)).toBe(11 * MIB);
  });
});

describe('computeTotalParts', () => {
  it('reports at least one part even for an empty file', () => {
    expect(computeTotalParts(0, 10 * MIB)).toBe(1);
  });

  it('does not add a part for an exact multiple', () => {
    expect(computeTotalParts(50 * MIB, 10 * MIB)).toBe(5);
  });

  it('adds one part for the remainder', () => {
    expect(computeTotalParts(50 * MIB + 1, 10 * MIB)).toBe(6);
  });
});

describe('isMimeTypeAllowed', () => {
  const allowed = ['image/*', 'application/pdf', 'video/*', 'audio/*'];

  it.each([
    ['audio/mpeg', true],
    ['audio/mp4', true],
    ['image/png', true],
    ['application/pdf', true],
    ['application/zip', false],
    ['text/plain', false],
    ['application/octet-stream', false],
  ])('reads %s as %p', (mimeType, expected) => {
    expect(isMimeTypeAllowed(mimeType, allowed)).toBe(expected);
  });

  it('ignores case and any charset parameter', () => {
    expect(isMimeTypeAllowed('AUDIO/OGG; charset=utf-8', allowed)).toBe(true);
  });

  it('honours a bare wildcard', () => {
    expect(isMimeTypeAllowed('application/x-anything', ['*'])).toBe(true);
  });

  it('ignores surrounding whitespace in a pattern, which a split .env value has', () => {
    expect(isMimeTypeAllowed('audio/wav', [' audio/* ', 'image/*'])).toBe(true);
  });

  it('does not treat an empty pattern as a wildcard', () => {
    expect(isMimeTypeAllowed('audio/wav', ['', '  '])).toBe(false);
  });
});

describe('resolveMimeType', () => {
  it('leaves a specific declared type alone', () => {
    expect(resolveMimeType('clip.mp4', 'video/mp4')).toBe('video/mp4');
  });

  it.each([
    ['memo.m4a', 'audio/mp4'],
    ['memo.M4A', 'audio/mp4'],
    ['memo.amr', 'audio/amr'],
    ['memo.mp3', 'audio/mpeg'],
    ['memo.wav', 'audio/wav'],
    ['memo.flac', 'audio/flac'],
    ['memo.ogg', 'audio/ogg'],
    ['memo.opus', 'audio/opus'],
    ['memo.aac', 'audio/aac'],
    ['memo.webm', 'audio/webm'],
    ['memo.wma', 'audio/x-ms-wma'],
    ['memo.3gp', 'audio/3gpp'],
    ['memo.aiff', 'audio/aiff'],
    ['memo.aif', 'audio/aiff'],
    ['memo.caf', 'audio/x-caf'],
    ['memo.wv', 'audio/x-wavpack'],
    ['memo.m4b', 'audio/mp4'],
    ['memo.mp4', 'audio/mp4'],
  ])('rescues a generic type for %s as %s', (name, expected) => {
    expect(resolveMimeType(name, 'application/octet-stream')).toBe(expected);
    expect(resolveMimeType(name, '')).toBe(expected);
    expect(resolveMimeType(name, undefined)).toBe(expected);
  });

  it('returns null when there is nothing at all to go on', () => {
    expect(resolveMimeType('mystery', '')).toBeNull();
    expect(resolveMimeType('mystery.bin', undefined)).toBeNull();
  });

  it('hands a generic type back unchanged when no extension rescues it', () => {
    expect(resolveMimeType('mystery.bin', 'application/octet-stream')).toBe(
      'application/octet-stream',
    );
  });
});

describe('normaliseMimeType', () => {
  it('lowercases and strips parameters', () => {
    expect(normaliseMimeType('Audio/MP4; codecs="mp4a.40.2"')).toBe('audio/mp4');
  });

  it('turns null and undefined into the empty string', () => {
    expect(normaliseMimeType(null)).toBe('');
    expect(normaliseMimeType(undefined)).toBe('');
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [104857600, '100.0 MB'],
    [10737418240, '10.0 GB'],
    [5242880, '5.00 MB'],
  ])('renders %p as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

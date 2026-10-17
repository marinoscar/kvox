import {
  EXTRACTION_METADATA_KEY,
  readDocumentExtractionStatus,
} from '../../src/notes/source-metadata.js';

// readDocumentExtractionStatus is TOTAL: anything it cannot read is "extracting" (issue #596).
const EXTRACTING = { status: 'extracting', message: null, characters: null };

const withBlock = (block: unknown) => ({ [EXTRACTION_METADATA_KEY]: block });

describe('readDocumentExtractionStatus', () => {
  it('reports extracted with its message and character count', () => {
    const result = readDocumentExtractionStatus(
      withBlock({ status: 'extracted', message: 'Read 3 pages.', characters: 1234 }),
    );

    expect(result).toEqual({ status: 'extracted', message: 'Read 3 pages.', characters: 1234 });
  });

  it('reports unextractable with the recorded sentence', () => {
    const result = readDocumentExtractionStatus(
      withBlock({ status: 'unextractable', message: 'This PDF has no readable text.' }),
    );

    expect(result).toEqual({
      status: 'unextractable',
      message: 'This PDF has no readable text.',
      characters: null,
    });
  });

  it('accepts zero characters', () => {
    expect(readDocumentExtractionStatus(withBlock({ status: 'extracted', characters: 0 })).characters).toBe(0);
  });

  it('is extracting when the block is missing', () => {
    expect(readDocumentExtractionStatus({})).toEqual(EXTRACTING);
    expect(readDocumentExtractionStatus({ uploadedFilename: 'a.pdf' })).toEqual(EXTRACTING);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [1, 2]],
    ['a string', 'extracted'],
    ['a number', 7],
  ])('is extracting for %s metadata', (_label, metadata) => {
    expect(readDocumentExtractionStatus(metadata)).toEqual(EXTRACTING);
  });

  it.each([
    ['an array', ['extracted']],
    ['a string', 'extracted'],
    ['null', null],
  ])('is extracting when the block is %s', (_label, block) => {
    expect(readDocumentExtractionStatus(withBlock(block))).toEqual(EXTRACTING);
  });

  it.each(['pending', 'failed', 'EXTRACTED', '', 5, null])(
    'is extracting for an unknown status %p, dropping message and count',
    (status) => {
      const result = readDocumentExtractionStatus(withBlock({ status, message: 'x', characters: 9 }));

      expect(result).toEqual(EXTRACTING);
    },
  );

  it.each([42, null, {}, ['a']])('nulls a non-string message (%p)', (message) => {
    expect(readDocumentExtractionStatus(withBlock({ status: 'extracted', message })).message).toBeNull();
  });

  it.each(['12', null, NaN, Infinity, -Infinity, {}])('nulls a non-finite or non-number characters (%p)', (characters) => {
    expect(readDocumentExtractionStatus(withBlock({ status: 'extracted', characters })).characters).toBeNull();
  });
});

import { completeUploadSchema } from './complete-upload.dto';

describe('completeUploadSchema', () => {
  // ⚠ THE REGRESSION THIS SCHEMA EXISTS TO FIX (#89). A browser's
  // `POST …/upload/complete` carries no payload and no Content-Type, so
  // Fastify hands the handler `body === undefined`. Before the `preprocess`
  // wrapper this schema rejected `undefined` outright with a 400
  // `Validation failed`, which every browser upload hit at 100% — all of its
  // parts already sitting in the bucket. Normalising `undefined` (and
  // `null`) to `{}` is the fix; these two cases are the regression tests.
  describe('a missing body', () => {
    it('accepts undefined, normalising it to {}', () => {
      const result = completeUploadSchema.safeParse(undefined);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });

    it('accepts null, normalising it to {}', () => {
      const result = completeUploadSchema.safeParse(null);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });

  describe('an explicit empty object', () => {
    it('accepts {}', () => {
      const result = completeUploadSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({});
      }
    });
  });

  describe('a supplied parts array', () => {
    it('accepts a well-formed parts array', () => {
      const result = completeUploadSchema.safeParse({
        parts: [
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.parts).toEqual([
          { partNumber: 1, eTag: 'etag1' },
          { partNumber: 2, eTag: 'etag2' },
        ]);
      }
    });

    it('rejects an empty parts array', () => {
      const result = completeUploadSchema.safeParse({ parts: [] });

      expect(result.success).toBe(false);
    });

    it('rejects a part with a non-positive partNumber', () => {
      const result = completeUploadSchema.safeParse({
        parts: [{ partNumber: 0, eTag: 'etag1' }],
      });

      expect(result.success).toBe(false);
    });

    it('rejects a part with an empty eTag', () => {
      const result = completeUploadSchema.safeParse({
        parts: [{ partNumber: 1, eTag: '' }],
      });

      expect(result.success).toBe(false);
    });

    it('rejects parts that is not an array', () => {
      const result = completeUploadSchema.safeParse({ parts: 'invalid' });

      expect(result.success).toBe(false);
    });
  });

  describe('a malformed body', () => {
    it('rejects a bare string', () => {
      const result = completeUploadSchema.safeParse('x');

      expect(result.success).toBe(false);
    });

    it('rejects a top-level array', () => {
      const result = completeUploadSchema.safeParse([]);

      expect(result.success).toBe(false);
    });

    it('rejects a number', () => {
      const result = completeUploadSchema.safeParse(42);

      expect(result.success).toBe(false);
    });
  });
});

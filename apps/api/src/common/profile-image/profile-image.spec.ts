import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  AVATAR_PURPOSE,
  avatarKeyPrefix,
  avatarUrl,
  detectImageType,
  isAvatarObjectFor,
  isUuid,
  normalizeProfileSettings,
  resolveProfileImageUrl,
  type AvatarCandidate,
} from './profile-image';

describe('profile-image helpers (#367)', () => {
  // ===========================================================================
  // detectImageType — magic-byte sniffing
  // ===========================================================================
  describe('detectImageType', () => {
    it('detects a JPEG by its FF D8 FF header', () => {
      const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(detectImageType(buffer)).toEqual({
        mimeType: 'image/jpeg',
        extension: 'jpg',
      });
    });

    it('detects a PNG by its 8-byte signature', () => {
      const buffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
      ]);
      expect(detectImageType(buffer)).toEqual({
        mimeType: 'image/png',
        extension: 'png',
      });
    });

    it('detects a GIF87a', () => {
      const buffer = Buffer.from('GIF87a' + '\x00\x00', 'binary');
      expect(detectImageType(buffer)).toEqual({
        mimeType: 'image/gif',
        extension: 'gif',
      });
    });

    it('detects a GIF89a', () => {
      const buffer = Buffer.from('GIF89a' + '\x00\x00', 'binary');
      expect(detectImageType(buffer)).toEqual({
        mimeType: 'image/gif',
        extension: 'gif',
      });
    });

    it('detects a WebP by RIFF....WEBP', () => {
      const buffer = Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([0x24, 0x00, 0x00, 0x00]), // arbitrary chunk size
        Buffer.from('WEBP', 'ascii'),
      ]);
      expect(detectImageType(buffer)).toEqual({
        mimeType: 'image/webp',
        extension: 'webp',
      });
    });

    it('rejects an SVG (text, can carry script) even though it is an image format', () => {
      const buffer = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        'utf8',
      );
      expect(detectImageType(buffer)).toBeNull();
    });

    it('rejects an HTML document', () => {
      const buffer = Buffer.from('<!DOCTYPE html><html></html>', 'utf8');
      expect(detectImageType(buffer)).toBeNull();
    });

    it('rejects a truncated/partial JPEG header', () => {
      const buffer = Buffer.from([0xff, 0xd8]); // missing the third 0xff byte
      expect(detectImageType(buffer)).toBeNull();
    });

    it('rejects a truncated PNG signature', () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e]); // first 3 bytes only
      expect(detectImageType(buffer)).toBeNull();
    });

    it('rejects an empty buffer', () => {
      expect(detectImageType(Buffer.alloc(0))).toBeNull();
    });

    it('rejects RIFF audio (WAVE) — RIFF alone is not enough, WEBP marker must follow', () => {
      const buffer = Buffer.concat([
        Buffer.from('RIFF', 'ascii'),
        Buffer.from([0x24, 0x00, 0x00, 0x00]),
        Buffer.from('WAVE', 'ascii'),
      ]);
      expect(detectImageType(buffer)).toBeNull();
    });

    it('every detected mimeType is one of the AVATAR_MIME_TYPES', () => {
      const jpeg = detectImageType(Buffer.from([0xff, 0xd8, 0xff]));
      expect(AVATAR_MIME_TYPES).toContain(jpeg?.mimeType);
    });
  });

  // ===========================================================================
  // isUuid
  // ===========================================================================
  describe('isUuid', () => {
    it('accepts a well-formed v4-shaped uuid', () => {
      expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    });

    it('accepts uppercase hex digits', () => {
      expect(isUuid('11111111-1111-4111-8111-11111111111A')).toBe(true);
    });

    it('rejects a non-uuid string', () => {
      expect(isUuid('not-a-uuid')).toBe(false);
    });

    it('rejects null/undefined/non-string values', () => {
      expect(isUuid(null)).toBe(false);
      expect(isUuid(undefined)).toBe(false);
      expect(isUuid(12345)).toBe(false);
    });
  });

  // ===========================================================================
  // avatarKeyPrefix / avatarUrl
  // ===========================================================================
  describe('avatarKeyPrefix / avatarUrl', () => {
    it('builds the storage key prefix as avatars/<userId>/', () => {
      expect(avatarKeyPrefix('user-1')).toBe('avatars/user-1/');
    });

    it('builds the public avatar URL', () => {
      expect(avatarUrl('user-1', 'obj-1')).toBe(
        '/api/users/user-1/avatar/obj-1',
      );
    });
  });

  // ===========================================================================
  // normalizeProfileSettings — legacy normalization
  // ===========================================================================
  describe('normalizeProfileSettings', () => {
    it('defaults an absent/undefined profile to imageSource "provider" with a null imageObjectId', () => {
      expect(normalizeProfileSettings(undefined)).toEqual({
        imageSource: 'provider',
        imageObjectId: null,
      });
    });

    it('defaults a non-object raw value the same way', () => {
      expect(normalizeProfileSettings('garbage')).toEqual({
        imageSource: 'provider',
        imageObjectId: null,
      });
    });

    it('passes through a well-formed current-shape profile', () => {
      expect(
        normalizeProfileSettings({
          imageSource: 'upload',
          imageObjectId: '11111111-1111-4111-8111-111111111111',
        }),
      ).toEqual({
        imageSource: 'upload',
        imageObjectId: '11111111-1111-4111-8111-111111111111',
      });
    });

    it('translates legacy useProviderImage === false to imageSource "none"', () => {
      expect(
        normalizeProfileSettings({
          useProviderImage: false,
          customImageUrl: 'https://example.com/old.jpg',
        }),
      ).toEqual({
        imageSource: 'none',
        imageObjectId: null,
      });
    });

    it('translates legacy useProviderImage === true to imageSource "provider"', () => {
      expect(
        normalizeProfileSettings({ useProviderImage: true }),
      ).toEqual({
        imageSource: 'provider',
        imageObjectId: null,
      });
    });

    it('drops the legacy customImageUrl key entirely — it is never surfaced', () => {
      const result = normalizeProfileSettings({
        useProviderImage: false,
        customImageUrl: 'https://example.com/old.jpg',
      }) as Record<string, unknown>;
      expect(result.customImageUrl).toBeUndefined();
    });

    it('discards a non-uuid imageObjectId rather than throwing', () => {
      expect(
        normalizeProfileSettings({
          imageSource: 'upload',
          imageObjectId: 'not-a-uuid',
        }),
      ).toEqual({
        imageSource: 'upload',
        imageObjectId: null,
      });
    });

    it('discards an imageSource value outside the enum, falling back via the legacy rule', () => {
      expect(
        normalizeProfileSettings({ imageSource: 'gravatar' }),
      ).toEqual({
        imageSource: 'provider',
        imageObjectId: null,
      });
    });

    it('preserves displayName when it is a string', () => {
      expect(
        normalizeProfileSettings({
          displayName: 'Jane',
          imageSource: 'none',
        }),
      ).toEqual({
        displayName: 'Jane',
        imageSource: 'none',
        imageObjectId: null,
      });
    });

    it('omits displayName when absent rather than setting it to undefined explicitly', () => {
      const result = normalizeProfileSettings({ imageSource: 'none' });
      expect('displayName' in result).toBe(false);
    });
  });

  // ===========================================================================
  // resolveProfileImageUrl
  // ===========================================================================
  describe('resolveProfileImageUrl', () => {
    const user = {
      id: 'user-1',
      providerProfileImageUrl: 'https://provider.example.com/pic.jpg',
    };

    it('returns null for imageSource "none"', () => {
      expect(
        resolveProfileImageUrl(user, { imageSource: 'none' }),
      ).toBeNull();
    });

    it('returns the provider picture for imageSource "provider"', () => {
      expect(
        resolveProfileImageUrl(user, { imageSource: 'provider' }),
      ).toBe('https://provider.example.com/pic.jpg');
    });

    it('returns null for imageSource "provider" when the user has no provider picture', () => {
      expect(
        resolveProfileImageUrl(
          { id: 'user-1', providerProfileImageUrl: null },
          { imageSource: 'provider' },
        ),
      ).toBeNull();
    });

    it('returns the same-origin avatar URL for imageSource "upload" with an object id', () => {
      expect(
        resolveProfileImageUrl(user, {
          imageSource: 'upload',
          imageObjectId: '11111111-1111-4111-8111-111111111111',
        }),
      ).toBe('/api/users/user-1/avatar/11111111-1111-4111-8111-111111111111');
    });

    it('returns null for imageSource "upload" with no object id', () => {
      expect(
        resolveProfileImageUrl(user, {
          imageSource: 'upload',
          imageObjectId: null,
        }),
      ).toBeNull();
    });

    it('normalizes a legacy raw profile before resolving', () => {
      expect(
        resolveProfileImageUrl(user, { useProviderImage: false }),
      ).toBeNull();
    });
  });

  // ===========================================================================
  // isAvatarObjectFor
  // ===========================================================================
  describe('isAvatarObjectFor', () => {
    const userId = 'user-1';

    function validObject(overrides: Partial<AvatarCandidate> = {}): AvatarCandidate {
      return {
        uploadedById: userId,
        storageKey: `avatars/${userId}/obj-1.png`,
        status: 'ready',
        mimeType: 'image/png',
        metadata: { purpose: AVATAR_PURPOSE },
        ...overrides,
      };
    }

    it('returns true for a fully valid avatar object', () => {
      expect(isAvatarObjectFor(validObject(), userId)).toBe(true);
    });

    it('returns false for null/undefined', () => {
      expect(isAvatarObjectFor(null, userId)).toBe(false);
      expect(isAvatarObjectFor(undefined, userId)).toBe(false);
    });

    it('returns false when uploadedById does not match', () => {
      expect(
        isAvatarObjectFor(validObject({ uploadedById: 'someone-else' }), userId),
      ).toBe(false);
    });

    it('returns false when the storage key is outside the avatar prefix', () => {
      expect(
        isAvatarObjectFor(
          validObject({ storageKey: `uploads/${userId}/obj-1.png` }),
          userId,
        ),
      ).toBe(false);
    });

    it('returns false when metadata.purpose is not "avatar"', () => {
      expect(
        isAvatarObjectFor(validObject({ metadata: { purpose: 'other' } }), userId),
      ).toBe(false);
    });

    it('returns false when metadata is missing entirely', () => {
      expect(isAvatarObjectFor(validObject({ metadata: null }), userId)).toBe(
        false,
      );
    });

    it('returns false when status is not "ready"', () => {
      expect(
        isAvatarObjectFor(validObject({ status: 'processing' }), userId),
      ).toBe(false);
    });

    it('returns false when mimeType is not an allowed avatar type', () => {
      expect(
        isAvatarObjectFor(validObject({ mimeType: 'application/pdf' }), userId),
      ).toBe(false);
    });

    it('is not fooled by a key merely containing the prefix mid-string', () => {
      expect(
        isAvatarObjectFor(
          validObject({ storageKey: `not-${avatarKeyPrefix(userId)}obj-1.png` }),
          userId,
        ),
      ).toBe(false);
    });
  });

  it('AVATAR_MAX_BYTES is 5 MB', () => {
    expect(AVATAR_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

import {
  updateUserSettingsSchema,
  patchUserSettingsSchema,
} from './update-user-settings.dto';
import {
  DATA_TABLE_MAX_ID_LENGTH,
  DATA_TABLE_MAX_VISIBLE_COLUMNS,
  DATA_TABLE_MAX_PAGE_SIZE,
  DATA_TABLE_MAX_TABLES,
  NOTIFICATION_MAX_EVENT_KEY_LENGTH,
  NOTIFICATION_MAX_EVENTS_PER_CHANNEL,
} from '../../common/schemas/user-settings-namespaces.schema';

// A valid uuid to stand in for `imageObjectId` throughout — the DTO schema
// only checks the shape (`z.string().uuid()`); whether it names an avatar the
// caller actually owns is checked by `UserSettingsService`, not here (see
// user-settings.service.spec.ts's `assertProfileImageReference` coverage).
const AVATAR_OBJECT_ID = '11111111-1111-4111-8111-111111111111';

describe('UpdateUserSettingsDto (PUT)', () => {
  describe('theme field', () => {
    it('should accept "light" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          imageSource: 'provider',
        },
      });

      expect(result.theme).toBe('light');
    });

    it('should accept "dark" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'dark',
        profile: {
          imageSource: 'provider',
        },
      });

      expect(result.theme).toBe('dark');
    });

    it('should accept "system" theme value', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'system',
        profile: {
          imageSource: 'provider',
        },
      });

      expect(result.theme).toBe('system');
    });

    it('should reject invalid theme value', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'blue',
          profile: {
            imageSource: 'provider',
          },
        }),
      ).toThrow();
    });

    it('should reject empty string as theme', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: '',
          profile: {
            imageSource: 'provider',
          },
        }),
      ).toThrow();
    });

    it('should require theme field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          profile: {
            imageSource: 'provider',
          },
        }),
      ).toThrow();
    });
  });

  describe('profile field', () => {
    it('should accept valid profile object', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: 'John Doe',
          imageSource: 'upload',
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });

      expect(result.profile.displayName).toBe('John Doe');
      expect(result.profile.imageSource).toBe('upload');
      expect(result.profile.imageObjectId).toBe(AVATAR_OBJECT_ID);
    });

    it('should accept profile with null imageObjectId', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          imageSource: 'provider',
          imageObjectId: null,
        },
      });

      expect(result.profile.imageObjectId).toBeNull();
    });

    it('should make displayName optional', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          imageSource: 'provider',
        },
      });

      expect(result.profile.displayName).toBeUndefined();
    });

    it('should accept empty displayName string', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: '',
          imageSource: 'provider',
        },
      });

      expect(result.profile.displayName).toBe('');
    });

    it('should accept displayName at maximum length (100 chars)', () => {
      const longName = 'a'.repeat(100);
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          displayName: longName,
          imageSource: 'provider',
        },
      });

      expect(result.profile.displayName).toBe(longName);
    });

    it('should reject displayName longer than 100 characters', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            displayName: tooLongName,
            imageSource: 'provider',
          },
        }),
      ).toThrow();
    });

    it('should require imageSource field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            displayName: 'Test',
          },
        }),
      ).toThrow();
    });

    it('should reject an imageSource value outside the enum', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            imageSource: 'gravatar',
          },
        }),
      ).toThrow();
    });

    it.each([['none'], ['provider'], ['upload']])(
      'should accept imageSource %j',
      (imageSource) => {
        const result = updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            imageSource,
            ...(imageSource === 'upload'
              ? { imageObjectId: AVATAR_OBJECT_ID }
              : {}),
          },
        });

        expect(result.profile.imageSource).toBe(imageSource);
      },
    );

    it('should accept a valid uuid for imageObjectId', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          imageSource: 'upload',
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });

      expect(result.profile.imageObjectId).toBe(AVATAR_OBJECT_ID);
    });

    it('should reject a non-uuid imageObjectId', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
          profile: {
            imageSource: 'upload',
            imageObjectId: 'not-a-uuid',
          },
        }),
      ).toThrow();
    });

    it('should make imageObjectId optional', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          imageSource: 'provider',
        },
      });

      expect(result.profile.imageObjectId).toBeUndefined();
    });

    it('should require profile field', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          theme: 'light',
        }),
      ).toThrow();
    });
  });

  describe('complete settings object', () => {
    it('should accept valid complete user settings', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'dark',
        profile: {
          displayName: 'Jane Doe',
          imageSource: 'upload',
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });

      expect(result).toEqual({
        theme: 'dark',
        profile: {
          displayName: 'Jane Doe',
          imageSource: 'upload',
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });
    });

    it('should accept minimal valid settings', () => {
      const result = updateUserSettingsSchema.parse({
        theme: 'system',
        profile: {
          imageSource: 'provider',
        },
      });

      expect(result).toEqual({
        theme: 'system',
        profile: {
          imageSource: 'provider',
        },
      });
    });
  });
});

describe('PatchUserSettingsDto (PATCH)', () => {
  describe('theme field', () => {
    it('should make theme field optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.theme).toBeUndefined();
    });

    it('should accept "light" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'light',
      });

      expect(result.theme).toBe('light');
    });

    it('should accept "dark" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
      });

      expect(result.theme).toBe('dark');
    });

    it('should accept "system" theme value when provided', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'system',
      });

      expect(result.theme).toBe('system');
    });

    it('should reject invalid theme value when provided', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          theme: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('profile field', () => {
    it('should make profile field optional', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result.profile).toBeUndefined();
    });

    it('should accept empty profile object', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {},
      });

      expect(result.profile).toEqual({});
    });

    it('should accept partial profile - only displayName', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'Updated Name',
        },
      });

      expect(result.profile?.displayName).toBe('Updated Name');
      expect(result.profile?.imageSource).toBeUndefined();
    });

    it('should accept partial profile - only imageSource', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          imageSource: 'none',
        },
      });

      expect(result.profile?.imageSource).toBe('none');
      expect(result.profile?.displayName).toBeUndefined();
    });

    it('should accept partial profile - only imageObjectId', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });

      expect(result.profile?.imageObjectId).toBe(AVATAR_OBJECT_ID);
    });

    it('should accept partial profile with null imageObjectId', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          imageObjectId: null,
        },
      });

      expect(result.profile?.imageObjectId).toBeNull();
    });

    it('should validate displayName max length when provided', () => {
      const tooLongName = 'a'.repeat(101);
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            displayName: tooLongName,
          },
        }),
      ).toThrow();
    });

    it('should reject a non-uuid imageObjectId when provided', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            imageObjectId: 'not-a-uuid',
          },
        }),
      ).toThrow();
    });

    it('should reject an imageSource value outside the enum', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          profile: {
            imageSource: 'gravatar',
          },
        }),
      ).toThrow();
    });

    it('should accept all profile fields together', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'New Name',
          imageSource: 'provider',
          imageObjectId: null,
        },
      });

      expect(result.profile).toEqual({
        displayName: 'New Name',
        imageSource: 'provider',
        imageObjectId: null,
      });
    });
  });

  describe('partial updates', () => {
    it('should accept empty object (all fields optional)', () => {
      const result = patchUserSettingsSchema.parse({});

      expect(result).toEqual({});
    });

    it('should accept update with only theme field', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'dark',
      });

      expect(result).toEqual({
        theme: 'dark',
      });
    });

    it('should accept update with only profile field', () => {
      const result = patchUserSettingsSchema.parse({
        profile: {
          displayName: 'Test User',
        },
      });

      expect(result).toEqual({
        profile: {
          displayName: 'Test User',
        },
      });
    });

    it('should accept update with both theme and profile', () => {
      const result = patchUserSettingsSchema.parse({
        theme: 'light',
        profile: {
          imageSource: 'upload',
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });

      expect(result).toEqual({
        theme: 'light',
        profile: {
          imageSource: 'upload',
          imageObjectId: AVATAR_OBJECT_ID,
        },
      });
    });
  });

  describe('dataTables namespace (PUT)', () => {
    const baseValid = {
      theme: 'light' as const,
      profile: { imageSource: 'provider' },
    };

    it('is optional - absent when not provided', () => {
      const result = updateUserSettingsSchema.parse(baseValid);
      expect(result.dataTables).toBeUndefined();
    });

    it('accepts an empty map', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        dataTables: {},
      });
      expect(result.dataTables).toEqual({});
    });

    // TRIPWIRE: if a future `.default()` sneaks into dataTableEntrySchema,
    // this is the test that catches it. An entry with no fields set must
    // parse to `{}` - not to an object carrying materialised defaults for
    // visibleColumns/density/pageSize/sort. See the WHY in
    // user-settings-namespaces.schema.ts: a materialised `visibleColumns: []`
    // would permanently hide every column added after the user's first
    // unrelated settings write.
    it('CRITICAL: an entry with no fields set does not materialise visibleColumns/density/pageSize/sort defaults', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        dataTables: { jobs: {} },
      });

      expect(result.dataTables).toEqual({ jobs: {} });
      expect(result.dataTables?.jobs).not.toHaveProperty('visibleColumns');
      expect(result.dataTables?.jobs).not.toHaveProperty('density');
      expect(result.dataTables?.jobs).not.toHaveProperty('pageSize');
      expect(result.dataTables?.jobs).not.toHaveProperty('sort');
    });

    it('accepts a fully populated entry', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        dataTables: {
          jobs: {
            visibleColumns: ['id', 'title'],
            density: 'compact',
            pageSize: 25,
            sort: { field: 'title', direction: 'asc' },
          },
        },
      });

      expect(result.dataTables).toEqual({
        jobs: {
          visibleColumns: ['id', 'title'],
          density: 'compact',
          pageSize: 25,
          sort: { field: 'title', direction: 'asc' },
        },
      });
    });

    describe('tableId format', () => {
      it.each([
        ['uppercase letters', 'Jobs'],
        ['leading hyphen', '-jobs'],
        ['punctuation', 'jobs!'],
      ])('rejects a tableId with %s (%j)', (_label, tableId) => {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { [tableId]: {} },
          }),
        ).toThrow();
      });

      it('accepts lowercase slugs with digits, hyphens, and underscores', () => {
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { 'jobs-2_v2': {} },
        });
        expect(result.dataTables).toEqual({ 'jobs-2_v2': {} });
      });

      it(`rejects a tableId longer than ${DATA_TABLE_MAX_ID_LENGTH} characters`, () => {
        const tooLong = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1);
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { [tooLong]: {} },
          }),
        ).toThrow();
      });

      it(`accepts a tableId at exactly ${DATA_TABLE_MAX_ID_LENGTH} characters`, () => {
        const maxLength = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH);
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { [maxLength]: {} },
        });
        expect(result.dataTables).toEqual({ [maxLength]: {} });
      });
    });

    describe('visibleColumns bound', () => {
      it(`accepts exactly ${DATA_TABLE_MAX_VISIBLE_COLUMNS} columns`, () => {
        const columns = Array.from(
          { length: DATA_TABLE_MAX_VISIBLE_COLUMNS },
          (_, i) => `col${i}`,
        );
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { visibleColumns: columns } },
        });
        expect(result.dataTables?.jobs.visibleColumns).toHaveLength(
          DATA_TABLE_MAX_VISIBLE_COLUMNS,
        );
      });

      it(`rejects more than ${DATA_TABLE_MAX_VISIBLE_COLUMNS} columns`, () => {
        const columns = Array.from(
          { length: DATA_TABLE_MAX_VISIBLE_COLUMNS + 1 },
          (_, i) => `col${i}`,
        );
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { jobs: { visibleColumns: columns } },
          }),
        ).toThrow();
      });
    });

    describe('pageSize bound', () => {
      it('rejects pageSize of 0', () => {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { jobs: { pageSize: 0 } },
          }),
        ).toThrow();
      });

      it(`rejects pageSize of ${DATA_TABLE_MAX_PAGE_SIZE + 1}`, () => {
        expect(() =>
          updateUserSettingsSchema.parse({
            ...baseValid,
            dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } },
          }),
        ).toThrow();
      });

      it('accepts pageSize of 1', () => {
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { pageSize: 1 } },
        });
        expect(result.dataTables?.jobs.pageSize).toBe(1);
      });

      it(`accepts pageSize of ${DATA_TABLE_MAX_PAGE_SIZE}`, () => {
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE } },
        });
        expect(result.dataTables?.jobs.pageSize).toBe(
          DATA_TABLE_MAX_PAGE_SIZE,
        );
      });
    });

    it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: { desnity: 'compact' } },
        }),
      ).toThrow();
    });

    it(`rejects dataTables: null - PUT states settings in full, so null has no "delete" meaning here`, () => {
      expect(() =>
        updateUserSettingsSchema.parse({ ...baseValid, dataTables: null }),
      ).toThrow();
    });

    it('rejects a null entry value ({ jobs: null }) - the nullable-entry form is PATCH-only', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: { jobs: null },
        }),
      ).toThrow();
    });

    it(
      `does NOT enforce the ${DATA_TABLE_MAX_TABLES}-table cap by itself - z.record() cannot ` +
        'express a max key count, so this is deliberately accepted here. The cap is ' +
        'enforced in UserSettingsService.assertDataTableLimit (see user-settings.service.spec.ts), ' +
        'against the merged result, precisely so an over-cap request surfaces as a 400 ' +
        'rather than escaping this schema as an uncaught ZodError.',
      () => {
        const tooMany = Object.fromEntries(
          Array.from({ length: DATA_TABLE_MAX_TABLES + 1 }, (_, i) => [
            `table${i}`,
            {},
          ]),
        );
        const result = updateUserSettingsSchema.parse({
          ...baseValid,
          dataTables: tooMany,
        });
        expect(Object.keys(result.dataTables ?? {})).toHaveLength(
          DATA_TABLE_MAX_TABLES + 1,
        );
      },
    );
  });

  describe('navigation namespace (PUT)', () => {
    const baseValid = {
      theme: 'light' as const,
      profile: { imageSource: 'provider' },
    };

    it('is optional - absent when not provided', () => {
      const result = updateUserSettingsSchema.parse(baseValid);
      expect(result.navigation).toBeUndefined();
    });

    it('accepts an empty object', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        navigation: {},
      });
      expect(result.navigation).toEqual({});
    });

    it('does not materialise a railCollapsed default when omitted', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        navigation: {},
      });
      expect(result.navigation).not.toHaveProperty('railCollapsed');
    });

    it('accepts railCollapsed true and false', () => {
      expect(
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollapsed: true },
        }).navigation,
      ).toEqual({ railCollapsed: true });
      expect(
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollapsed: false },
        }).navigation,
      ).toEqual({ railCollapsed: false });
    });

    it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollpsed: true },
        }),
      ).toThrow();
    });

    it('rejects navigation: null on PUT - null has no "delete" meaning for a full replace', () => {
      expect(() =>
        updateUserSettingsSchema.parse({ ...baseValid, navigation: null }),
      ).toThrow();
    });

    it('rejects railCollapsed: null on PUT - the nullable-field form is PATCH-only', () => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          navigation: { railCollapsed: null },
        }),
      ).toThrow();
    });
  });
});

describe('dataTables namespace (PATCH)', () => {
  it('is optional - absent when not provided', () => {
    const result = patchUserSettingsSchema.parse({});
    expect(result.dataTables).toBeUndefined();
  });

  // TRIPWIRE: same intent as the PUT-side test above, exercised through the
  // PATCH schema. A `.default()` sneaking into dataTableEntrySchema would
  // freeze a user's column set the first time they touch an unrelated field.
  it('CRITICAL: a patch entry with no fields set does not materialise visibleColumns/density/pageSize/sort defaults', () => {
    const result = patchUserSettingsSchema.parse({
      dataTables: { jobs: {} },
    });

    expect(result.dataTables).toEqual({ jobs: {} });
    const jobsEntry = (result.dataTables as Record<string, unknown>)?.jobs;
    expect(jobsEntry).not.toHaveProperty('visibleColumns');
    expect(jobsEntry).not.toHaveProperty('density');
    expect(jobsEntry).not.toHaveProperty('pageSize');
    expect(jobsEntry).not.toHaveProperty('sort');
  });

  it('accepts dataTables: null to clear the whole namespace', () => {
    const result = patchUserSettingsSchema.parse({ dataTables: null });
    expect(result.dataTables).toBeNull();
  });

  it('accepts a null entry ({ jobs: null }) to delete a single table', () => {
    const result = patchUserSettingsSchema.parse({
      dataTables: { jobs: null },
    });
    expect(result.dataTables).toEqual({ jobs: null });
  });

  it('rejects an entry with an individually-nulled field ({ jobs: { sort: null } }) - entries replace wholesale, fields are not individually nullable', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        dataTables: { jobs: { sort: null } },
      }),
    ).toThrow();
  });

  describe('tableId format', () => {
    it.each([
      ['uppercase letters', 'Jobs'],
      ['leading hyphen', '-jobs'],
      ['punctuation', 'jobs!'],
    ])('rejects a tableId with %s (%j)', (_label, tableId) => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { [tableId]: {} },
        }),
      ).toThrow();
    });

    it(`rejects a tableId longer than ${DATA_TABLE_MAX_ID_LENGTH} characters`, () => {
      const tooLong = 'a'.repeat(DATA_TABLE_MAX_ID_LENGTH + 1);
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { [tooLong]: {} },
        }),
      ).toThrow();
    });
  });

  describe('bounds', () => {
    it(`rejects more than ${DATA_TABLE_MAX_VISIBLE_COLUMNS} visible columns`, () => {
      const columns = Array.from(
        { length: DATA_TABLE_MAX_VISIBLE_COLUMNS + 1 },
        (_, i) => `col${i}`,
      );
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { visibleColumns: columns } },
        }),
      ).toThrow();
    });

    it('rejects pageSize of 0', () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { pageSize: 0 } },
        }),
      ).toThrow();
    });

    it(`rejects pageSize of ${DATA_TABLE_MAX_PAGE_SIZE + 1}`, () => {
      expect(() =>
        patchUserSettingsSchema.parse({
          dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE + 1 } },
        }),
      ).toThrow();
    });

    it('accepts pageSize of 1', () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: { pageSize: 1 } },
      });
      expect(result.dataTables).toEqual({ jobs: { pageSize: 1 } });
    });

    it(`accepts pageSize of ${DATA_TABLE_MAX_PAGE_SIZE}`, () => {
      const result = patchUserSettingsSchema.parse({
        dataTables: { jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE } },
      });
      expect(result.dataTables).toEqual({
        jobs: { pageSize: DATA_TABLE_MAX_PAGE_SIZE },
      });
    });
  });

  it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        dataTables: { jobs: { desnity: 'compact' } },
      }),
    ).toThrow();
  });
});

describe('navigation namespace (PATCH)', () => {
  it('is optional - absent when not provided', () => {
    const result = patchUserSettingsSchema.parse({});
    expect(result.navigation).toBeUndefined();
  });

  it('accepts navigation: null to clear the whole namespace', () => {
    const result = patchUserSettingsSchema.parse({ navigation: null });
    expect(result.navigation).toBeNull();
  });

  it('accepts railCollapsed: null to delete just that field', () => {
    const result = patchUserSettingsSchema.parse({
      navigation: { railCollapsed: null },
    });
    expect(result.navigation).toEqual({ railCollapsed: null });
  });

  it('accepts railCollapsed: true', () => {
    const result = patchUserSettingsSchema.parse({
      navigation: { railCollapsed: true },
    });
    expect(result.navigation).toEqual({ railCollapsed: true });
  });

  it('rejects a misspelled key instead of silently dropping it (.strict())', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        navigation: { railCollpsed: true },
      }),
    ).toThrow();
  });
});

// =============================================================================
// notifications namespace (issue #126, epic #109)
// =============================================================================
//
// Channel-outer, event-inner, and — unlike dataTables/navigation above — the
// CHANNEL level is closed (an enum) while the EVENT level is deliberately
// open. See the header of user-settings-namespaces.schema.ts for the full
// argument; the short version is repeated at each relevant test below.

describe('notifications namespace (PUT)', () => {
  const baseValid = {
    theme: 'light' as const,
    profile: { imageSource: 'provider' },
  };

  it('is optional - absent when not provided', () => {
    const result = updateUserSettingsSchema.parse(baseValid);
    expect(result.notifications).toBeUndefined();
  });

  it('accepts an empty namespace', () => {
    const result = updateUserSettingsSchema.parse({
      ...baseValid,
      notifications: {},
    });
    expect(result.notifications).toEqual({});
  });

  it('accepts a populated channel with a boolean per event key', () => {
    const result = updateUserSettingsSchema.parse({
      ...baseValid,
      notifications: {
        email: { 'user.welcome': false, 'security.role_changed': true },
      },
    });
    expect(result.notifications).toEqual({
      email: { 'user.welcome': false, 'security.role_changed': true },
    });
  });

  it('accepts every declared channel, independently', () => {
    const result = updateUserSettingsSchema.parse({
      ...baseValid,
      notifications: {
        email: { 'user.welcome': true },
        browser: { 'security.role_changed': false },
      },
    });
    expect(result.notifications).toEqual({
      email: { 'user.welcome': true },
      browser: { 'security.role_changed': false },
    });
  });

  it('rejects an unknown channel - the outer level is closed, unlike the event level below', () => {
    expect(() =>
      updateUserSettingsSchema.parse({
        ...baseValid,
        // 'sms' rather than 'push': #228 (epic #215) widened
        // NOTIFICATION_CHANNELS to include 'push', so 'push' is no longer a
        // usable stand-in for "a channel the registry does not declare".
        notifications: { sms: { 'user.welcome': true } },
      }),
    ).toThrow();
  });

  // THE DELIBERATE ASYMMETRY (see the schema file's header). The write path
  // must accept everything the read path can emit:
  //   * a rolling deploy can serve `GET /api/notifications/events` from a
  //     newer pod's registry while a resulting write lands on an older one;
  //   * `PUT` is a read-modify-write, so a client PUTs back a key the server
  //     just served it;
  //   * deleting a stale preference is a PATCH that NAMES the key, so
  //     validating event keys against the registry would make the very
  //     request that cleans one up impossible.
  // A typo'd key is stored and is harmless: `isChannelEnabled` only ever asks
  // about REGISTERED events, so a preference under an unknown key can never
  // affect a delivery decision.
  it('ACCEPTS an unknown event key - unlike the channel level, the event level is deliberately open', () => {
    const result = updateUserSettingsSchema.parse({
      ...baseValid,
      notifications: { email: { 'totally.unregistered.typo': true } },
    });
    expect(result.notifications).toEqual({
      email: { 'totally.unregistered.typo': true },
    });
  });

  // `mandatory` is a property of NOTIFICATION_EVENTS at runtime, not a schema
  // constraint - this schema has no registry to check against, and does not
  // try to. A stored `false` here is inert: the resolver in
  // notification-preferences.ts (#125) tests `event.mandatory` BEFORE it ever
  // looks at a stored preference, so this value is never consulted. See
  // "`mandatory` IS NOT ENFORCED HERE, DELIBERATELY" in the schema file.
  it('accepts a false preference for a mandatory event key - it is inert, not rejected', () => {
    const result = updateUserSettingsSchema.parse({
      ...baseValid,
      notifications: { email: { 'security.role_changed': false } },
    });
    expect(result.notifications).toEqual({
      email: { 'security.role_changed': false },
    });
  });

  describe('event key format', () => {
    it.each([
      ['uppercase letters', 'User.Welcome'],
      ['leading dot', '.user.welcome'],
      ['punctuation', 'user.welcome!'],
      ['empty string', ''],
    ])('rejects an event key with %s (%j)', (_label, key) => {
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          notifications: { email: { [key]: true } },
        }),
      ).toThrow();
    });

    it('accepts the <area>.<event> convention with digits, hyphens, and underscores', () => {
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        notifications: { email: { 'area_1.some-event_2': true } },
      });
      expect(result.notifications).toEqual({
        email: { 'area_1.some-event_2': true },
      });
    });

    it(`rejects an event key longer than ${NOTIFICATION_MAX_EVENT_KEY_LENGTH} characters`, () => {
      const tooLong = 'a'.repeat(NOTIFICATION_MAX_EVENT_KEY_LENGTH + 1);
      expect(() =>
        updateUserSettingsSchema.parse({
          ...baseValid,
          notifications: { email: { [tooLong]: true } },
        }),
      ).toThrow();
    });

    it(`accepts an event key at exactly ${NOTIFICATION_MAX_EVENT_KEY_LENGTH} characters`, () => {
      const maxLength = 'a'.repeat(NOTIFICATION_MAX_EVENT_KEY_LENGTH);
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        notifications: { email: { [maxLength]: true } },
      });
      expect(result.notifications).toEqual({ email: { [maxLength]: true } });
    });
  });

  it('rejects a non-boolean preference value', () => {
    expect(() =>
      updateUserSettingsSchema.parse({
        ...baseValid,
        notifications: { email: { 'user.welcome': 'yes' } },
      }),
    ).toThrow();
  });

  it('rejects notifications: null on PUT - PUT states the settings in full, so null has no "delete" meaning here', () => {
    expect(() =>
      updateUserSettingsSchema.parse({ ...baseValid, notifications: null }),
    ).toThrow();
  });

  it('rejects a null channel value ({ email: null }) - the nullable-channel form is PATCH-only', () => {
    expect(() =>
      updateUserSettingsSchema.parse({
        ...baseValid,
        notifications: { email: null },
      }),
    ).toThrow();
  });

  it('rejects a null event value ({ email: { key: null } }) on PUT - the nullable-value form is PATCH-only', () => {
    expect(() =>
      updateUserSettingsSchema.parse({
        ...baseValid,
        notifications: { email: { 'user.welcome': null } },
      }),
    ).toThrow();
  });

  it(
    `does NOT enforce the ${NOTIFICATION_MAX_EVENTS_PER_CHANNEL}-events-per-channel cap by itself - ` +
      'z.record() cannot express a max key count, so this is deliberately accepted here. The cap is ' +
      'enforced in UserSettingsService.assertNotificationLimit (see user-settings.service.spec.ts), ' +
      'against the MERGED result, so an over-cap request surfaces as a 400 rather than escaping as an ' +
      'uncaught ZodError.',
    () => {
      const tooMany = Object.fromEntries(
        Array.from({ length: NOTIFICATION_MAX_EVENTS_PER_CHANNEL + 1 }, (_, i) => [
          `area.event${i}`,
          true,
        ]),
      );
      const result = updateUserSettingsSchema.parse({
        ...baseValid,
        notifications: { email: tooMany },
      });
      expect(Object.keys(result.notifications?.email ?? {})).toHaveLength(
        NOTIFICATION_MAX_EVENTS_PER_CHANNEL + 1,
      );
    },
  );
});

describe('notifications namespace (PATCH)', () => {
  it('is optional - absent when not provided', () => {
    const result = patchUserSettingsSchema.parse({});
    expect(result.notifications).toBeUndefined();
  });

  it('accepts notifications: null to clear the whole namespace', () => {
    const result = patchUserSettingsSchema.parse({ notifications: null });
    expect(result.notifications).toBeNull();
  });

  it('accepts { email: null } to clear a single channel, leaving other channels unaddressed', () => {
    const result = patchUserSettingsSchema.parse({
      notifications: { email: null },
    });
    expect(result.notifications).toEqual({ email: null });
  });

  it("accepts { email: { 'user.welcome': null } } to delete a single event key", () => {
    const result = patchUserSettingsSchema.parse({
      notifications: { email: { 'user.welcome': null } },
    });
    expect(result.notifications).toEqual({ email: { 'user.welcome': null } });
  });

  it('accepts { email: { key: true } } naming exactly one event key and nothing else', () => {
    const result = patchUserSettingsSchema.parse({
      notifications: { email: { 'user.welcome': true } },
    });
    expect(result.notifications).toEqual({ email: { 'user.welcome': true } });
  });

  it('rejects an unknown channel', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        // 'sms' rather than 'push': #228 (epic #215) widened
        // NOTIFICATION_CHANNELS to include 'push', so 'push' is no longer a
        // usable stand-in for "a channel the registry does not declare".
        notifications: { sms: { 'user.welcome': true } },
      }),
    ).toThrow();
  });

  // Same deliberate asymmetry as the PUT-side test above, exercised through
  // PATCH - including the null-delete form, since a request that deletes a
  // stale preference necessarily NAMES the key it is deleting. Rejecting
  // unknown event keys here would make a stale preference permanently
  // un-cleanable.
  it('ACCEPTS an unknown event key, both as a set and as a null-delete', () => {
    const set = patchUserSettingsSchema.parse({
      notifications: { email: { 'totally.unregistered.typo': true } },
    });
    expect(set.notifications).toEqual({
      email: { 'totally.unregistered.typo': true },
    });

    const del = patchUserSettingsSchema.parse({
      notifications: { email: { 'totally.unregistered.typo': null } },
    });
    expect(del.notifications).toEqual({
      email: { 'totally.unregistered.typo': null },
    });
  });

  it('accepts a false preference for a mandatory event key - inert, not rejected (see the PUT-side test)', () => {
    const result = patchUserSettingsSchema.parse({
      notifications: { email: { 'security.role_changed': false } },
    });
    expect(result.notifications).toEqual({
      email: { 'security.role_changed': false },
    });
  });

  describe('event key format', () => {
    it.each([
      ['uppercase letters', 'User.Welcome'],
      ['leading dot', '.user.welcome'],
      ['punctuation', 'user.welcome!'],
    ])('rejects an event key with %s (%j)', (_label, key) => {
      expect(() =>
        patchUserSettingsSchema.parse({
          notifications: { email: { [key]: true } },
        }),
      ).toThrow();
    });

    it(`rejects an event key longer than ${NOTIFICATION_MAX_EVENT_KEY_LENGTH} characters`, () => {
      const tooLong = 'a'.repeat(NOTIFICATION_MAX_EVENT_KEY_LENGTH + 1);
      expect(() =>
        patchUserSettingsSchema.parse({
          notifications: { email: { [tooLong]: true } },
        }),
      ).toThrow();
    });
  });

  it('rejects a non-boolean, non-null preference value', () => {
    expect(() =>
      patchUserSettingsSchema.parse({
        notifications: { email: { 'user.welcome': 'yes' } },
      }),
    ).toThrow();
  });

  it(
    `does NOT enforce the ${NOTIFICATION_MAX_EVENTS_PER_CHANNEL}-events-per-channel cap by itself - ` +
      'enforced post-merge in UserSettingsService.assertNotificationLimit instead, against the ' +
      'MERGED result (see user-settings.service.spec.ts).',
    () => {
      const tooMany = Object.fromEntries(
        Array.from({ length: NOTIFICATION_MAX_EVENTS_PER_CHANNEL + 1 }, (_, i) => [
          `area.event${i}`,
          true,
        ]),
      );
      const result = patchUserSettingsSchema.parse({
        notifications: { email: tooMany },
      });
      expect(
        Object.keys((result.notifications as Record<string, unknown>)?.email ?? {}),
      ).toHaveLength(NOTIFICATION_MAX_EVENTS_PER_CHANNEL + 1);
    },
  );
});

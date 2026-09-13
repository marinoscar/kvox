export const userSettingsFixtures = {
  default: {
    theme: 'system',
    profile: {
      imageSource: 'provider',
      imageObjectId: null,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },

  darkTheme: {
    theme: 'dark',
    profile: {
      imageSource: 'provider',
      imageObjectId: null,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },

  customProfile: {
    theme: 'light',
    profile: {
      displayName: 'Custom Name',
      imageSource: 'none',
      imageObjectId: null,
    },
    updatedAt: new Date().toISOString(),
    version: 1,
  },
};

export const systemSettingsFixtures = {
  default: {
    notifications: {
      browserEnabled: true,
      disabledEvents: [],
    },
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    version: 1,
  },

  restrictive: {
    notifications: {
      browserEnabled: false,
      disabledEvents: ['security.role_changed'],
    },
    updatedAt: new Date().toISOString(),
    updatedBy: null,
    version: 1,
  },
};

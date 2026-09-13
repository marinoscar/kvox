import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';
import { ProfileSettings } from '../../../components/settings/ProfileSettings';
import type { ProfileImageMutationResponse, UserSettings } from '../../../types';

/**
 * #367. `ProfileSettings` replaced the old "use Google profile image" switch
 * with a three-option radio group (none / provider / upload), and the upload
 * and remove actions now come back as a whole settings document adopted via
 * `onSettingsReplaced`, not a PATCH the caller assembles.
 *
 * A follow-up (#367) changed how the uploaded-picture PREVIEW is loaded: the
 * public avatar route only serves a picture while it is the selected source,
 * so the preview is now fetched through the authenticated
 * `GET /user-settings/profile-image` (`fetchProfileImagePreview`) and rendered
 * from a `Blob` via an object URL, revoked on change/unmount. Those tests live
 * in the "Uploaded picture preview" describe block below; the URL-globals are
 * stubbed in `beforeEach` so every test — not only that block — can safely
 * exercise `handleUploaded`, which always builds a local object-URL preview.
 */

// Mock the ImageUpload component: a button that, when clicked, reports a
// fixed successful upload result AND the picked file to the real
// `handleUploaded` in `ProfileSettings`, exactly like `UserSettingsPages.test.tsx`
// does for `onSettingsReplaced` one level up.
vi.mock('../../../components/settings/ImageUpload', () => ({
  ImageUpload: ({
    onUploaded,
    disabled,
    label,
  }: {
    onUploaded: (
      result: ProfileImageMutationResponse,
      file: File,
    ) => void | Promise<void>;
    disabled?: boolean;
    label?: string;
  }) => (
    <button
      data-testid="image-upload-mock"
      disabled={disabled}
      onClick={() =>
        onUploaded(
          {
            settings: {
              theme: 'system',
              profile: { imageSource: 'upload', imageObjectId: 'obj-1' },
              updatedAt: '2024-06-01T00:00:00.000Z',
              version: 5,
            },
            profileImageUrl: 'https://example.com/uploaded-mock.jpg',
          },
          new File(['picked-bytes'], 'picked.png', { type: 'image/png' }),
        )
      }
    >
      {label ?? 'Upload picture'}
    </button>
  ),
}));

// Mock the AuthContext - need to import original to get AuthContext
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: vi.fn(),
  };
});

// `ProfileSettings` calls `deleteProfileImage`/`fetchProfileImagePreview`
// directly (not through a prop), so both have to be mocked at the module
// level, like `ImageUpload.test.tsx` does for `uploadProfileImage`.
vi.mock('../../../services/api', () => ({
  deleteProfileImage: vi.fn(),
  fetchProfileImagePreview: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    details?: unknown;
    constructor(message: string, status: number, code?: string, details?: unknown) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  },
}));

import { useAuth } from '../../../contexts/AuthContext';
import { ApiError, deleteProfileImage, fetchProfileImagePreview } from '../../../services/api';

const mockUseAuth = vi.mocked(useAuth);
const mockDeleteProfileImage = vi.mocked(deleteProfileImage);
const mockFetchProfileImagePreview = vi.mocked(fetchProfileImagePreview);

describe('ProfileSettings', () => {
  const defaultProfile: UserSettings['profile'] = {
    displayName: undefined,
    imageSource: 'provider',
    imageObjectId: null,
  };

  const noPictureProfile: UserSettings['profile'] = {
    displayName: undefined,
    imageSource: 'none',
    imageObjectId: null,
  };

  const uploadedProfile: UserSettings['profile'] = {
    displayName: undefined,
    imageSource: 'upload',
    imageObjectId: 'existing-object-id',
  };

  const userWithProviderImage = {
    ...mockUser,
    providerProfileImageUrl: 'https://example.com/provider-image.jpg',
  };

  const userWithoutProviderImage = {
    ...mockUser,
    providerProfileImageUrl: null,
  };

  const mockOnSave = vi.fn();
  const mockOnSettingsReplaced = vi.fn();
  const mockRefreshUser = vi.fn();

  function mockAuth(user = userWithProviderImage) {
    mockUseAuth.mockReturnValue({
      user,
      isLoading: false,
      isAuthenticated: true,
      providers: [],
      login: vi.fn(),
      logout: vi.fn(),
      refreshUser: mockRefreshUser,
    });
  }

  // Stubs `URL.createObjectURL`/`URL.revokeObjectURL` the way
  // `PersonalAccessTokens.test.tsx`'s CSV-export block does: a counter-based
  // fake so each call returns a distinct, inspectable URL, and a plain spy for
  // revocation. `handleUploaded` calls `URL.createObjectURL` unconditionally
  // (jsdom implements neither function), so this must be installed globally
  // for this file, not only for the "preview" tests below.
  let createObjectURLSpy: ReturnType<typeof vi.fn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>;
  let objectUrlCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    objectUrlCounter = 0;
    createObjectURLSpy = vi.fn(() => `blob:mock-${++objectUrlCounter}`);
    revokeObjectURLSpy = vi.fn();
    URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLSpy as unknown as typeof URL.revokeObjectURL;

    mockRefreshUser.mockResolvedValue(undefined);
    mockAuth();
    mockOnSave.mockResolvedValue(undefined);
    // Safe default for any test that renders with `hasUploadedProfileImage:
    // true` without configuring its own resolution: a rejection falls back to
    // initials, exactly like a real 404 for "nothing stored yet".
    mockFetchProfileImagePreview.mockRejectedValue(new ApiError('Not Found', 404));
  });

  describe('Rendering', () => {
    it('should render profile card with title', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(screen.getByText('Profile')).toBeInTheDocument();
      expect(screen.getByText(/customize how you appear to others/i)).toBeInTheDocument();
    });

    it('should render display name input with current value', () => {
      const profile = { ...defaultProfile, displayName: 'Custom Name' };

      render(<ProfileSettings profile={profile} onSave={mockOnSave} />);

      expect(screen.getByLabelText(/display name/i)).toHaveValue('Custom Name');
    });

    it('should render empty display name input when not set', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(screen.getByLabelText(/display name/i)).toHaveValue('');
    });

    it('should render email field as read-only', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      const emailInput = screen.getByLabelText(/email/i);
      expect(emailInput).toBeDisabled();
      expect(emailInput).toHaveValue(mockUser.email);
      expect(screen.getByText(/email cannot be changed/i)).toBeInTheDocument();
    });

    it('should render save button', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  describe('Picture source radio group', () => {
    it('should render all three picture source options with accessible labels', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(screen.getByRole('radio', { name: /no picture/i })).toBeInTheDocument();
      expect(
        screen.getByRole('radio', { name: /picture from your sign-in provider/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /upload a picture/i })).toBeInTheDocument();
    });

    it('should check the option matching the saved imageSource', () => {
      render(<ProfileSettings profile={noPictureProfile} onSave={mockOnSave} />);

      expect(screen.getByRole('radio', { name: /no picture/i })).toBeChecked();
      expect(
        screen.getByRole('radio', { name: /picture from your sign-in provider/i }),
      ).not.toBeChecked();
    });

    it('should disable the provider option and explain why when the provider supplied no picture', () => {
      mockAuth(userWithoutProviderImage);

      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      const providerRadio = screen.getByRole('radio', {
        name: /picture from your sign-in provider/i,
      });
      expect(providerRadio).toBeDisabled();
      expect(screen.getByText(/your sign-in provider didn't supply a picture/i)).toBeInTheDocument();
    });

    it('should enable the provider option when the provider supplied a picture', () => {
      mockAuth(userWithProviderImage);

      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(
        screen.getByRole('radio', { name: /picture from your sign-in provider/i }),
      ).toBeEnabled();
    });

    it('should never disable the "no picture" or "upload" options when the page is not disabled/busy', () => {
      mockAuth(userWithoutProviderImage);

      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(screen.getByRole('radio', { name: /no picture/i })).toBeEnabled();
      expect(screen.getByRole('radio', { name: /upload a picture/i })).toBeEnabled();
    });

    /**
     * Fixed in #367 (`fix(web): respect the disabled prop on profile picture
     * options`): each option's `disabled` field used to be a boolean literal
     * (`false`, `false`, or `!providerUrl`), which MUI's `FormControlLabel`
     * prefers over the enclosing fieldset's own `disabled`. `ProfileSettings`
     * now passes `controlsDisabled || option.disabled`, so the page-level
     * `disabled` prop (and the busy state it's OR'd with) reaches every radio,
     * not only the "Picture from your sign-in provider" one.
     */
    it('disables every radio option via the page-level disabled prop', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} disabled />);

      expect(screen.getByLabelText(/display name/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(screen.getByRole('radio', { name: /no picture/i })).toBeDisabled();
      expect(screen.getByRole('radio', { name: /upload a picture/i })).toBeDisabled();
      expect(
        screen.getByRole('radio', { name: /picture from your sign-in provider/i }),
      ).toBeDisabled();
    });

    it('disables every radio option while a save is in flight', async () => {
      const user = userEvent.setup();
      let resolveSave: () => void = () => {};
      mockOnSave.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      );

      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /no picture/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(screen.getByRole('radio', { name: /no picture/i })).toBeDisabled();
      expect(screen.getByRole('radio', { name: /upload a picture/i })).toBeDisabled();
      expect(
        screen.getByRole('radio', { name: /picture from your sign-in provider/i }),
      ).toBeDisabled();

      resolveSave();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();
      });
    });
  });

  describe('Selecting none or provider', () => {
    it('should enable save and patch imageSource when switching to none', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).toBeDisabled();

      await user.click(screen.getByRole('radio', { name: /no picture/i }));
      expect(saveButton).toBeEnabled();

      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith({
          displayName: undefined,
          imageSource: 'none',
        });
      });
    });

    it('should enable save and patch imageSource when switching from none to provider', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={noPictureProfile} onSave={mockOnSave} />);

      await user.click(
        screen.getByRole('radio', { name: /picture from your sign-in provider/i }),
      );
      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).toBeEnabled();

      await user.click(saveButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith({
          displayName: undefined,
          imageSource: 'provider',
        });
      });
    });

    it('should call refreshUser after a successful save', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /no picture/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mockRefreshUser).toHaveBeenCalled();
      });
    });

    it('should not include imageSource in the patch when only the display name changes', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.type(screen.getByLabelText(/display name/i), 'New Name');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalledWith({ displayName: 'New Name' });
      });
    });
  });

  describe('Selecting upload with no picture yet', () => {
    it('should show the upload control without enabling save', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /upload a picture/i }));

      expect(screen.getByTestId('image-upload-mock')).toBeInTheDocument();
      // Choosing "Upload" before a picture exists is UI state only — the API
      // rejects `imageSource: 'upload'` with nothing uploaded yet, and the
      // upload endpoint sets the source itself once it succeeds.
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(mockOnSave).not.toHaveBeenCalled();
    });

    it('should explain that the current picture stays until an upload succeeds', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /upload a picture/i }));

      expect(
        screen.getByText(/your current picture stays in place until an upload succeeds/i),
      ).toBeInTheDocument();
    });

    it('should not show the upload control before "Upload" is selected', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      expect(screen.queryByTestId('image-upload-mock')).not.toBeInTheDocument();
    });
  });

  describe('Successful upload', () => {
    it('should adopt the returned settings via onSettingsReplaced with a success message', async () => {
      const user = userEvent.setup();
      render(
        <ProfileSettings
          profile={defaultProfile}
          onSave={mockOnSave}
          onSettingsReplaced={mockOnSettingsReplaced}
        />,
      );

      await user.click(screen.getByRole('radio', { name: /upload a picture/i }));
      await user.click(screen.getByTestId('image-upload-mock'));

      await waitFor(() => {
        expect(mockOnSettingsReplaced).toHaveBeenCalledWith(
          {
            theme: 'system',
            profile: { imageSource: 'upload', imageObjectId: 'obj-1' },
            updatedAt: '2024-06-01T00:00:00.000Z',
            version: 5,
          },
          'Profile picture updated',
        );
      });
    });

    it('should call refreshUser after a successful upload', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /upload a picture/i }));
      await user.click(screen.getByTestId('image-upload-mock'));

      await waitFor(() => {
        expect(mockRefreshUser).toHaveBeenCalled();
      });
    });

    it('should not call onSave for an upload — it never goes through the PATCH path', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /upload a picture/i }));
      await user.click(screen.getByTestId('image-upload-mock'));

      await waitFor(() => {
        expect(mockRefreshUser).toHaveBeenCalled();
      });
      expect(mockOnSave).not.toHaveBeenCalled();
    });

    it('should show the "Replace picture" label and a remove button once a picture is uploaded', () => {
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      expect(screen.getByRole('button', { name: 'Replace picture' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /remove uploaded picture/i }),
      ).toBeInTheDocument();
    });

    it('should build a local object-URL preview from the picked file immediately after upload', async () => {
      // The preview only renders while `profile.imageObjectId` is set (`hasUpload`),
      // so this starts from an already-uploaded profile — matching "Replace
      // picture" — rather than a fresh "Upload a picture" selection whose
      // `profile` prop the caller has not yet updated.
      //
      // Not asserted here: the FINAL rendered `<img>` — `await user.click`
      // flushes the whole `handleUploaded` chain, including the post-upload
      // refetch that supersedes this optimistic preview by design (see the
      // "Uploaded picture preview" describe block below for that DOM-level
      // assertion, once the refetch itself resolves to the same picture).
      // What's checked here is the OPTIMISTIC step itself: the picked file is
      // turned into an object URL synchronously, before the refetch settles.
      const user = userEvent.setup();
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('button', { name: 'Replace picture' }));

      await waitFor(() => {
        expect(createObjectURLSpy).toHaveBeenCalledWith(expect.any(File));
      });
    });

    /**
     * Fixed in #367 (`fix(web): adopt uploaded settings before building the
     * local preview`): the cosmetic object-URL preview used to be built
     * BEFORE `onSettingsReplaced` was called, so a throw there (e.g. an
     * environment with no `URL.createObjectURL`) skipped adopting the new
     * `version`, leaving the next PATCH doomed to 409. The preview build is
     * now wrapped in its own try/catch, guarded, and runs AFTER the settings
     * are adopted.
     */
    it('adopts the returned settings even if building the local preview throws', async () => {
      createObjectURLSpy.mockImplementationOnce(() => {
        throw new Error('createObjectURL unavailable');
      });
      const user = userEvent.setup();
      render(
        <ProfileSettings
          profile={defaultProfile}
          onSave={mockOnSave}
          onSettingsReplaced={mockOnSettingsReplaced}
        />,
      );

      await user.click(screen.getByRole('radio', { name: /upload a picture/i }));
      await user.click(screen.getByTestId('image-upload-mock'));

      await waitFor(() => {
        expect(mockOnSettingsReplaced).toHaveBeenCalledWith(
          {
            theme: 'system',
            profile: { imageSource: 'upload', imageObjectId: 'obj-1' },
            updatedAt: '2024-06-01T00:00:00.000Z',
            version: 5,
          },
          'Profile picture updated',
        );
      });
      // The re-fetch still runs despite the cosmetic preview failing.
      await waitFor(() => {
        expect(mockRefreshUser).toHaveBeenCalled();
      });
    });
  });

  describe('Removing an uploaded picture', () => {
    beforeEach(() => {
      mockDeleteProfileImage.mockResolvedValue({
        settings: {
          theme: 'system',
          profile: { imageSource: 'provider', imageObjectId: null },
          updatedAt: '2024-06-02T00:00:00.000Z',
          version: 6,
        },
        profileImageUrl: null,
      });
    });

    it('should ask for confirmation before removing', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));

      expect(screen.getByText('Remove uploaded picture?')).toBeInTheDocument();
      expect(mockDeleteProfileImage).not.toHaveBeenCalled();
    });

    it('should call the DELETE endpoint only after confirming', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(mockDeleteProfileImage).toHaveBeenCalledTimes(1);
      });
    });

    it('should not call the DELETE endpoint when cancelled', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockDeleteProfileImage).not.toHaveBeenCalled();
      // The Dialog exit transition means the title isn't removed synchronously.
      await waitFor(() => {
        expect(screen.queryByText('Remove uploaded picture?')).not.toBeInTheDocument();
      });
    });

    it('should adopt the returned settings via onSettingsReplaced after removal', async () => {
      const user = userEvent.setup();
      render(
        <ProfileSettings
          profile={uploadedProfile}
          onSave={mockOnSave}
          onSettingsReplaced={mockOnSettingsReplaced}
        />,
      );

      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(mockOnSettingsReplaced).toHaveBeenCalledWith(
          {
            theme: 'system',
            profile: { imageSource: 'provider', imageObjectId: null },
            updatedAt: '2024-06-02T00:00:00.000Z',
            version: 6,
          },
          'Uploaded picture removed',
        );
      });
    });

    it('should surface a server error message when removal fails', async () => {
      mockDeleteProfileImage.mockRejectedValue(new ApiError('Cannot remove right now', 400));
      const user = userEvent.setup();
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(screen.getByText('Cannot remove right now')).toBeInTheDocument();
      });
      expect(mockOnSettingsReplaced).not.toHaveBeenCalled();
    });

    it('should fall back to a generic message when removal fails with no server message', async () => {
      mockDeleteProfileImage.mockRejectedValue(new ApiError('Request failed', 500));
      const user = userEvent.setup();
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        expect(
          screen.getByText(/failed to remove the uploaded picture/i),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Loading State', () => {
    it('should show saving text during save', async () => {
      const user = userEvent.setup();
      let resolveSave: () => void = () => {};
      mockOnSave.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      );

      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /no picture/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(screen.getByRole('button', { name: /saving\.\.\./i })).toBeInTheDocument();

      resolveSave();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
      });
    });

    it('should disable save button during save', async () => {
      const user = userEvent.setup();
      let resolveSave: () => void = () => {};
      mockOnSave.mockReturnValue(
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
      );

      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      await user.click(screen.getByRole('radio', { name: /no picture/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      expect(screen.getByRole('button', { name: /saving\.\.\./i })).toBeDisabled();

      resolveSave();
    });
  });

  describe('Change Tracking', () => {
    it('should detect display name changes', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      const saveButton = screen.getByRole('button', { name: /save changes/i });
      expect(saveButton).toBeDisabled();

      await user.type(screen.getByLabelText(/display name/i), 'Change');

      expect(saveButton).toBeEnabled();
    });

    it('should reset changes when the profile prop changes', async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <ProfileSettings profile={defaultProfile} onSave={mockOnSave} />,
      );

      await user.type(screen.getByLabelText(/display name/i), 'Changed Name');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();

      rerender(
        <ProfileSettings
          profile={{ ...defaultProfile, displayName: 'Server Name' }}
          onSave={mockOnSave}
        />,
      );

      expect(screen.getByLabelText(/display name/i)).toHaveValue('Server Name');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('should disable save when changes are reverted', async () => {
      const user = userEvent.setup();
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} />);

      const displayNameInput = screen.getByLabelText(/display name/i);
      await user.type(displayNameInput, 'New Name');
      expect(screen.getByRole('button', { name: /save changes/i })).toBeEnabled();

      await user.clear(displayNameInput);
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });
  });

  describe('Disabled State', () => {
    it('should disable display name input when disabled prop is true', () => {
      render(<ProfileSettings profile={defaultProfile} onSave={mockOnSave} disabled />);

      expect(screen.getByLabelText(/display name/i)).toBeDisabled();
    });

    it('should disable the save button when disabled prop is true', () => {
      const profile = { ...defaultProfile, displayName: 'Some Name' };

      render(<ProfileSettings profile={profile} onSave={mockOnSave} disabled />);

      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('should disable the remove-picture button when disabled prop is true', () => {
      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} disabled />);

      expect(screen.getByRole('button', { name: /remove uploaded picture/i })).toBeDisabled();
    });
  });

  /**
   * #367 follow-up: the Upload option's preview is loaded through the
   * authenticated `GET /user-settings/profile-image` (`fetchProfileImagePreview`)
   * whenever `user.hasUploadedProfileImage` is true — regardless of which
   * source is currently SELECTED — because the public avatar route only
   * serves the picture while `upload` is the active source.
   */
  describe('Uploaded picture preview', () => {
    it('fetches and renders the preview via a blob object URL when hasUploadedProfileImage is true', async () => {
      const blob = new Blob(['bytes'], { type: 'image/png' });
      mockFetchProfileImagePreview.mockResolvedValue(blob);
      mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: true });

      const { container } = render(
        <ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />,
      );

      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(createObjectURLSpy).toHaveBeenCalledWith(blob);
      });
      await waitFor(() => {
        const imgs = Array.from(container.querySelectorAll('img'));
        expect(imgs.some((img) => img.getAttribute('src')?.startsWith('blob:'))).toBe(true);
      });
    });

    it('falls back to initials with no error banner when the preview fetch fails', async () => {
      mockFetchProfileImagePreview.mockRejectedValue(new ApiError('Not Found', 404));
      mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: true });

      const { container } = render(
        <ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />,
      );

      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(1);
      });

      // No error banner — a missing/failed preview is not worth alarming over.
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      // No blob preview was ever rendered.
      const imgs = Array.from(container.querySelectorAll('img'));
      expect(imgs.some((img) => img.getAttribute('src')?.startsWith('blob:'))).toBe(false);
    });

    it('still shows the upload preview while "None" is the selected source', async () => {
      const blob = new Blob(['bytes'], { type: 'image/png' });
      mockFetchProfileImagePreview.mockResolvedValue(blob);
      mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: true });

      const noneSelectedButUploaded: UserSettings['profile'] = {
        displayName: undefined,
        imageSource: 'none',
        imageObjectId: 'existing-object-id',
      };

      const { container } = render(
        <ProfileSettings profile={noneSelectedButUploaded} onSave={mockOnSave} />,
      );

      // The upload OPTION still renders its own preview...
      await waitFor(() => {
        const imgs = Array.from(container.querySelectorAll('img'));
        expect(imgs.some((img) => img.getAttribute('src')?.startsWith('blob:'))).toBe(true);
      });
      // ...while the top preview (the currently SELECTED source, "none") shows
      // initials rather than any picture — no <img> is rendered for it since
      // MUI's Avatar only emits one when given a src.
      expect(
        screen.queryByAltText(/profile picture preview for/i),
      ).not.toBeInTheDocument();
    });

    it('revokes the previous object URL when the preview changes, and the current one on unmount', async () => {
      const blob = new Blob(['bytes'], { type: 'image/png' });
      mockFetchProfileImagePreview.mockResolvedValue(blob);
      mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: true });

      const { unmount } = render(
        <ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />,
      );

      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      });
      const firstUrl = createObjectURLSpy.mock.results[0]!.value as string;

      // Replacing the picture builds a new local preview, revoking the
      // fetched one.
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Replace picture' }));

      await waitFor(() => {
        expect(revokeObjectURLSpy).toHaveBeenCalledWith(firstUrl);
      });

      // The post-upload refetch (nonce bump) replaces the preview again.
      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(2);
      });

      const lastUrl = createObjectURLSpy.mock.results[createObjectURLSpy.mock.results.length - 1]!
        .value as string;

      unmount();

      expect(revokeObjectURLSpy).toHaveBeenCalledWith(lastUrl);
    });

    it('re-fetches the preview after a successful upload', async () => {
      mockFetchProfileImagePreview.mockResolvedValue(new Blob(['a'], { type: 'image/png' }));
      mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: true });

      render(<ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />);

      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(1);
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Replace picture' }));

      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(2);
      });
    });

    it('clears the preview once removal brings hasUploadedProfileImage back to false', async () => {
      mockFetchProfileImagePreview.mockResolvedValue(new Blob(['a'], { type: 'image/png' }));
      mockDeleteProfileImage.mockResolvedValue({
        settings: {
          theme: 'system',
          profile: { imageSource: 'provider', imageObjectId: null },
          updatedAt: '2024-06-02T00:00:00.000Z',
          version: 6,
        },
        profileImageUrl: null,
      });
      // Simulates the real flow: `refreshUserQuietly` -> `refreshUser()` pulls
      // a fresh user from the server, whose `hasUploadedProfileImage` is now
      // false. The mocked `useAuth` is re-read on every render, so updating
      // its return value here and letting the component's own state updates
      // trigger a re-render is enough to observe the effect.
      mockRefreshUser.mockImplementation(async () => {
        mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: false });
      });
      mockAuth({ ...userWithProviderImage, hasUploadedProfileImage: true });

      const { container } = render(
        <ProfileSettings profile={uploadedProfile} onSave={mockOnSave} />,
      );

      await waitFor(() => {
        expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        const imgs = Array.from(container.querySelectorAll('img'));
        expect(imgs.some((img) => img.getAttribute('src')?.startsWith('blob:'))).toBe(true);
      });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /remove uploaded picture/i }));
      await user.click(screen.getByRole('button', { name: 'Remove' }));

      await waitFor(() => {
        const imgs = Array.from(container.querySelectorAll('img'));
        expect(imgs.some((img) => img.getAttribute('src')?.startsWith('blob:'))).toBe(false);
      });
      // No second fetch: once `hasUploadedProfileImage` reads false the effect
      // clears the preview directly rather than calling the endpoint again.
      expect(mockFetchProfileImagePreview).toHaveBeenCalledTimes(1);
    });
  });
});

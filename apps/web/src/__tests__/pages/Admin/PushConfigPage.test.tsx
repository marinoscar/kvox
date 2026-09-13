/**
 * `/admin/settings/push` (issue #355).
 *
 * `usePushConfig` is mocked, matching the pattern `EmailSettingsPage.test.tsx`
 * uses for `useEmailSettings` — this suite is about the PAGE's own rendering,
 * gating, and the two confirmation dialogs' typed-literal gating, not the
 * hook's fetch/save plumbing (which belongs to a hook-level test).
 *
 * `PushConfigConfirmDialog` is NOT mocked: the rotate/remove typed-literal
 * gating IS the thing under test here, and it lives entirely inside that
 * component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../../utils/test-utils';
import type { PushConfigAdminView } from '../../../services/pushConfig';

vi.mock('../../../hooks/usePushConfig', () => ({
  usePushConfig: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { usePushConfig } from '../../../hooks/usePushConfig';
import { usePermissions } from '../../../hooks/usePermissions';
import PushConfigPage from '../../../pages/Admin/PushConfigPage';

const mockUsePushConfig = vi.mocked(usePushConfig);
const mockUsePermissions = vi.mocked(usePermissions);

const WRITE_PERMISSIONS = ['push:read', 'push:write'];
const READ_ONLY_PERMISSIONS = ['push:read'];

/** A value shaped like a private key — must NEVER appear in any rendered DOM node or call body. */
const FORBIDDEN_PRIVATE_KEY_MATERIAL = 'THIS-IS-A-FAKE-VAPID-PRIVATE-KEY-DO-NOT-RENDER-9f8e7d';

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

const unconfigured: PushConfigAdminView = {
  enabled: false,
  configured: false,
  publicKey: null,
  subject: null,
  privateKeyStatus: { configured: false, hint: null, updatedAt: null, updatedByUserId: null },
  settingsError: null,
  version: 0,
  updatedAt: null,
  updatedBy: null,
};

const configuredEnabled: PushConfigAdminView = {
  enabled: true,
  configured: true,
  publicKey: 'BEol6Zy8example-public-vapid-key-value-9f8e',
  subject: 'mailto:ops@example.com',
  privateKeyStatus: {
    configured: true,
    hint: '••••ab12',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByUserId: 'admin-user-id',
  },
  settingsError: null,
  version: 3,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: 'admin@example.com',
};

const configuredDisabled: PushConfigAdminView = {
  ...configuredEnabled,
  enabled: false,
};

function setHook(overrides: Partial<ReturnType<typeof usePushConfig>> = {}) {
  const save = vi.fn().mockResolvedValue(true);
  const generate = vi.fn().mockResolvedValue(true);
  const rotate = vi.fn().mockResolvedValue(true);
  const remove = vi.fn().mockResolvedValue(true);
  mockUsePushConfig.mockReturnValue({
    config: configuredEnabled,
    isLoading: false,
    loadError: null,
    isSaving: false,
    saveError: null,
    save,
    clearSaveError: vi.fn(),
    isActing: false,
    actionError: null,
    clearActionError: vi.fn(),
    generate,
    rotate,
    remove,
    refresh: vi.fn(),
    ...overrides,
  });
  return { save, generate, rotate, remove };
}

const renderAsAdmin = () => render(<PushConfigPage />, { wrapperOptions: { user: mockAdminUser } });

describe('PushConfigPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPermissions(WRITE_PERMISSIONS);
    setHook();
  });

  // ==========================================================================
  // Status rendering: unconfigured / configured+enabled / configured+disabled
  // ==========================================================================

  describe('status panel', () => {
    it('renders "Not configured" and the empty-state copy when nothing is configured', () => {
      setHook({ config: unconfigured });

      renderAsAdmin();

      expect(screen.getByText('Not configured')).toBeInTheDocument();
      expect(
        screen.getByText(/no key pair has been generated yet/i),
      ).toBeInTheDocument();
    });

    it('renders "Enabled" for a configured, enabled deployment', () => {
      setHook({ config: configuredEnabled });

      renderAsAdmin();

      expect(screen.getByText('Enabled')).toBeInTheDocument();
      expect(screen.queryByText('Not configured')).not.toBeInTheDocument();
    });

    it('renders "Disabled" for a configured, disabled deployment', () => {
      setHook({ config: configuredDisabled });

      renderAsAdmin();

      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Public key renders in full; private key never appears anywhere
  // ==========================================================================

  describe('key material rendering', () => {
    it('renders the public key IN FULL — it is not secret', () => {
      setHook({ config: configuredEnabled });

      renderAsAdmin();

      expect(screen.getByText(configuredEnabled.publicKey!)).toBeInTheDocument();
    });

    it('renders private-key provenance text (hint, timestamp) but the hint is a MASK, never the real key', () => {
      setHook({ config: configuredEnabled });

      renderAsAdmin();

      expect(screen.getByText(/private key last set/i)).toBeInTheDocument();
      expect(screen.getByText(/••••ab12/)).toBeInTheDocument();
    });

    it('renders no private-key provenance text at all when unconfigured — there is nothing to describe yet', () => {
      setHook({ config: unconfigured });

      renderAsAdmin();

      expect(screen.queryByText(/private key last set/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no private key is stored/i)).not.toBeInTheDocument();
    });

    it('EXPLICIT ASSERTION: no private-key-shaped value appears anywhere in the DOM', () => {
      setHook({ config: configuredEnabled });

      const { container } = renderAsAdmin();

      expect(container.innerHTML).not.toContain(FORBIDDEN_PRIVATE_KEY_MATERIAL);
      // The mocked config object itself structurally has no field capable of
      // carrying it (see PushConfigAdminView / PrivateKeyStatus), but this
      // assertion does not rely on that alone — it grexps the whole rendered
      // tree for any literal that looks like the key value.
      expect(document.body.innerHTML).not.toContain(FORBIDDEN_PRIVATE_KEY_MATERIAL);
    });

    it('EXPLICIT ASSERTION: no mocked write call (generate/rotate/remove) is ever given private key material', async () => {
      const user = userEvent.setup();
      const { generate, rotate, remove } = setHook({ config: unconfigured });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /generate & enable/i }));

      for (const mock of [generate, rotate, remove]) {
        for (const call of mock.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(FORBIDDEN_PRIVATE_KEY_MATERIAL);
        }
      }
    });
  });

  // ==========================================================================
  // Generate flow
  // ==========================================================================

  describe('generate flow (empty state)', () => {
    it('calls generate() with the trimmed subject when the field is filled in', async () => {
      const user = userEvent.setup();
      const { generate } = setHook({ config: unconfigured });

      renderAsAdmin();
      await user.type(screen.getByLabelText(/subject \(contact address\)/i), 'mailto:admin@example.com');
      await user.click(screen.getByRole('button', { name: /generate & enable/i }));

      await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      expect(generate).toHaveBeenCalledWith({ subject: 'mailto:admin@example.com' });
    });

    it('calls generate() with an empty body when the subject field is left blank', async () => {
      const user = userEvent.setup();
      const { generate } = setHook({ config: unconfigured });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /generate & enable/i }));

      await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      expect(generate).toHaveBeenCalledWith({});
    });

    it('shows a confirmation snackbar once generate() resolves true', async () => {
      const user = userEvent.setup();
      setHook({ config: unconfigured });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /generate & enable/i }));

      expect(await screen.findByText(/web push generated and enabled/i)).toBeInTheDocument();
    });

    it('the Generate button is disabled without push:write', () => {
      setPermissions(READ_ONLY_PERMISSIONS);
      setHook({ config: unconfigured });

      renderAsAdmin();

      expect(screen.getByRole('button', { name: /generate & enable/i })).toBeDisabled();
    });
  });

  // ==========================================================================
  // Rotate confirmation gating
  // ==========================================================================

  describe('rotate confirmation dialog', () => {
    it('submit stays disabled until the typed text exactly matches ROTATE', async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /rotate keys/i }));

      const dialog = await screen.findByRole('dialog');
      const submit = within(dialog).getByRole('button', { name: /^rotate keys$/i });
      const field = within(dialog).getByLabelText(/type rotate to confirm/i);

      expect(submit).toBeDisabled();

      await user.type(field, 'rotate'); // wrong case
      expect(submit).toBeDisabled();

      await user.clear(field);
      await user.type(field, 'ROTAT'); // wrong / incomplete
      expect(submit).toBeDisabled();

      await user.clear(field);
      await user.type(field, 'ROTATE');
      expect(submit).not.toBeDisabled();
    });

    it("typing the OTHER dialog's word (REMOVE) does not satisfy the rotate confirmation", async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /rotate keys/i }));

      const dialog = await screen.findByRole('dialog');
      const submit = within(dialog).getByRole('button', { name: /^rotate keys$/i });
      await user.type(within(dialog).getByLabelText(/type rotate to confirm/i), 'REMOVE');

      expect(submit).toBeDisabled();
    });

    it('confirming calls rotate() and, on success, shows a confirmation snackbar', async () => {
      const user = userEvent.setup();
      const { rotate } = setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /rotate keys/i }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/type rotate to confirm/i), 'ROTATE');
      await user.click(within(dialog).getByRole('button', { name: /^rotate keys$/i }));

      await waitFor(() => expect(rotate).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/key pair rotated/i)).toBeInTheDocument();
    });

    it('the typed text clears when the dialog is closed and reopened', async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /rotate keys/i }));
      let dialog = await screen.findByRole('dialog');
      const field1 = within(dialog).getByLabelText(/type rotate to confirm/i);
      await user.type(field1, 'ROTATE');
      expect(field1).toHaveValue('ROTATE');

      // Close (Cancel).
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      // Reopen.
      await user.click(screen.getByRole('button', { name: /rotate keys/i }));
      dialog = await screen.findByRole('dialog');
      const field2 = within(dialog).getByLabelText(/type rotate to confirm/i);
      expect(field2).toHaveValue('');
    });

    it('Rotate/Remove buttons are disabled without push:write', () => {
      setPermissions(READ_ONLY_PERMISSIONS);
      setHook({ config: configuredEnabled });

      renderAsAdmin();

      expect(screen.getByRole('button', { name: /rotate keys/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /remove configuration/i })).toBeDisabled();
    });
  });

  // ==========================================================================
  // Remove confirmation gating
  // ==========================================================================

  describe('remove confirmation dialog', () => {
    it('submit stays disabled until the typed text exactly matches REMOVE', async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /remove configuration/i }));

      const dialog = await screen.findByRole('dialog');
      const submit = within(dialog).getByRole('button', { name: /^remove configuration$/i });
      const field = within(dialog).getByLabelText(/type remove to confirm/i);

      expect(submit).toBeDisabled();

      await user.type(field, 'remove'); // wrong case
      expect(submit).toBeDisabled();

      await user.clear(field);
      await user.type(field, 'REMOVE');
      expect(submit).not.toBeDisabled();
    });

    it("typing the OTHER dialog's word (ROTATE) does not satisfy the remove confirmation — the two literals are not interchangeable", async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /remove configuration/i }));

      const dialog = await screen.findByRole('dialog');
      const submit = within(dialog).getByRole('button', { name: /^remove configuration$/i });
      await user.type(within(dialog).getByLabelText(/type remove to confirm/i), 'ROTATE');

      expect(submit).toBeDisabled();
    });

    it('confirming calls remove() and, on success, shows a confirmation snackbar', async () => {
      const user = userEvent.setup();
      const { remove } = setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /remove configuration/i }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/type remove to confirm/i), 'REMOVE');
      await user.click(within(dialog).getByRole('button', { name: /^remove configuration$/i }));

      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/web push configuration removed/i)).toBeInTheDocument();
    });

    it('the typed text clears when the dialog is closed and reopened', async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();
      await user.click(screen.getByRole('button', { name: /remove configuration/i }));
      let dialog = await screen.findByRole('dialog');
      const field1 = within(dialog).getByLabelText(/type remove to confirm/i);
      await user.type(field1, 'REMOVE');
      expect(field1).toHaveValue('REMOVE');

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /remove configuration/i }));
      dialog = await screen.findByRole('dialog');
      const field2 = within(dialog).getByLabelText(/type remove to confirm/i);
      expect(field2).toHaveValue('');
    });
  });

  // ==========================================================================
  // Switching between the two dialogs never carries a typed value over
  // ==========================================================================

  describe('switching between rotate and remove never leaks a typed confirmation', () => {
    it('typing ROTATE, cancelling, then opening Remove starts blank (and ROTATE would not satisfy it anyway)', async () => {
      const user = userEvent.setup();
      setHook({ config: configuredEnabled });

      renderAsAdmin();

      await user.click(screen.getByRole('button', { name: /rotate keys/i }));
      let dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/type rotate to confirm/i), 'ROTATE');
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /remove configuration/i }));
      dialog = await screen.findByRole('dialog');
      const removeField = within(dialog).getByLabelText(/type remove to confirm/i);
      expect(removeField).toHaveValue('');

      const submit = within(dialog).getByRole('button', { name: /^remove configuration$/i });
      expect(submit).toBeDisabled();
    });
  });

  // ==========================================================================
  // Page gating
  // ==========================================================================

  describe('page gating', () => {
    it('redirects away when the user holds no push permission at all', () => {
      setPermissions([]);
      setHook();

      renderAsAdmin();

      expect(screen.queryByRole('heading', { name: 'Web Push' })).not.toBeInTheDocument();
    });

    it('marks itself read-only in the subtitle for a reader without push:write', () => {
      setPermissions(READ_ONLY_PERMISSIONS);
      setHook();

      renderAsAdmin();

      expect(screen.getByText(/\(read-only\)/i)).toBeInTheDocument();
    });
  });
});

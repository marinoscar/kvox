/**
 * The login route (issue #465): the packaged `LoginPage` with KVox's mark in its
 * `Logo` slot.
 *
 * The page's flow (provider buttons, the session-expired notice, the redirect
 * once signed in) is proved by `@marinoscar/platform-web`'s suite. What is
 * KVox's, and asserted here, is the slot binding: the brand mark is drawn, it
 * sits above the heading, it is decorative, and the packaged page around it
 * still works (heading, provider button, the empty-providers message, the
 * loading state). These are the still-relevant assertions of the old
 * `LoginPage.test.tsx`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '../utils/test-utils';
import LoginPage from '../../identity/LoginPage';

describe('LoginPage (identity/LoginPage.tsx)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  describe('Logo slot', () => {
    it('draws the KVox brand mark', async () => {
      render(<LoginPage />, { wrapperOptions: { authenticated: false } });

      const logo = await screen.findByTestId('login-logo');
      const mark = logo.querySelector('img');
      expect(mark).not.toBeNull();
      expect(mark).toHaveAttribute('src', '/favicon.svg');
      expect(mark).toHaveAttribute('width', '56');
    });

    it('keeps the mark decorative: hidden from assistive technology, no alt text', async () => {
      render(<LoginPage />, { wrapperOptions: { authenticated: false } });

      const mark = (await screen.findByTestId('login-logo')).querySelector('img');
      expect(mark).toHaveAttribute('aria-hidden', 'true');
      expect(mark).toHaveAttribute('alt', '');
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('puts the mark above the heading', async () => {
      render(<LoginPage />, { wrapperOptions: { authenticated: false } });

      const logo = await screen.findByTestId('login-logo');
      const heading = screen.getByRole('heading', { level: 1, name: /welcome/i });
      // `compareDocumentPosition` bit 4: the heading FOLLOWS the logo.
      expect(logo.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('the packaged page around it', () => {
    it('renders the heading and the sign-in message', async () => {
      render(<LoginPage />, { wrapperOptions: { authenticated: false } });

      expect(await screen.findByRole('heading', { name: /welcome/i })).toBeInTheDocument();
      expect(screen.getByText(/sign in to continue/i)).toBeInTheDocument();
    });

    it('offers a button for each provider the API lists', async () => {
      render(<LoginPage />, {
        wrapperOptions: {
          authenticated: false,
          providers: [{ name: 'google', authUrl: '/api/auth/google' }],
        },
      });

      expect(await screen.findByRole('button', { name: /google/i })).toBeInTheDocument();
    });

    it('says so when no provider is configured', async () => {
      render(<LoginPage />, { wrapperOptions: { authenticated: false, providers: [] } });

      await waitFor(() =>
        expect(screen.getByText(/no authentication providers configured/i)).toBeInTheDocument(),
      );
    });

    it('shows a spinner, and no logo yet, while the session probe runs', () => {
      render(<LoginPage />, { wrapperOptions: { authenticated: false, isLoading: true } });

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByTestId('login-logo')).not.toBeInTheDocument();
    });
  });
});

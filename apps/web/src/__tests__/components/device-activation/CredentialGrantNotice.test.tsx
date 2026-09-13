/**
 * Component tests — `CredentialGrantNotice` (issue #141).
 *
 * The banner above Approve/Deny is the only thing on `/activate` that names
 * WHICH credential is about to be minted. Before #141 there was one banner for
 * both cases; now `session` keeps it verbatim and `pat` must be visibly
 * different — different severity, an explicit lifetime, the "survives
 * sign-out" fact, and a link to where the resulting token can be revoked.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils/test-utils';
import { CredentialGrantNotice } from '../../../components/device-activation/CredentialGrantNotice';
import { DEVICE_PAT_APPROX_DAYS } from '../../../components/device-activation/credential';

describe('CredentialGrantNotice', () => {
  describe('session', () => {
    it('renders the ordinary informational banner', () => {
      render(<CredentialGrantNotice kind="session" />);

      expect(
        screen.getByText(/a device is requesting access to your account/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/review the details below and choose whether to approve or deny/i),
      ).toBeInTheDocument();
    });

    it('does not mention a long-lived token, revocation, or surviving sign-out', () => {
      render(<CredentialGrantNotice kind="session" />);

      expect(screen.queryByText(/personal access token/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/long-lived/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/revoke/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/signed out/i)).not.toBeInTheDocument();
    });

    it('does not render a link to the tokens page', () => {
      render(<CredentialGrantNotice kind="session" />);

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    });
  });

  describe('pat', () => {
    it('renders a visibly distinct warning banner', () => {
      render(<CredentialGrantNotice kind="pat" />);

      expect(
        screen.getByText(/this device is asking for a long-lived access token/i),
      ).toBeInTheDocument();
    });

    it('states the approximate lifetime', () => {
      render(<CredentialGrantNotice kind="pat" />);

      expect(
        screen.getByText(new RegExp(`about ${DEVICE_PAT_APPROX_DAYS} days`, 'i')),
      ).toBeInTheDocument();
    });

    it('says the credential survives sign-out', () => {
      render(<CredentialGrantNotice kind="pat" />);

      expect(
        screen.getByText(/keeps working while you are signed out/i),
      ).toBeInTheDocument();
    });

    it('says it is not a browser session but a personal access token', () => {
      render(<CredentialGrantNotice kind="pat" />);

      // The sentence is split across a <strong> for "not", so match on the
      // full text of the containing paragraph rather than a single text node.
      const paragraph = screen.getByText((_content, element) =>
        /approving does\s*not\s*create a browser session/i.test(
          element?.textContent ?? '',
        ) && element?.tagName.toLowerCase() === 'p',
      );
      expect(paragraph).toBeInTheDocument();
      expect(screen.getByText(/personal access token/i)).toBeInTheDocument();
    });

    it('links to where the token can be revoked', () => {
      render(<CredentialGrantNotice kind="pat" />);

      const link = screen.getByRole('link', { name: /settings.*access tokens/i });
      expect(link).toHaveAttribute('href', '/settings/tokens');
    });

    it('opens the revoke link in a new tab safely (noopener/noreferrer)', () => {
      render(<CredentialGrantNotice kind="pat" />);

      const link = screen.getByRole('link', { name: /settings.*access tokens/i });
      expect(link).toHaveAttribute('target', '_blank');
      const rel = link.getAttribute('rel') ?? '';
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    });

    it('does not render the session-only wording', () => {
      render(<CredentialGrantNotice kind="pat" />);

      expect(
        screen.queryByText(/review the details below and choose whether to approve or deny/i),
      ).not.toBeInTheDocument();
    });
  });
});

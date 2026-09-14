/**
 * Settings → AI Provider (`/settings/ai`).
 *
 * Issue #55, epic #45. A card in `config/userSettingsSections.tsx`'s `Account`
 * group and a route in `App.tsx` — a registry destination, never a free route
 * (CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1), which is also what
 * gives this page its AppBar drill-down title and its position in the hub for
 * free.
 *
 * =============================================================================
 * THIS PAGE ANSWERS THREE QUESTIONS WITHOUT BEING ASKED
 * =============================================================================
 *
 * Pasting an API key into somebody else's application is an unusual thing to be
 * asked to do, and it is the FIRST thing epic #45 asks of a user: every AI
 * surface is unreachable until it is done. A bare "API key" box with a Save
 * button answers none of the three questions a reasonable person has, so the
 * page is laid out as those three answers, in the order they occur:
 *
 *   1. WHAT IS THIS FOR, AND WHOSE ACCOUNT PAYS — stated at the top, in the
 *      page's own voice, not in helper text under a field. It is the single
 *      most important fact here and the one most likely to be misread.
 *   2. WHERE DO I GET ONE — a real link to the provider's own key page, beside
 *      the field, so the answer is not "search the web for it".
 *   3. WHAT HAPPENS TO IT, AND WHAT LEAVES THIS DEPLOYMENT WHEN I USE IT —
 *      where the key is held, that it is never shown again, and exactly which
 *      third party receives the text of a note when one is generated.
 *
 * =============================================================================
 * THE KEY IS WRITE-ONLY, AND THE FORM IS BUILT AROUND THAT
 * =============================================================================
 *
 * `GET /api/ai-credentials` returns a MASK (`••••a1b2`), never the key, and no
 * endpoint in this application can read one back. So:
 *
 *   • What is stored is DESCRIBED, not shown — the mask, when it was saved,
 *     when it was last used.
 *   • The password field only appears when nothing is stored, or once
 *     "Replace key" is pressed — so a user reading this page is never shown an
 *     empty secret-looking box they might feel obliged to fill in.
 *   • Saving with the box untouched preserves the stored key (the API's blank-
 *     preserves contract). Erasing is the separate, confirmed "Remove" control,
 *     which is the only path that destroys one.
 *   • ⚠ THE RAW KEY IS NEVER RENDERED ANYWHERE. It lives in one piece of
 *     component state, reaches exactly two requests, and is cleared on every
 *     server response. `UserAiPage.test.tsx` asserts that against the DOM.
 *
 * =============================================================================
 * TEST TESTS WHAT IS TYPED, NOT WHAT IS SAVED — AND A REFUSAL IS AN ANSWER
 * =============================================================================
 *
 * `POST /api/ai-credentials/test` accepts an UNSAVED key, which is the whole
 * point: a user proves a key before committing it. And it answers **200** with
 * `{ ok: false, detail }` when the provider refuses — a refused probe is a
 * successful DIAGNOSIS, so it is rendered as the provider's own explanation in
 * an alert, never thrown, never flattened into a generic failure toast. Which
 * of "the key is wrong", "the account is out of credit" and "the endpoint is
 * unreachable" happened is the entire value of the control.
 *
 * =============================================================================
 * NO PERMISSION IS CHECKED HERE, DELIBERATELY
 * =============================================================================
 *
 * `ai-credentials.controller.ts` gates all four routes on `@Auth()` and no
 * permission: the resource is the caller's OWN credential, scoped by `userId`
 * in the query itself. Like every other card in `USER_SETTINGS_SECTIONS`, this
 * one declares no `permission` — inventing one here would be an authorization
 * rule the API does not enforce, and would leave a user unable to REMOVE their
 * own key from a deployment that had since revoked their access to the feature
 * it was for.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Link,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import { useAiConfig } from '../hooks/useAiConfig';
import { useAiCredential } from '../hooks/useAiCredential';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import type { AiCredentialStatus } from '../services/ai';

/**
 * Where a key is obtained, per provider.
 *
 * ⚠ IT LIVES ON THIS SIDE BECAUSE THE API DOES NOT PUBLISH IT. `GET
 * /api/ai-settings`'s provider catalogue carries an id, a label, models and
 * form-field descriptors — no console URL — so there is nothing to read it from
 * and inventing a field on the wire to carry a static vendor link would be the
 * larger change. A provider absent from this map simply renders no link rather
 * than a guessed one: a wrong link to somewhere that asks for credentials is
 * worse than no link at all.
 */
export const PROVIDER_KEY_CONSOLE_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
};

/** What to say about a stored key. Never the key — only what is safe to say about it. */
function describeStoredKey(status: AiCredentialStatus | null): string {
  if (!status?.configured) {
    return 'No API key is stored for your account.';
  }
  const which = status.hint ? ` ending ${status.hint}` : '';
  const when = status.updatedAt
    ? ` on ${new Date(status.updatedAt).toLocaleString()}`
    : '';
  const used = status.lastUsedAt
    ? ` Last used ${new Date(status.lastUsedAt).toLocaleString()}.`
    : ' It has not been used yet.';
  return `Your key${which} was saved${when}.${used}`;
}

export default function UserAiPage() {
  const {
    config,
    isLoading: isConfigLoading,
    loadError: configError,
    refresh: refreshConfig,
  } = useAiConfig();
  const {
    statusFor,
    isLoading: isCredentialLoading,
    loadError: credentialError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isTesting,
    testResult,
    test,
    clearTestResult,
    isRemoving,
    removeError,
    remove,
    clearRemoveError,
  } = useAiCredential();

  // The one piece of state that ever holds key material. It starts empty, is
  // never seeded from anything, and is cleared whenever the server answers.
  const [apiKey, setApiKey] = useState('');
  const [isReplacing, setIsReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const provider = config?.provider ?? null;
  const providerLabel = config?.providerLabel ?? null;
  const status = statusFor(provider);
  const consoleUrl = provider ? PROVIDER_KEY_CONSOLE_URLS[provider] : undefined;

  // Reset the draft whenever the stored status changes — a key that has just
  // been saved must not linger in a form field, and a failed save must not
  // leave the box silently pre-filled on the next render.
  useEffect(() => {
    setApiKey('');
    setIsReplacing(false);
  }, [status?.updatedAt, status?.configured]);

  if (isConfigLoading || isCredentialLoading) {
    return <LoadingSpinner />;
  }

  const showKeyField = !status?.configured || isReplacing;
  const canSubmit = provider !== null && apiKey.trim().length > 0;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || provider === null) return;

    const ok = await save({ provider, apiKey });
    if (ok) {
      setApiKey('');
      setIsReplacing(false);
      setSavedMessage('Your API key was saved');
      // `keyConfigured` is the boolean every other AI surface gates on, and it
      // lives on a different endpoint — so it is re-read here rather than
      // inferred, or the user would save a key and still be told to add one.
      await refreshConfig();
    }
  };

  const handleTest = async () => {
    if (provider === null) return;
    await test({
      // The DRAFT key, which need NOT have been saved. Omitted when the box is
      // empty so the API falls back to the stored key — which is how "is the
      // key I saved last month still valid?" is asked.
      provider,
      apiKey: apiKey || undefined,
    });
  };

  const handleRemove = async () => {
    if (provider === null) return;
    setConfirmRemove(false);
    const ok = await remove(provider);
    if (ok) {
      setApiKey('');
      setIsReplacing(false);
      setSavedMessage('Your API key was removed');
      await refreshConfig();
    }
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `AI Provider` card in
            `config/userSettingsSections.tsx`, so the hub card, the compact
            AppBar title and this `h1` all name the page identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          AI Provider
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Connect your own AI provider key. AI features run on your account, and the usage
          is billed to you.
        </Typography>

        {/* ==================================================================
            1. WHAT THIS IS FOR, AND WHOSE ACCOUNT PAYS.
            Not helper text under a field — the first thing on the page, in
            its own right, because it is the fact most likely to be misread.
            ================================================================= */}
        <Alert severity="info" icon={<KeyOutlinedIcon />} sx={{ mb: 3 }}>
          <AlertTitle>This is your own account, and your own spend</AlertTitle>
          This application has no AI key of its own and never falls back to one. Everything
          you generate here is requested with the key you save below, on your provider
          account, and charged to you at your provider&apos;s rates. Nobody else&apos;s work
          is ever billed to your key, and yours is never billed to anybody else&apos;s.
        </Alert>

        {configError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {configError}
          </Alert>
        )}
        {credentialError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {credentialError}
          </Alert>
        )}

        {provider === null && !configError && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            <AlertTitle>AI is not set up on this deployment yet</AlertTitle>
            An administrator has not chosen an AI provider, so there is nothing to add a key
            for right now. Your key is not the missing piece — nothing you do on this page
            would make AI features work until that is done.
          </Alert>
        )}

        {/* ==================================================================
            2. THE KEY ITSELF — status, where to get one, save, test, remove.
            ================================================================= */}
        <Paper sx={{ p: { xs: 2, sm: 3 } }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
              {providerLabel ? `${providerLabel} API key` : 'API key'}
            </Typography>
            <Chip
              label={status?.configured ? 'Key saved' : 'No key'}
              color={status?.configured ? 'success' : 'default'}
              size="small"
            />
          </Stack>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {describeStoredKey(status)}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Your key is held encrypted and is <strong>never shown again</strong> — not to
            you, not to an administrator, not by any part of this application. Only the last
            few characters are kept readable, so you can tell which key is in place.
          </Typography>

          {consoleUrl && (
            <Typography variant="body2" sx={{ mb: 2 }}>
              <Link
                href={consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
              >
                Get a key from {providerLabel ?? 'your provider'}
                <OpenInNewIcon fontSize="inherit" />
              </Link>
            </Typography>
          )}

          <Box component="form" onSubmit={handleSave} noValidate>
            {showKeyField && (
              <TextField
                fullWidth
                type="password"
                label="API key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={provider === null}
                autoComplete="off"
                helperText={
                  status?.configured
                    ? 'Leave this empty to keep the key you already saved.'
                    : 'Paste the key from your provider account. You can test it before saving.'
                }
                sx={{ mb: 2 }}
              />
            )}

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              sx={{ mb: 2 }}
            >
              {showKeyField && (
                <Button type="submit" variant="contained" disabled={!canSubmit || isSaving}>
                  {isSaving ? 'Saving…' : 'Save key'}
                </Button>
              )}
              {status?.configured && !isReplacing && (
                <Button
                  variant="outlined"
                  onClick={() => setIsReplacing(true)}
                  disabled={provider === null}
                >
                  Replace key
                </Button>
              )}
              <Button
                variant="outlined"
                onClick={() => void handleTest()}
                disabled={provider === null || isTesting}
              >
                {isTesting ? 'Testing…' : 'Test key'}
              </Button>
              {status?.configured && (
                <Button
                  variant="outlined"
                  color="error"
                  onClick={() => setConfirmRemove(true)}
                  disabled={isRemoving}
                >
                  {isRemoving ? 'Removing…' : 'Remove key'}
                </Button>
              )}
            </Stack>
          </Box>

          <Typography variant="caption" color="text.secondary" component="p">
            Testing does not save anything. A key typed above is sent once, checked, and
            dropped — so you can prove a key works before you commit it.
          </Typography>

          {saveError && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={clearSaveError}>
              <AlertTitle>Could not save your key</AlertTitle>
              {saveError}
            </Alert>
          )}
          {removeError && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={clearRemoveError}>
              <AlertTitle>Could not remove your key</AlertTitle>
              {removeError}
            </Alert>
          )}

          {/* ⚠ A REFUSED PROBE IS A DIAGNOSIS, NOT AN ERROR. The endpoint
              answers 200 with `{ ok: false, detail }`, and `detail` is the
              provider's own explanation — which of "the key is wrong", "the
              account is out of credit" and "the endpoint is unreachable"
              happened. It is rendered here, in full, rather than flattened
              into a generic failure. */}
          {testResult && (
            <Alert
              severity={testResult.ok ? 'success' : 'warning'}
              sx={{ mt: 2 }}
              onClose={clearTestResult}
            >
              <AlertTitle>
                {testResult.ok
                  ? `Your key works (checked in ${testResult.latencyMs} ms)`
                  : 'Your provider did not accept this key'}
              </AlertTitle>
              {testResult.detail}
            </Alert>
          )}
        </Paper>

        {/* ==================================================================
            3. WHAT LEAVES THIS DEPLOYMENT, AND WHO RECEIVES IT.
            Named explicitly, and named the provider — "a third party" is not
            a disclosure, it is an evasion.
            ================================================================= */}
        <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
          <Typography variant="h6" component="h2" gutterBottom>
            What is sent, and to whom
          </Typography>
          <Divider sx={{ mb: 2 }} />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            When you generate a note, the text this application assembles for it — the
            transcript text you selected, the instructions of the template you chose, and
            any source document you attached — is sent to{' '}
            <strong>{providerLabel ?? 'the configured AI provider'}</strong> using your key,
            over the internet, and the generated note comes back the same way.
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Your <strong>audio is never sent</strong> to the AI provider. Neither is
            anything from another user&apos;s account. What your provider does with the text
            afterwards — how long it retains it, whether it is used for training — is
            governed by your agreement with them, not by this application.
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Removing your key stops all of it immediately: without a key this application
            has no way to reach any AI provider on your behalf.
          </Typography>
        </Paper>

        {/* Removal is destructive and irreversible from here — the key cannot
            be read back to restore it — so it is confirmed rather than fired
            from a single click. */}
        <Dialog
          open={confirmRemove}
          onClose={() => setConfirmRemove(false)}
          aria-labelledby="remove-ai-key-title"
        >
          <DialogTitle id="remove-ai-key-title">Remove your API key?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              AI features will stop working for your account until you add a key again. This
              application cannot show you the key it is holding, so you will need the
              original from your provider — or a new one — to undo this.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button color="error" variant="contained" onClick={() => void handleRemove()}>
              Remove key
            </Button>
          </DialogActions>
        </Dialog>

        <Snackbar
          open={!!savedMessage}
          autoHideDuration={3000}
          onClose={() => setSavedMessage(null)}
          message={savedMessage}
        />
      </Box>
    </Container>
  );
}

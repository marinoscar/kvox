/**
 * Admin → Settings → AI (`/admin/settings/ai`).
 *
 * Issue #55, epic #45. A STANDALONE PAGE, exactly like
 * `TranscriptionSettingsPage` and `EmailSettingsPage` and for the same reason:
 * this hits its own controller (`/api/ai-settings`) with its own document, not
 * the generic `system_settings` blob. One entry in `ADMIN_SECTIONS`
 * (`config/adminSections.tsx`), one route in `App.tsx` gated on the same
 * `system_settings:read` string `ai-settings.controller.ts` enforces on its
 * GET, no tab anywhere — CLAUDE.md's "MANDATORY: Settings UI Pattern" rules 1,
 * 2 and 3.
 *
 * =============================================================================
 * ⚠ THERE IS NO API KEY FIELD ON THIS PAGE, AND THAT IS THE DESIGN
 * =============================================================================
 *
 * This is the one thing about this page a reader must not have to infer, so the
 * page SAYS IT, in a first-class notice rather than a footnote. Epic #45 has no
 * deployment-wide AI key: every key belongs to an individual user, is stored
 * through `PUT /api/ai-credentials` and is billed to that user's own provider
 * account. `ai-settings.schema.ts` carries a compile-time proof that no
 * secret-bearing field can appear in this settings document at all.
 *
 * An administrator who was not told this would reasonably go looking for the
 * key field, conclude the page is broken or half-built, and open a ticket. The
 * notice exists to end that search in one sentence — and to make clear that the
 * absence is a decision, not an omission: there is nothing to configure here
 * because there is no shared credential to configure, by design.
 *
 * =============================================================================
 * WHAT IS HERE INSTEAD: POLICY, WHICH IS THE DEPLOYMENT'S ONLY LEVER
 * =============================================================================
 *
 * Since the key and the bill are each user's own, the only things a deployment
 * controls are: whether AI runs at all, which API root it is called at, which
 * models are permitted, which is offered first, how many tokens one request may
 * spend, how long one request may take, and how large an attached source
 * document may be. That is exactly the field set below, and every one of them
 * is a ceiling on somebody else's money — which is why they are worth an
 * administrator's attention even though no credential is.
 *
 * `allowedModels` REPLACES WHOLESALE on save, matching the API's RFC 7396 array
 * rule: a merging list could never express "stop permitting this model", so
 * removing one from the box would silently be a no-op.
 *
 * Mobile-first like its siblings — every row stacks at `xs` and goes horizontal
 * at `sm`, and nothing here mounts, unmounts or re-gates on a breakpoint, so
 * Settings UI Pattern rule 5's five coupled gates are untouched by construction.
 */

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Chip,
  Button,
  Container,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Snackbar,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import KeyOffOutlinedIcon from '@mui/icons-material/KeyOffOutlined';
import { Navigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';
import { useAiSettings } from '../../hooks/useAiSettings';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import type { UpdateAiSettingsInput } from '../../services/ai';

/** One model id per line — the shape an administrator can paste into and read back. */
function parseModelList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Bounds mirrored from `ai-settings.schema.ts`, so a 400 is prevented rather than reported. */
const BOUNDS = {
  maxInputTokens: { min: 256, max: 2_000_000 },
  maxOutputTokens: { min: 64, max: 200_000 },
  requestTimeoutMs: { min: 1_000, max: 3_600_000 },
  maxDocumentBytes: { min: 65_536, max: 268_435_456 },
} as const;

function numericError(
  raw: string,
  bound: { min: number; max: number },
  unit: string,
): string | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < bound.min || parsed > bound.max) {
    return `Must be a whole number between ${bound.min.toLocaleString()} and ${bound.max.toLocaleString()} ${unit}.`;
  }
  return null;
}

export default function AiSettingsPage() {
  const { hasPermission } = usePermissions();
  const {
    data,
    isLoading,
    loadError,
    isSaving,
    saveError,
    save,
    clearSaveError,
    isTesting,
    testResult,
    testReachability,
    clearTestResult,
  } = useAiSettings();

  // Draft state, seeded from the server's response after every load AND every
  // write — the response is the new baseline, which is how the form resyncs
  // after a save without a reload.
  const [enabled, setEnabled] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [allowedModels, setAllowedModels] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [maxInputTokens, setMaxInputTokens] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [requestTimeoutMs, setRequestTimeoutMs] = useState('');
  const [maxDocumentBytes, setMaxDocumentBytes] = useState('');

  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setEnabled(s.enabled);
    setBaseUrl(s.providers.openai.baseUrl);
    setAllowedModels(s.providers.openai.allowedModels.join('\n'));
    setDefaultModel(s.providers.openai.defaultModel);
    setMaxInputTokens(String(s.maxInputTokens));
    setMaxOutputTokens(String(s.maxOutputTokens));
    setRequestTimeoutMs(String(s.requestTimeoutMs));
    setMaxDocumentBytes(String(s.maxDocumentBytes));
  }, [data]);

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string. This one catches the page mounted from anywhere
  // else. It sits after every hook so the hook order never changes.
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  const canWrite = hasPermission('system_settings:write');

  if (isLoading || !data) {
    if (loadError) {
      return (
        <Container maxWidth="lg">
          <Box sx={{ py: 4 }}>
            <Typography variant="h4" component="h1" gutterBottom>
              AI
            </Typography>
            <Alert severity="error">{loadError}</Alert>
          </Box>
        </Container>
      );
    }
    return <LoadingSpinner />;
  }

  const models = parseModelList(allowedModels);
  const catalogue = data.providers.find((entry) => entry.id === 'openai');
  const inputError = numericError(maxInputTokens, BOUNDS.maxInputTokens, 'tokens');
  const outputError = numericError(maxOutputTokens, BOUNDS.maxOutputTokens, 'tokens');
  const timeoutError = numericError(
    requestTimeoutMs,
    BOUNDS.requestTimeoutMs,
    'milliseconds',
  );
  const documentError = numericError(
    maxDocumentBytes,
    BOUNDS.maxDocumentBytes,
    'bytes',
  );
  const defaultModelError =
    defaultModel.trim().length === 0
      ? 'Choose which permitted model is offered first.'
      : !models.includes(defaultModel.trim())
        ? 'This model is not in the permitted list, so nothing would be able to select it.'
        : null;
  const hasError =
    !!inputError ||
    !!outputError ||
    !!timeoutError ||
    !!documentError ||
    !!defaultModelError;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || hasError) return;

    const input: UpdateAiSettingsInput = {
      enabled,
      providers: {
        openai: {
          baseUrl: baseUrl.trim(),
          // Wholesale replacement — see the file header.
          allowedModels: models,
          defaultModel: defaultModel.trim(),
        },
      },
      maxInputTokens: Number.parseInt(maxInputTokens, 10),
      maxOutputTokens: Number.parseInt(maxOutputTokens, 10),
      requestTimeoutMs: Number.parseInt(requestTimeoutMs, 10),
      maxDocumentBytes: Number.parseInt(maxDocumentBytes, 10),
    };

    const ok = await save(input);
    if (ok) setSavedMessage('AI settings saved');
  };

  // The DRAFT base URL, which need not have been saved — the same "test what
  // you typed, not what you committed" workflow the transcription page offers.
  // No credential travels with it, because there is none to send.
  const handleTest = async () => {
    await testReachability({ baseUrl: baseUrl.trim() || undefined });
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `AI` card in
            `config/adminSections.tsx`, as every sibling admin page does. */}
        <Typography variant="h4" component="h1" gutterBottom>
          AI
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Choose which AI models this deployment permits, and the token, timeout and
          document ceilings every generation runs under.
          {!canWrite && ' (read-only)'}
        </Typography>

        {/* ==================================================================
            ⚠ WHY THERE IS NO KEY FIELD. First-class, at the top, because an
            administrator not told this would go looking for one. See the
            file header.
            ================================================================= */}
        <Alert severity="info" icon={<KeyOffOutlinedIcon />} sx={{ mb: 3 }}>
          <AlertTitle>There is no API key on this page, by design</AlertTitle>
          This deployment holds no AI key of its own and has no shared credential to fall
          back on. Every user supplies their own key under their own{' '}
          <strong>Settings → AI Provider</strong>, and their AI usage is billed to their own
          provider account. The settings below are policy only — they bound what any user&apos;s
          key may be spent on here, which is this deployment&apos;s only lever over AI cost and
          over which vendor models its content reaches.
        </Alert>

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        {/* Model ids the policy permits that no registered provider declares —
            reported rather than silently dropped, because such a model can
            never be offered and an administrator who mistyped one would
            otherwise have nothing to explain why it vanished. */}
        {data.unknownModels.length > 0 && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            <AlertTitle>Some permitted models are not recognised</AlertTitle>
            {data.unknownModels.join(', ')} — this build cannot budget requests for these,
            so they are never offered to a user. Check the spelling, or remove them.
          </Alert>
        )}

        <Box component="form" onSubmit={handleSave} noValidate>
          {/* ================================================================
              PROVIDER — the switch and the API root.
              ============================================================= */}
          <Paper sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
              <AutoAwesomeOutlinedIcon color="action" />
              <Typography variant="h6" component="h2" sx={{ flexGrow: 1 }}>
                Provider
              </Typography>
              <Chip
                label={enabled ? 'Enabled' : 'Disabled'}
                color={enabled ? 'success' : 'default'}
                size="small"
              />
            </Stack>

            <FormControlLabel
              control={
                <Switch
                  checked={enabled}
                  onChange={(event) => setEnabled(event.target.checked)}
                  disabled={!canWrite}
                  slotProps={{ input: { 'aria-label': 'Enable AI features' } }}
                />
              }
              label="Enable AI features for this deployment"
            />
            {!enabled && (
              <Alert severity="info" sx={{ mt: 1, mb: 1 }}>
                AI is switched off — no completion is requested from any provider, whatever
                keys users have saved. The policy below is kept, so switching this back on
                needs no retyping.
              </Alert>
            )}

            <Divider sx={{ my: 3 }} />

            <TextField
              fullWidth
              label="API base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              disabled={!canWrite}
              helperText="The OpenAI-compatible API root this deployment calls — a vendor endpoint, an enterprise gateway, or a self-hosted server."
              sx={{ mb: 2 }}
            />

            <Button
              variant="outlined"
              onClick={() => void handleTest()}
              disabled={!canWrite || isTesting}
            >
              {isTesting ? 'Testing…' : 'Test this URL'}
            </Button>

            {/* A 401 from the provider is a PASS: an unauthenticated request to
                a working API root is supposed to be refused, and that refusal
                proves the endpoint exists and speaks the protocol. The server
                makes that judgement; this only renders it. */}
            {testResult && (
              <Alert
                severity={testResult.ok ? 'success' : 'warning'}
                sx={{ mt: 2 }}
                onClose={clearTestResult}
              >
                <AlertTitle>
                  {testResult.ok
                    ? `The endpoint answered in ${testResult.latencyMs} ms`
                    : 'The endpoint did not answer as expected'}
                </AlertTitle>
                {testResult.detail}
              </Alert>
            )}
          </Paper>

          {/* ================================================================
              MODELS — the allow-list and the default.
              ============================================================= */}
          <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" component="h2" gutterBottom>
              Permitted models
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              An allow-list, not a catalogue. A model a user&apos;s own key could reach but
              this list does not name is refused here before any request is made.
              {catalogue && catalogue.capabilities.models.length > 0 && (
                <>
                  {' '}
                  This build can budget requests for:{' '}
                  {catalogue.capabilities.models.map((model) => model.id).join(', ')}.
                </>
              )}
            </Typography>

            <TextField
              fullWidth
              multiline
              minRows={3}
              label="Permitted models"
              value={allowedModels}
              onChange={(event) => setAllowedModels(event.target.value)}
              disabled={!canWrite}
              helperText="One model id per line. An empty list permits nothing, which closes AI by policy without losing the rest of this configuration."
              sx={{ mb: 3 }}
            />

            <TextField
              select={models.length > 0}
              fullWidth
              label="Default model"
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.target.value)}
              disabled={!canWrite}
              error={!!defaultModelError}
              helperText={defaultModelError ?? 'Which permitted model is offered first.'}
            >
              {/* The current value is always an option, even when it is not in
                  the permitted list: dropping it would silently rewrite the
                  stored default to whatever happened to be first, which is a
                  policy change nobody asked for. It stays selectable AND
                  flagged by `defaultModelError` above. */}
              {(models.includes(defaultModel.trim()) || defaultModel.trim() === ''
                ? models
                : [defaultModel, ...models]
              ).map((model) => (
                <MenuItem key={model} value={model}>
                  {model}
                </MenuItem>
              ))}
            </TextField>
          </Paper>

          {/* ================================================================
              CEILINGS — the deployment's bound on somebody else's spend.
              ============================================================= */}
          <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" component="h2" gutterBottom>
              Limits
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Every token here is spent on the requesting user&apos;s own provider account,
              so these ceilings are the deployment&apos;s way of bounding a surprise on
              somebody else&apos;s bill.
            </Typography>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3 }}>
              <TextField
                fullWidth
                type="number"
                label="Max input tokens"
                value={maxInputTokens}
                onChange={(event) => setMaxInputTokens(event.target.value)}
                disabled={!canWrite}
                error={!!inputError}
                helperText={
                  inputError ??
                  'Ceiling on the assembled prompt. Sits under the model’s own context window, never over it.'
                }
              />
              <TextField
                fullWidth
                type="number"
                label="Max output tokens"
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
                disabled={!canWrite}
                error={!!outputError}
                helperText={outputError ?? 'Ceiling on what one generation may produce.'}
              />
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                fullWidth
                type="number"
                label="Request timeout (ms)"
                value={requestTimeoutMs}
                onChange={(event) => setRequestTimeoutMs(event.target.value)}
                disabled={!canWrite}
                error={!!timeoutError}
                helperText={
                  timeoutError ??
                  'How long one provider request may take before it is abandoned. A streamed completion legitimately runs for minutes.'
                }
              />
              <TextField
                fullWidth
                type="number"
                label="Max document size (bytes)"
                value={maxDocumentBytes}
                onChange={(event) => setMaxDocumentBytes(event.target.value)}
                disabled={!canWrite}
                error={!!documentError}
                helperText={
                  documentError ??
                  'Ceiling on one uploaded source document. An AI policy, not a storage one: every byte becomes input tokens on the uploading user’s account.'
                }
              />
            </Stack>
          </Paper>

          {saveError && (
            <Alert severity="error" sx={{ mt: 3 }} onClose={clearSaveError}>
              <AlertTitle>Could not save</AlertTitle>
              {saveError}
            </Alert>
          )}

          <Box
            sx={{
              mt: 3,
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              alignItems: { xs: 'stretch', sm: 'center' },
              gap: 2,
            }}
          >
            <Button type="submit" variant="contained" disabled={!canWrite || isSaving || hasError}>
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
          </Box>
        </Box>

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

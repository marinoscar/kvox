/**
 * Admin → Settings → Transcription (`/admin/settings/transcription`).
 *
 * Issue #23, epic #19. A STANDALONE PAGE, exactly like `EmailSettingsPage.tsx`
 * and `PushConfigPage.tsx` and for the same reason: this hits its own
 * controller (`/api/transcription-settings`) with its own document, not the
 * generic `system_settings` blob `SettingsHub` pages share — see `CLAUDE.md`'s
 * "MANDATORY: Settings UI Pattern" §2 and `docs/specs/settings-ui.md`. One
 * entry in `ADMIN_SECTIONS` (`config/adminSections.tsx`), one route in
 * `App.tsx` gated on the same `system_settings:read` string, no tab anywhere.
 *
 * =============================================================================
 * THE API KEY IS WRITE-ONLY, AND THE FORM IS BUILT AROUND THAT
 * =============================================================================
 *
 * The key box renders EMPTY whatever is stored, because the value is
 * unreadable by design. So:
 *
 *   • What is stored is described, not shown — `keyStatuses[].hint` plus when
 *     and by whom, exactly as `PushConfigPage` renders `privateKeyStatus`.
 *   • The box only APPEARS once "Replace" is pressed (or when nothing is
 *     stored at all), so an administrator editing the playback bitrate is
 *     never presented with an empty password-looking field they might feel
 *     obliged to fill in.
 *   • Saving with the box untouched preserves the stored key. Erasing is the
 *     separate "Remove" control, which is the only path that destroys one.
 *
 * =============================================================================
 * TEST TESTS WHAT IS TYPED, NOT WHAT IS SAVED
 * =============================================================================
 *
 * The Test button sends the draft key and the draft region. That is the whole
 * point: an administrator pastes a key, presses Test, and learns whether it
 * works BEFORE committing it. A Test that could only probe the saved value
 * would turn every wrong key into a failed job discovered an hour later.
 *
 * =============================================================================
 * MOBILE-FIRST, AND IT CHANGES NONE OF THE FIVE COUPLED BREAKPOINT GATES
 * =============================================================================
 *
 * Every row here stacks at `xs` and goes horizontal at `sm`, and every `Paper`
 * takes `p: { xs: 2, sm: 3 }` — the same treatment `PushConfigPage` uses.
 * Nothing on this page mounts, unmounts or re-gates on a breakpoint, so
 * `CLAUDE.md` Settings UI Pattern rule 5's five gates are untouched by
 * construction.
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
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import { Navigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';
import { useTranscriptionSettings } from '../../hooks/useTranscriptionSettings';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import type {
  AssemblyAiRegion,
  ProviderKeyStatus,
  TranscriptionProviderId,
  UpdateTranscriptionSettingsInput,
} from '../../services/transcription';

/** What to say about a stored key. Mirrors `privateKeyProvenance` in `PushConfigPage`. */
function keyProvenance(status: ProviderKeyStatus | undefined): string {
  if (!status?.configured) return 'No API key is stored for this provider.';
  const which = status.hint ? ` (${status.hint})` : '';
  const when = status.updatedAt
    ? ` on ${new Date(status.updatedAt).toLocaleString()}`
    : '';
  const who = status.updatedByUserId ? ` by user ${status.updatedByUserId}` : '';
  return `API key last set${which}${when}${who}.`;
}

export default function TranscriptionSettingsPage() {
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
    testConnection,
    clearTestResult,
    isRemovingKey,
    removeKeyError,
    removeKey,
    clearRemoveKeyError,
  } = useTranscriptionSettings();

  // Draft state. Seeded from the server's response after every load AND every
  // write — the response is the new baseline, which is how the form resyncs
  // after a save without a reload. Mirrors `EmailSettingsPage`/`PushConfigPage`.
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<TranscriptionProviderId | ''>('');
  const [region, setRegion] = useState<AssemblyAiRegion>('us');
  const [speechModel, setSpeechModel] = useState('');
  const [deleteRemote, setDeleteRemote] = useState(true);
  const [defaultLanguage, setDefaultLanguage] = useState('');
  const [bitrateKbps, setBitrateKbps] = useState('64');
  const [nodeOffload, setNodeOffload] = useState(true);
  const [abandonedUploadHours, setAbandonedUploadHours] = useState('3');

  // The key box is separate from the draft above: it is write-only, it starts
  // empty every time, and `isReplacingKey` controls whether it is even shown.
  const [apiKey, setApiKey] = useState('');
  const [isReplacingKey, setIsReplacingKey] = useState(false);

  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setEnabled(s.enabled);
    setProvider(s.provider ?? '');
    setRegion(s.providers.assemblyai.region);
    setSpeechModel(s.providers.assemblyai.speechModel);
    setDeleteRemote(s.deleteRemoteAfterIngest);
    setDefaultLanguage(s.defaultLanguage ?? '');
    setBitrateKbps(String(s.playback.bitrateKbps));
    setNodeOffload(s.transcodeNodeOffloadEnabled);
    setAbandonedUploadHours(String(s.abandonedUploadHours));
    // The key draft is deliberately reset on every server response: a key that
    // has just been saved must not stay in a form field, and a failed save
    // should not leave the box silently pre-filled on the next render.
    setApiKey('');
    setIsReplacingKey(false);
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
              Transcription
            </Typography>
            <Alert severity="error">{loadError}</Alert>
          </Box>
        </Container>
      );
    }
    return <LoadingSpinner />;
  }

  const keyStatus = data.keyStatuses.find((entry) => entry.providerId === provider);
  const showKeyField = isReplacingKey || !keyStatus?.configured;
  const parsedBitrate = Number.parseInt(bitrateKbps, 10);
  const bitrateError =
    !Number.isInteger(parsedBitrate) || parsedBitrate < 16 || parsedBitrate > 320
      ? 'Must be a whole number between 16 and 320 kbit/s.'
      : null;
  // Same shape as the bitrate check, and the same bounds the API's schema
  // enforces (issue #322): whole hours, one hour to thirty days.
  const parsedAbandonedHours = Number(abandonedUploadHours);
  const abandonedHoursError =
    abandonedUploadHours.trim() === '' ||
    !Number.isInteger(parsedAbandonedHours) ||
    parsedAbandonedHours < 1 ||
    parsedAbandonedHours > 720
      ? 'Must be a whole number of hours between 1 and 720.'
      : null;
  const hasFieldError = !!bitrateError || !!abandonedHoursError;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || hasFieldError) return;

    const input: UpdateTranscriptionSettingsInput = {
      enabled,
      provider: provider === '' ? null : provider,
      providers: { assemblyai: { region, speechModel: speechModel.trim() } },
      deleteRemoteAfterIngest: deleteRemote,
      // `null`, not `''`: null is how "ask the provider to detect it" is
      // expressed, and an empty string is a language code nobody has.
      defaultLanguage: defaultLanguage.trim() || null,
      transcodeNodeOffloadEnabled: nodeOffload,
      abandonedUploadHours: parsedAbandonedHours,
      playback: { bitrateKbps: parsedBitrate },
    };

    // ⚠ `apiKey` IS OMITTED ENTIRELY WHEN THE BOX IS EMPTY, never sent as `''`.
    // Both mean "preserve" to the API, but omitting makes the intent visible in
    // the request itself rather than depending on a server-side equivalence.
    if (apiKey) input.apiKey = apiKey;

    const ok = await save(input);
    if (ok) setSavedMessage('Transcription settings saved');
  };

  const handleTest = async () => {
    if (provider === '') return;
    await testConnection({
      provider,
      region,
      // The DRAFT key, which need not have been saved. Omitted when the box is
      // empty, so the API falls back to the stored key — which is how "is what
      // I saved last month still valid?" is asked.
      apiKey: apiKey || undefined,
    });
  };

  const handleRemoveKey = async () => {
    if (provider === '') return;
    const ok = await removeKey(provider);
    if (ok) setSavedMessage('API key removed');
  };

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        {/* Title and description MIRROR the `Transcription` card in
            `config/adminSections.tsx`, exactly as the sibling admin pages do
            for theirs. */}
        <Typography variant="h4" component="h1" gutterBottom>
          Transcription
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          Choose the speech-to-text provider, hold its API key, and control what happens to
          audio once it has been transcribed.
          {!canWrite && ' (read-only)'}
        </Typography>

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {loadError}
          </Alert>
        )}

        <Box component="form" onSubmit={handleSave} noValidate>
          {/* ================================================================
              PROVIDER — the switch, the vendor, and its own fields.
              ============================================================= */}
          <Paper sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
              <RecordVoiceOverOutlinedIcon color="action" />
              <Typography variant="h6" sx={{ flexGrow: 1 }}>
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
                  onChange={(e) => setEnabled(e.target.checked)}
                  disabled={!canWrite}
                  slotProps={{ input: { 'aria-label': 'Enable transcription' } }}
                />
              }
              label="Enable transcription for this deployment"
            />
            {!enabled && (
              <Alert severity="info" sx={{ mt: 1, mb: 1 }}>
                Transcription is switched off — nothing is submitted to any provider. The
                configuration below is kept, so switching this back on needs no retyping.
              </Alert>
            )}

            <Divider sx={{ my: 3 }} />

            <TextField
              select
              fullWidth
              label="Provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as TranscriptionProviderId | '')}
              disabled={!canWrite}
              helperText="Which speech-to-text service this deployment sends audio to."
              sx={{ mb: 3 }}
            >
              <MenuItem value="">None</MenuItem>
              {data.providers.map((entry) => (
                <MenuItem key={entry.id} value={entry.id}>
                  {entry.label}
                </MenuItem>
              ))}
            </TextField>

            {/* The provider-specific fields. Kept MOUNTED rather than gated on
                the selection, matching `EmailSettingsPage`'s treatment of its
                per-transport fields: switching provider and switching back
                must not lose what was already typed. */}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                select
                fullWidth
                label="Region"
                value={region}
                onChange={(e) => setRegion(e.target.value as AssemblyAiRegion)}
                disabled={!canWrite}
                helperText="An API key is issued for one region; a key from the other is refused the same way a wrong key is."
              >
                <MenuItem value="us">United States</MenuItem>
                <MenuItem value="eu">European Union</MenuItem>
              </TextField>
              <TextField
                fullWidth
                label="Speech model"
                value={speechModel}
                onChange={(e) => setSpeechModel(e.target.value)}
                disabled={!canWrite}
                helperText="The provider's model identifier, e.g. universal."
              />
            </Stack>
          </Paper>

          {/* ================================================================
              API KEY — write-only, described rather than shown.
              ============================================================= */}
          <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" gutterBottom>
              API key
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {keyProvenance(keyStatus)} The key itself is held encrypted and is never shown
              again — replacing it is the only way to change it.
            </Typography>

            {showKeyField ? (
              <TextField
                fullWidth
                type="password"
                label="API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={!canWrite}
                autoComplete="off"
                helperText={
                  keyStatus?.configured
                    ? 'Leave this empty to keep the stored key.'
                    : 'Paste the key from your provider account. Test it before saving.'
                }
                sx={{ mb: 2 }}
              />
            ) : null}

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2 }}>
              {keyStatus?.configured && !isReplacingKey && (
                <Button
                  variant="outlined"
                  disabled={!canWrite}
                  onClick={() => setIsReplacingKey(true)}
                >
                  Replace key
                </Button>
              )}
              {keyStatus?.configured && (
                <Button
                  variant="outlined"
                  color="error"
                  disabled={!canWrite || isRemovingKey}
                  onClick={() => void handleRemoveKey()}
                >
                  {isRemovingKey ? 'Removing…' : 'Remove key'}
                </Button>
              )}
              <Button
                variant="outlined"
                disabled={!canWrite || isTesting || provider === ''}
                onClick={() => void handleTest()}
              >
                {isTesting ? 'Testing…' : 'Test connection'}
              </Button>
            </Stack>

            {removeKeyError && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={clearRemoveKeyError}>
                {removeKeyError}
              </Alert>
            )}

            {/* THE PROBE RESULT. A refusal is a successful DIAGNOSIS, so it is
                rendered with the provider's own explanation rather than
                flattened to "test failed" — which of "the key is wrong", "the
                region is wrong" and "the network is down" happened is the
                entire value of this control. */}
            {testResult && (
              <Alert
                severity={testResult.ok ? 'success' : 'error'}
                onClose={clearTestResult}
              >
                <AlertTitle>
                  {testResult.ok
                    ? `Connection succeeded in ${testResult.latencyMs} ms`
                    : 'Connection failed'}
                </AlertTitle>
                {testResult.detail}
              </Alert>
            )}
          </Paper>

          {/* ================================================================
              PROCESSING — what happens after the transcript arrives.
              ============================================================= */}
          <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" gutterBottom>
              Processing
            </Typography>

            <FormControlLabel
              control={
                <Switch
                  checked={deleteRemote}
                  onChange={(e) => setDeleteRemote(e.target.checked)}
                  disabled={!canWrite}
                  slotProps={{ input: { 'aria-label': 'Delete remote data after ingest' } }}
                />
              }
              label="Delete the audio and transcript from the provider once it is stored here"
            />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, ml: 6 }}>
              Audio sent to a third party stays there until it is deleted. Turning this off
              keeps it on the provider indefinitely.
            </Typography>

            <FormControlLabel
              control={
                <Switch
                  checked={nodeOffload}
                  onChange={(e) => setNodeOffload(e.target.checked)}
                  disabled={!canWrite}
                  slotProps={{ input: { 'aria-label': 'Allow worker nodes to transcode' } }}
                />
              }
              label="Allow worker nodes to produce the playback copy"
            />
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3, ml: 6 }}>
              Transcoding is CPU-heavy. A worker node needs only a signed URL and a
              processor to do it — no database access.
            </Typography>

            <Divider sx={{ my: 3 }} />

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                fullWidth
                label="Default language"
                value={defaultLanguage}
                onChange={(e) => setDefaultLanguage(e.target.value)}
                disabled={!canWrite}
                placeholder="detect"
                helperText="A language code such as en or es. Leave empty to let the provider detect it."
              />
              <TextField
                fullWidth
                type="number"
                label="Playback bitrate (kbit/s)"
                value={bitrateKbps}
                onChange={(e) => setBitrateKbps(e.target.value)}
                disabled={!canWrite}
                error={!!bitrateError}
                helperText={
                  bitrateError ??
                  'Bitrate of the compressed copy used for playback while proof-reading.'
                }
              />
            </Stack>
          </Paper>

          {/* ================================================================
              UPLOADS — what happens to a recording whose upload never ends.
              Its own card (#339) rather than the tail of Processing: it is
              about bytes that never arrived, not about what happens to them
              once they have.
              ============================================================= */}
          <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" gutterBottom>
              Uploads
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Recordings whose upload stops and is never resumed are deleted automatically,
              so they don&apos;t linger in the library.
            </Typography>

            <TextField
              fullWidth
              type="number"
              label="Abandoned upload cleanup (hours)"
              value={abandonedUploadHours}
              onChange={(e) => setAbandonedUploadHours(e.target.value)}
              disabled={!canWrite}
              error={!!abandonedHoursError}
              slotProps={{ htmlInput: { min: 1, max: 720, step: 1 } }}
              helperText={
                abandonedHoursError ??
                'Uploads with no activity for this long are deleted automatically. Default 3.'
              }
            />
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
            <Button
              type="submit"
              variant="contained"
              disabled={!canWrite || isSaving || hasFieldError}
            >
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

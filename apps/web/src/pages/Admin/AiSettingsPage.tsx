/**
 * Admin → Settings → AI (`/admin/settings/ai`).
 *
 * Issue #55, epic #45; the model policy rebuilt by issue #78. A STANDALONE
 * PAGE, exactly like `TranscriptionSettingsPage` and `EmailSettingsPage` and
 * for the same reason: this hits its own controller (`/api/ai-settings`) with
 * its own document, not the generic `system_settings` blob. One entry in
 * `ADMIN_SECTIONS` (`config/adminSections.tsx`), one route in `App.tsx` gated
 * on the same `system_settings:read` string `ai-settings.controller.ts`
 * enforces on its GET, no tab anywhere — CLAUDE.md's "MANDATORY: Settings UI
 * Pattern" rules 1, 2 and 3.
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
 * ⚠ THAT NOTICE IS ALSO THE ONE STATEMENT OF THE ARGUMENT. The discovery dialog
 * spends the reader's OWN key and 409s when they have none, and it points back
 * here rather than restating why there is nothing to fall back on. One
 * statement, in the place somebody is already looking for a key field.
 *
 * =============================================================================
 * WHAT IS HERE INSTEAD: POLICY, WHICH IS THE DEPLOYMENT'S ONLY LEVER
 * =============================================================================
 *
 * Since the key and the bill are each user's own, the only things a deployment
 * controls are: whether AI runs at all, which vendor it runs against, which API
 * root that vendor is called at, which models are permitted, which is offered
 * first, how many tokens one request may spend, how long one request may take,
 * and how large an attached source document may be. That is exactly the field
 * set below, and every one of them is a ceiling on somebody else's money —
 * which is why they are worth an administrator's attention even though no
 * credential is.
 *
 * `allowedModels` REPLACES WHOLESALE on save, matching the API's RFC 7396 array
 * rule: a merging list could never express "stop permitting this model", so
 * removing one from the list would silently be a no-op.
 *
 * =============================================================================
 * #78: THE MODEL POLICY IS NO LONGER A SUBSET OF WHAT THIS BUILD SHIPS KNOWING
 * =============================================================================
 *
 * `allowedModels` used to be a textarea of ids, each resolved against a
 * four-entry catalogue compiled into the API — so a model the vendor shipped
 * last week could be typed, saved, listed back, and silently never offered to
 * anyone, and adopting it needed a release. Three changes replace that, and
 * each has its own component header:
 *
 *   • `AiPermittedModels` — one row per model, with the context window and
 *     output ceiling collected exactly when this build cannot supply them;
 *   • `AiModelDiscoveryDialog` — "Load models from provider", which asks the
 *     vendor what exists using the READER'S OWN key;
 *   • the manual-add path inside the editor, which is not a fallback but the
 *     guarantee: the vendor list is heuristically filtered and key-scoped, so
 *     it must never be the only way to permit a model.
 *
 * ⚠ THE MODEL SECTION EDITS `providers.openai`, WHICH IS A DIFFERENT AXIS FROM
 * THE ACTIVE PROVIDER. `settings.provider` says which vendor is in use;
 * `settings.providers.openai` is that vendor's own block, and it is kept
 * whether or not the vendor is active — which is why switching the select to
 * "None" does not blank this section and does not lose anything. So the
 * catalogue the rows resolve against is OPENAI'S, not the active provider's:
 * resolving against the active one would flip every row to "needs token limits"
 * the moment somebody selected None, and block a save that was already valid.
 * The settings type has exactly one provider block today, so a second one is a
 * compile error here rather than a silent mis-edit.
 *
 * =============================================================================
 * #83: THE SAVE BUTTON BLOCKS ONLY ON A REAL CONTRADICTION, AND SAYS WHY
 * =============================================================================
 *
 * The shipping defaults of the `ai` namespace are `allowedModels: []` with
 * `defaultModel: 'gpt-4o'`, so this page used to load ALREADY INVALID: the
 * default named a model an empty list cannot contain, `defaultModelError` was
 * non-null on first paint, and the single `hasError` gate greyed out `Save
 * changes` before the administrator had touched anything — including the enable
 * switch and the provider select, two controls with nothing to do with the model
 * list. A fresh deployment could therefore never turn AI on from here, while the
 * only other page that mentions the problem (`/settings/ai`) pointed back at
 * this one.
 *
 * Two rules follow, and neither may be folded back into a single gate:
 *
 *   • A DEFAULT OUTSIDE A NON-EMPTY LIST IS A CONTRADICTION AND STILL BLOCKS;
 *     AN EMPTY LIST IS NOT. `ai-settings.schema.ts` states the API's own rule:
 *     the default "SHOULD be a member of `allowedModels`; that is checked at
 *     the service boundary rather than here […] and a default outside the list
 *     is reported to the admin page rather than silently corrected" — the save
 *     is ACCEPTED there. Refusing it here made this page stricter than the API
 *     it talks to, for nothing. The one default that genuinely cannot be saved
 *     is the empty string, because that field's schema is `min(1)`.
 *
 *   • WHEN NOTHING IS PERMITTED, SAY WHAT TO DO NEXT INSTEAD OF BLOCKING. With
 *     an empty list there is no contradiction to report — but there is also
 *     nothing any user could generate with, and the way out that needs no API
 *     key at all is `Add a model by hand` in the editor below, which
 *     `AiPermittedModels`'s header calls "not a fallback, the guarantee".
 *     Nothing on the blocked path pointed at it. It is ONE `info` notice in the
 *     models section, deliberately not a fourth alert at the top of a page that
 *     already carries three: stacking notices is how all of them stop being
 *     read.
 *
 * And when `Save changes` IS disabled it now names what is unresolved and which
 * section it is in. A greyed-out primary control whose reason is helper text
 * three `Paper`s further down is indistinguishable from a broken page — which is
 * exactly how issue #83 was reported: "it is not letting me".
 *
 * =============================================================================
 * #87: REASONING EFFORT IS A CEILING FIELD, WHICH IS WHY IT IS IN `Limits`
 * =============================================================================
 *
 * `reasoningEffort` is sent to the provider as `reasoning_effort`, and it looks
 * like a provider knob — so it would land naturally in the Provider section
 * above, next to the vendor and the API root. It is in `Limits` instead, and the
 * reason is the only thing about this field an administrator has to know:
 *
 *   REASONING TOKENS ARE BILLED AND COUNTED AS OUTPUT TOKENS. They come out of
 *   the SAME `Max output tokens` ceiling the visible answer comes out of. At
 *   `high` or `xhigh` against the shipping 16,384 default, a generation can
 *   spend most of its budget thinking and return little or nothing — and it
 *   arrives as a TRUNCATED COMPLETION, not as an error anybody would connect to
 *   this control.
 *
 * So it is a bound on somebody else's spend, exactly like `maxInputTokens` and
 * `maxOutputTokens`, and it belongs beside the one field it can silently
 * exhaust. The helper text names that field, in this page's own voice, at the
 * point of the control — not in a tooltip: a consequence somebody only
 * discovers by hovering is a consequence they discover from a support ticket.
 *
 * The option labels carry the trade-off too (`None (fastest, no reasoning)` …
 * `Extra high (slowest, most output tokens)`), so the dropdown is legible
 * without the vendor's documentation open beside it.
 *
 * Mobile-first like its siblings — every row stacks at `xs` and goes horizontal
 * at `sm`, and nothing here mounts, unmounts or re-gates on a breakpoint (there
 * is no `useMediaQuery` in this page or in the three components it renders), so
 * Settings UI Pattern rule 5's five coupled gates are untouched by construction.
 */

import { useEffect, useMemo, useState } from 'react';
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
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import KeyOffOutlinedIcon from '@mui/icons-material/KeyOffOutlined';
import { Navigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';
import { useAiSettings } from '../../hooks/useAiSettings';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { AiModelDiscoveryDialog } from '../../components/admin/AiModelDiscoveryDialog';
import {
  AiPermittedModels,
  permittedModelsHaveError,
  toAllowedModels,
  toPermittedDrafts,
  type PermittedModelDraft,
} from '../../components/admin/AiPermittedModels';
import { AI_ALLOWED_MODELS_MAX } from '../../services/ai';
import type {
  AiProviderId,
  AiReasoningEffort,
  UpdateAiSettingsInput,
} from '../../services/ai';

/**
 * The provider whose block the model section edits.
 *
 * ⚠ A CONSTANT RATHER THAN THE SELECTED PROVIDER, and the file header says why:
 * `settings.providers.openai` is a per-vendor block that exists whether or not
 * that vendor is active, so the catalogue these rows resolve against is its
 * own. It is also what `discoverAiModels` is asked about, which is exactly the
 * "inspect a catalogue before switching to it" case the API's `?provider=`
 * override exists for — an administrator can load OpenAI's model list while the
 * active provider is still None.
 */
const MODEL_POLICY_PROVIDER = 'openai' as const;

/** Bounds mirrored from `ai-settings.schema.ts`, so a 400 is prevented rather than reported. */
const BOUNDS = {
  maxInputTokens: { min: 256, max: 2_000_000 },
  maxOutputTokens: { min: 64, max: 200_000 },
  requestTimeoutMs: { min: 1_000, max: 3_600_000 },
  maxDocumentBytes: { min: 65_536, max: 268_435_456 },
} as const;

/**
 * The reasoning-effort options, LABELLED WITH THEIR TRADE-OFF.
 *
 * The ids are the API's enum; the labels exist so the cost of moving down this
 * list is readable from the dropdown alone. Ascending order of spend, so the
 * list itself is the scale — see the `#87` section of the file header.
 */
const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: AiReasoningEffort;
  label: string;
}> = [
  { value: 'none', label: 'None (fastest, no reasoning)' },
  { value: 'low', label: 'Low (brief reasoning, few extra tokens)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (slower, many more output tokens)' },
  { value: 'xhigh', label: 'Extra high (slowest, most output tokens)' },
];

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
    isDiscovering,
    discoverResult,
    discoverError,
    discoverModels,
    clearDiscoverResult,
  } = useAiSettings();

  // Draft state, seeded from the server's response after every load AND every
  // write — the response is the new baseline, which is how the form resyncs
  // after a save without a reload.
  const [enabled, setEnabled] = useState(false);
  // `''` IS THE "NONE" OPTION, NOT AN UNSET SENTINEL. The API models "nobody has
  // chosen a vendor" as a persisted `null`, and MUI's `Select` cannot hold
  // `null` as an option value, so the two are mapped at the boundary — the same
  // treatment `TranscriptionSettingsPage` gives its own nullable provider.
  const [provider, setProvider] = useState<AiProviderId | ''>('');
  const [baseUrl, setBaseUrl] = useState('');
  const [permittedModels, setPermittedModels] = useState<PermittedModelDraft[]>([]);
  const [defaultModel, setDefaultModel] = useState('');
  const [maxInputTokens, setMaxInputTokens] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState('');
  const [requestTimeoutMs, setRequestTimeoutMs] = useState('');
  const [maxDocumentBytes, setMaxDocumentBytes] = useState('');
  // Not `''`-as-none like the provider select above: `'none'` is a real stored
  // value meaning "omit the parameter", so there is no null to map at the
  // boundary and the `Select` holds the wire value directly.
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort>('none');

  const [discoveryOpen, setDiscoveryOpen] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.settings;
    setEnabled(s.enabled);
    setProvider(s.provider ?? '');
    setBaseUrl(s.providers.openai.baseUrl);
    setPermittedModels(toPermittedDrafts(s.providers.openai.allowedModels));
    setDefaultModel(s.providers.openai.defaultModel);
    setMaxInputTokens(String(s.maxInputTokens));
    setMaxOutputTokens(String(s.maxOutputTokens));
    setRequestTimeoutMs(String(s.requestTimeoutMs));
    setMaxDocumentBytes(String(s.maxDocumentBytes));
    setReasoningEffort(s.reasoningEffort);
  }, [data]);

  // The permitted ids, as the default-model select and the discovery dialog
  // both need them. Memoised on the drafts rather than recomputed inline
  // because the dialog takes a `Set` and would otherwise get a new identity on
  // every keystroke anywhere on the page.
  const modelIds = useMemo(
    () => permittedModels.map((draft) => draft.id.trim()).filter((id) => id.length > 0),
    [permittedModels],
  );
  const permittedIds = useMemo(() => new Set(modelIds), [modelIds]);

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

  // See `MODEL_POLICY_PROVIDER`: the block being edited belongs to OpenAI, so
  // its catalogue does too — independently of which vendor is active.
  const modelPolicyProvider = data.providers.find(
    (entry) => entry.id === MODEL_POLICY_PROVIDER,
  );
  const catalogue = modelPolicyProvider?.capabilities.models ?? [];
  // ⚠ THE ONLY THING THE DISCOVERY BUTTON MAY BE GATED ON. A provider that
  // declares this false has no `listModels` at all, and the API refuses at boot
  // to register one that says otherwise — so pressing the button would spend a
  // request to earn a 400 whose fix ("type the id by hand") is already a
  // first-class control on this page.
  const canDiscover = modelPolicyProvider?.capabilities.modelDiscovery === true;

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
  const modelsError = permittedModelsHaveError(permittedModels, catalogue);
  // ⚠ ONLY A REAL CONTRADICTION BLOCKS THE SAVE — see the `#83` section of the
  // file header. An empty default cannot be saved at all (`ai-settings.schema
  // .ts` is `min(1)` on this field), and a default naming none of the models
  // that ARE permitted is a policy offering nobody anything. A default with no
  // permitted models to belong to is neither: the API accepts that and reports
  // it back rather than correcting it, so this page accepts it too.
  const defaultModelError =
    defaultModel.trim().length === 0
      ? 'Name the model to offer first — this cannot be left empty.'
      : modelIds.length > 0 && !modelIds.includes(defaultModel.trim())
        ? 'This model is not in the permitted list, so nothing would be able to select it.'
        : null;
  // GUIDANCE, NOT AN ERROR, and therefore deliberately absent from `hasError`:
  // an empty allow-list is the state a fresh deployment starts in, and the fix
  // is a control on this page rather than something to be refused over.
  const noPermittedModels = modelIds.length === 0;
  const hasError =
    !!inputError ||
    !!outputError ||
    !!timeoutError ||
    !!documentError ||
    modelsError ||
    !!defaultModelError;

  // What a disabled `Save changes` is waiting on, named by the SECTION heading
  // it is under so the reader can go straight to it. Built here rather than
  // inline in the button because the button renders it as a sentence, and a
  // sentence assembled in JSX is a sentence nobody can read in the source.
  const saveBlockers: string[] = [];
  if (modelsError && defaultModelError) {
    saveBlockers.push('the permitted models and the default model, under “Permitted models”');
  } else if (modelsError) {
    saveBlockers.push(
      'a permitted model that is missing its context window or output ceiling, under “Permitted models”',
    );
  } else if (defaultModelError) {
    saveBlockers.push('the default model, under “Permitted models”');
  }
  if (inputError || outputError || timeoutError || documentError) {
    saveBlockers.push('a value that is out of range, under “Limits”');
  }

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || hasError) return;

    const input: UpdateAiSettingsInput = {
      enabled,
      // `null`, not `undefined`: `null` is the VALUE meaning "no vendor is
      // active", and the API's merge distinguishes the two with `!== undefined`
      // — so sending `undefined` here would make "switch the provider off" a
      // silent no-op that returned 200.
      provider: provider === '' ? null : provider,
      providers: {
        openai: {
          baseUrl: baseUrl.trim(),
          // Wholesale replacement, and always as OBJECTS — see the file header
          // and `AiAllowedModel`'s doc comment for why the legacy bare-string
          // form is a read-compatibility rule, not a shorthand worth using.
          allowedModels: toAllowedModels(permittedModels),
          defaultModel: defaultModel.trim(),
        },
      },
      maxInputTokens: Number.parseInt(maxInputTokens, 10),
      maxOutputTokens: Number.parseInt(maxOutputTokens, 10),
      requestTimeoutMs: Number.parseInt(requestTimeoutMs, 10),
      maxDocumentBytes: Number.parseInt(maxDocumentBytes, 10),
      reasoningEffort,
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

  /**
   * Open the dialog AND make the call.
   *
   * ⚠ THE CALL LIVES ON THIS CLICK, NOT IN AN EFFECT INSIDE THE DIALOG. It
   * spends a real vendor request on the reader's own account, so it must happen
   * once per deliberate press — never on a mount, a re-render or a re-open.
   */
  const handleLoadModels = () => {
    setDiscoveryOpen(true);
    void discoverModels(MODEL_POLICY_PROVIDER);
  };

  const handleCloseDiscovery = () => {
    setDiscoveryOpen(false);
    clearDiscoverResult();
  };

  /**
   * Merge the dialog's selection in.
   *
   * ADDS ONLY. The dialog already excludes anything on the permitted list, and
   * this filters again rather than trusting it: the two states can drift while
   * the dialog is open (a row removed behind it), and a duplicate id would be
   * saved as two entries the editor then shows twice.
   */
  const handleConfirmDiscovery = (chosen: PermittedModelDraft[]) => {
    setPermittedModels((current) => {
      const existing = new Set(current.map((draft) => draft.id.trim()));
      return [...current, ...chosen.filter((draft) => !existing.has(draft.id.trim()))];
    });
    handleCloseDiscovery();
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

        {/* Permitted models this deployment cannot budget for — since #78 that
            means "resolves to nothing", not "absent from the build catalogue":
            an entry carrying its own two numbers is fine and is not listed
            here. Reported rather than silently dropped, because such a model
            can never be offered and an administrator would otherwise have
            nothing to explain why it vanished. */}
        {data.unknownModels.length > 0 && (
          <Alert severity="warning" sx={{ mb: 3 }}>
            <AlertTitle>Some permitted models cannot be used</AlertTitle>
            {data.unknownModels.join(', ')} — this build does not know these models and they
            carry no context window or output ceiling of their own, so requests for them
            cannot be budgeted and they are never offered to a user. Give each one both
            numbers below, or remove it.
          </Alert>
        )}

        <Box component="form" onSubmit={handleSave} noValidate>
          {/* ================================================================
              PROVIDER — the switch, the vendor, and the API root.
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

            {/* The vendor axis, SEPARATE from the master switch above: an
                administrator can switch vendors without touching `enabled`, and
                switch AI off for an incident without losing the vendor choice.
                Mirrors `TranscriptionSettingsPage`'s select, "None" included. */}
            <TextField
              select
              fullWidth
              label="Provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as AiProviderId | '')}
              disabled={!canWrite}
              helperText="Which AI service this deployment sends prompts to. Each provider keeps its own settings below, so switching away and back loses nothing."
              sx={{ mb: 3 }}
            >
              <MenuItem value="">None</MenuItem>
              {data.providers.map((entry) => (
                <MenuItem key={entry.id} value={entry.id}>
                  {entry.label}
                </MenuItem>
              ))}
            </TextField>

            {provider === '' && (
              <Alert severity="info" sx={{ mb: 3 }}>
                No provider is selected, so nothing can be generated even with AI enabled and
                keys saved. Everything below is kept exactly as it is — choosing a provider
                again needs no retyping.
              </Alert>
            )}

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
              MODELS — the allow-list and the default (#78).
              ============================================================= */}
          <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
            <Typography variant="h6" component="h2" gutterBottom>
              Permitted models
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              An allow-list, not a catalogue. A model a user&apos;s own key could reach but
              this list does not name is refused here before any request is made. A model
              this build does not already know can still be permitted — supply its context
              window and output ceiling and it is budgeted from those, with no release of
              this application needed.
            </Typography>

            {/* ⚠ THE ONE STATEMENT OF THE EMPTY-LIST SITUATION, and `info`
                rather than `error` on purpose: it does not block the save (see
                the `#83` section of the file header) — it says what to do next.
                It sits beside the two controls that fix it rather than as a
                fourth alert at the top of the page. */}
            {noPermittedModels && (
              <Alert severity="info" sx={{ mb: 3 }}>
                <AlertTitle>No models are permitted yet, so AI cannot run</AlertTitle>
                Until this list names at least one model, nothing can be generated by
                anyone — with the switch above on, a provider chosen, and users&apos; own
                keys saved. Use <strong>Add a model by hand</strong> below to name one and
                give it a context window and output ceiling: that path needs no API key, no
                provider call and no release of this application, and it is the way out of
                this state on a deployment where nobody has a key yet.
              </Alert>
            )}

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, mb: 3 }}
            >
              <Button
                variant="outlined"
                startIcon={<CloudDownloadOutlinedIcon />}
                onClick={handleLoadModels}
                disabled={!canWrite || !canDiscover || isDiscovering}
              >
                {isDiscovering ? 'Loading…' : 'Load models from provider'}
              </Button>
              <Typography variant="caption" color="text.secondary">
                {canDiscover
                  ? // Said before the click, not after the bill: this request is
                    // authenticated with the reader's own key because the
                    // deployment holds none, and it is theirs to pay for.
                    'Asks the provider which models your own API key can reach. This spends one request on your own account.'
                  : 'This provider cannot list its models, so add them by hand below.'}
              </Typography>
            </Stack>

            <AiPermittedModels
              value={permittedModels}
              onChange={setPermittedModels}
              catalogue={catalogue}
              disabled={!canWrite}
            />

            <Divider sx={{ my: 3 }} />

            <TextField
              select={modelIds.length > 0}
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
                  flagged by `defaultModelError` above. This is also what keeps
                  the `Select` from being handed a `value` no `MenuItem`
                  carries, which MUI renders as an empty, unselectable box. */}
              {(modelIds.includes(defaultModel.trim()) || defaultModel.trim() === ''
                ? modelIds
                : [defaultModel, ...modelIds]
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

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3 }}>
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

            {/* ⚠ A CEILING FIELD, NOT A PROVIDER KNOB — see the `#87` section of
                the file header. It is here, beside `Max output tokens`, because
                it is spent out of that ceiling; the helper text says so at the
                control rather than in a tooltip, because the failure it causes
                (a truncated answer, no error) is one nobody would otherwise
                trace back to this select. Same `Stack` shape as its siblings so
                the section still stacks cleanly at ~400px. */}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                select
                fullWidth
                label="Reasoning effort"
                value={reasoningEffort}
                onChange={(event) =>
                  setReasoningEffort(event.target.value as AiReasoningEffort)
                }
                disabled={!canWrite}
                helperText={
                  <>
                    How hard the model is asked to think before it answers. Reasoning is
                    billed and counted as <strong>output</strong> tokens, drawn from the
                    same <strong>Max output tokens</strong> ceiling above as the answer
                    itself — so at <strong>High</strong> or <strong>Extra high</strong> a
                    generation can spend most of that ceiling thinking and return a short
                    or empty answer, which arrives as a truncated completion rather than
                    an error. Raise <strong>Max output tokens</strong> alongside this.{' '}
                    <strong>None</strong> sends no reasoning setting at all, leaving the
                    vendor&apos;s own default — and it is what this deployment ships with.
                  </>
                }
              >
                {REASONING_EFFORT_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </TextField>
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
            <Button
              type="submit"
              variant="contained"
              disabled={!canWrite || isSaving || hasError}
              aria-describedby={hasError ? 'save-blocked-reason' : undefined}
            >
              {isSaving ? 'Saving…' : 'Save changes'}
            </Button>
            {/* ⚠ A DISABLED PRIMARY CONTROL MUST SAY WHY. Without this the only
                signal is a grey button whose cause is a field in a different
                `Paper`, which reads as a broken page rather than as unfinished
                input — issue #83's actual report. */}
            {hasError && (
              <Typography
                id="save-blocked-reason"
                variant="body2"
                color="error"
                sx={{ flexGrow: 1 }}
              >
                Save is unavailable until you fix {saveBlockers.join(' and ')} — highlighted
                in red above.
              </Typography>
            )}
          </Box>
        </Box>

        <AiModelDiscoveryDialog
          open={discoveryOpen}
          onClose={handleCloseDiscovery}
          onReload={() => void discoverModels(MODEL_POLICY_PROVIDER)}
          isLoading={isDiscovering}
          result={discoverResult}
          error={discoverError}
          alreadyPermitted={permittedIds}
          remainingCapacity={Math.max(0, AI_ALLOWED_MODELS_MAX - permittedModels.length)}
          onConfirm={handleConfirmDiscovery}
        />

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

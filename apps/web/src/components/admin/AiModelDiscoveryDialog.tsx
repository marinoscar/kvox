/**
 * "Load models from the provider" — issue #78, epic #45.
 *
 * =============================================================================
 * ⚠ THIS DIALOG SPENDS THE READER'S OWN MONEY, AND IT SAYS SO
 * =============================================================================
 *
 * `GET /api/ai-settings/models` authenticates as the administrator who opened
 * this, because epic #45 is strict bring-your-own-key and this deployment holds
 * no AI credential of any kind to fall back on (docs/specs/notes.md §9). Two
 * consequences shape everything below:
 *
 *   1. THE CALL IS NEVER MADE ON MOUNT. It is made when this dialog is opened
 *      by a click, and repeated only by an explicit "Try again". An effect that
 *      refreshed the list — on open, on provider change, on focus — would bill
 *      an individual person for a page render.
 *   2. THE LIST IS THE ONE **THEIR** KEY CAN REACH. On OpenAI that is
 *      project-scoped, so two administrators can legitimately see two different
 *      lists, and the policy saved from either is checked at generation time
 *      against each USER'S own key — not against this list. The footer says
 *      this, because an administrator who assumes otherwise will read a missing
 *      model as "this deployment cannot use it".
 *
 * =============================================================================
 * THE THREE OUTCOMES ARE THREE DIFFERENT SENTENCES
 * =============================================================================
 *
 * ⚠ A REFUSAL IS A **200** WITH `ok: false`, not an exception — the same
 * convention every `/test` in this codebase follows, because a vendor refusing
 * a key is a successful diagnosis. `detail` is shown VERBATIM in that case: it
 * is the entire value of the call, distinguishing "the key is wrong", "the
 * account has no credit" and "the endpoint is unreachable" — three fixes that
 * look identical from a failed generation an hour later. Paraphrasing it, or
 * replacing it with "Could not load models", throws away the only thing the
 * request bought.
 *
 * The 409 (`kind: 'key-missing'`) is the outcome that is NOT about the vendor
 * at all: the reader has saved no key of their own. It points at
 * `/settings/ai` and cross-references the page's own "there is no API key on
 * this page, by design" notice rather than restating that argument here — one
 * statement of it, in the place an administrator is already looking for a key
 * field, is the point of that notice.
 *
 * =============================================================================
 * MERGING, NOT REPLACING
 * =============================================================================
 *
 * ⚠ CONFIRM ADDS; IT NEVER REMOVES AND NEVER OVERWRITES. A model already on the
 * permitted list is shown checked and disabled, and is excluded from what
 * `onConfirm` returns — so numbers the administrator typed by hand a minute ago
 * cannot be clobbered by a vendor list that carries no numbers at all (for an
 * unknown model the vendor tells us NOTHING: `known: false` implies both fields
 * are `null`). "Replace the list with the vendor's" would be a one-click way to
 * delete a deliberate policy, and there is no undo on this page.
 */

import { useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { AI_KEY_SETTINGS_PATH } from '../ai/AiKeyRequired';
import type { AiDiscoveryError } from '../../hooks/useAiSettings';
import type { AiModelDiscovery } from '../../services/ai';
import {
  AiModelNumberFields,
  EMPTY_MODEL_NUMBERS,
  hasModelNumbersError,
  validateModelNumbers,
  type ModelNumbersDraft,
} from './AiModelNumberFields';
import type { PermittedModelDraft } from './AiPermittedModels';

export interface AiModelDiscoveryDialogProps {
  open: boolean;
  onClose: () => void;
  /** Re-run the probe. Wired to a button only — see the file header. */
  onReload: () => void;
  isLoading: boolean;
  /** The 200 answer, INCLUDING a refusal (`ok: false`). */
  result: AiModelDiscovery | null;
  /** Set only when the call itself failed — a 400, or the caller's missing key. */
  error: AiDiscoveryError | null;
  /** Ids already on the permitted list. Shown, locked, and never returned. */
  alreadyPermitted: Set<string>;
  /** How many more entries the policy can hold before hitting the API's cap. */
  remainingCapacity: number;
  /** Called with the NEW rows to append. Never with an existing one. */
  onConfirm: (models: PermittedModelDraft[]) => void;
}

export function AiModelDiscoveryDialog({
  open,
  onClose,
  onReload,
  isLoading,
  result,
  error,
  alreadyPermitted,
  remainingCapacity,
  onConfirm,
}: AiModelDiscoveryDialogProps) {
  /**
   * Which models are ticked, and the numbers typed for the unknown ones.
   *
   * ONE MAP RATHER THAN A `Set` PLUS A RECORD: presence is the tick and the
   * value is the draft, so unticking a model cannot leave its half-typed
   * numbers behind to be silently submitted if it is ticked again — which is
   * the bug two parallel structures produce the first time somebody changes
   * their mind.
   */
  const [selected, setSelected] = useState<Record<string, ModelNumbersDraft>>({});

  // Cleared whenever a NEW list arrives, and on close. A selection carried over
  // from a previous probe could name a model this list does not contain — a row
  // nobody can see, added by a button whose label says "2 models".
  useEffect(() => {
    setSelected({});
  }, [result, open]);

  const models = result?.ok ? result.models : [];

  const selectable = useMemo(
    () => models.filter((model) => !alreadyPermitted.has(model.id)),
    [models, alreadyPermitted],
  );

  const chosen = Object.entries(selected);

  const numbersInvalid = chosen.some(([id, draft]) => {
    const model = models.find((entry) => entry.id === id);
    // Required exactly when the API told us it cannot budget for the model:
    // `known: false` implies BOTH numbers are null, so there is no third source.
    return hasModelNumbersError(validateModelNumbers(draft, !model?.known));
  });

  const overCapacity = chosen.length > remainingCapacity;
  const canConfirm = chosen.length > 0 && !numbersInvalid && !overCapacity;

  const toggle = (id: string) => {
    setSelected((current) => {
      if (id in current) {
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [id]: EMPTY_MODEL_NUMBERS };
    });
  };

  const handleConfirm = () => {
    if (!canConfirm) return;

    onConfirm(
      chosen.map(([id, numbers]) => {
        const model = models.find((entry) => entry.id === id);
        return {
          id,
          // The vendor's display name is kept ONLY when it differs from the id.
          // Storing `label === id` would persist a value that says nothing and
          // that `resolveAllowedModel` would have produced anyway.
          label: model && model.label !== model.id ? model.label : '',
          // ⚠ A KNOWN MODEL'S NUMBERS ARE LEFT BLANK ON PURPOSE, not copied out
          // of the response. Blank means "the build catalogue answers", so the
          // entry keeps tracking the catalogue; copying today's values would
          // freeze them into the policy and quietly outlive the release that
          // corrects them.
          numbers: model?.known ? EMPTY_MODEL_NUMBERS : numbers,
        };
      }),
    );
  };

  return (
    <Dialog
      open={open}
      // MUI's own backdrop click and Escape both route here, and its focus trap
      // returns focus to the button that opened the dialog — so "focus-managed
      // and Escape-dismissible" needs no hand-rolled key handling, and adding
      // one would be a second, weaker copy of it.
      onClose={onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="ai-model-discovery-title"
      aria-describedby="ai-model-discovery-status"
    >
      <DialogTitle id="ai-model-discovery-title">Models from the provider</DialogTitle>

      <DialogContent dividers>
        {/* ⚠ THE LIVE REGION. The outcome of this call arrives seconds after a
            click with no focus change, so a screen-reader user is told nothing
            unless it is announced. `polite`, because it must not interrupt
            somebody mid-sentence, and it wraps every outcome — spinner,
            success, refusal, error — so there is exactly one announcer rather
            than four that could talk over each other. */}
        <Box id="ai-model-discovery-status" role="status" aria-live="polite">
          {isLoading && (
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', py: 2 }}>
              <CircularProgress size={20} />
              <Typography variant="body2">
                Asking the provider which models your key can reach…
              </Typography>
            </Stack>
          )}

          {/* ================================================================
              409 — the reader has no key of their OWN. Not a vendor failure,
              and the fix is on a different page. See the file header.
              ============================================================= */}
          {!isLoading && error?.kind === 'key-missing' && (
            <Alert severity="warning">
              <AlertTitle>Add your own API key first</AlertTitle>
              {error.message}
              <Box sx={{ mt: 1 }}>
                This deployment has no AI key of its own to fall back on — the notice at the
                top of this page explains why that is deliberate — so listing a
                provider&apos;s models has to authenticate as you.
              </Box>
              <Box sx={{ mt: 2 }}>
                <Button
                  component={RouterLink}
                  to={AI_KEY_SETTINGS_PATH}
                  size="small"
                  variant="outlined"
                >
                  Go to my AI keys
                </Button>
              </Box>
            </Alert>
          )}

          {/* The call could not be made: a 400 (no provider active, or one that
              cannot list models), or a transport failure. */}
          {!isLoading && error?.kind === 'other' && (
            <Alert severity="error">
              <AlertTitle>The model list could not be loaded</AlertTitle>
              {error.message}
            </Alert>
          )}

          {/* ================================================================
              ⚠ 200 WITH `ok: false` — a refusal, rendered VERBATIM.
              ============================================================= */}
          {!isLoading && result && !result.ok && (
            <Alert severity="warning">
              <AlertTitle>The provider would not list its models</AlertTitle>
              {result.detail}
            </Alert>
          )}

          {!isLoading && result?.ok && (
            <Alert severity={models.length > 0 ? 'success' : 'info'}>{result.detail}</Alert>
          )}
        </Box>

        {!isLoading && result?.ok && models.length > 0 && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 2 }}>
              Tick the models this deployment should permit. Anything already permitted is
              shown locked — confirming only ADDS, so nothing you have already configured is
              changed or removed.
            </Typography>

            <Stack spacing={1} component="ul" role="list" sx={{ p: 0, m: 0 }}>
              {models.map((model) => {
                const permitted = alreadyPermitted.has(model.id);
                const draft = selected[model.id];
                const checked = permitted || draft !== undefined;
                const errors = draft
                  ? validateModelNumbers(draft, !model.known)
                  : undefined;

                return (
                  <Paper
                    key={model.id}
                    variant="outlined"
                    component="li"
                    sx={{ p: 2, listStyle: 'none' }}
                  >
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={1}
                      sx={{ alignItems: { xs: 'flex-start', sm: 'center' } }}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={permitted}
                        onChange={() => toggle(model.id)}
                        slotProps={{
                          input: {
                            'aria-label': permitted
                              ? `${model.id} is already permitted`
                              : `Permit ${model.id}`,
                          },
                        }}
                        sx={{ ml: -1 }}
                      />

                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Typography
                          variant="subtitle2"
                          component="p"
                          sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                        >
                          {model.id}
                        </Typography>
                        {model.label !== model.id && (
                          <Typography variant="caption" color="text.secondary">
                            {model.label}
                          </Typography>
                        )}
                      </Box>

                      {permitted && (
                        <Chip size="small" label="Already permitted" variant="outlined" />
                      )}
                      <Chip
                        size="small"
                        // The join between "the vendor says it exists" and "this
                        // build can budget for it" — the single fact that
                        // decides whether two numbers are needed below.
                        label={model.known ? 'Known to this build' : 'Needs token limits'}
                        color={model.known ? 'default' : 'warning'}
                        variant={model.known ? 'outlined' : 'filled'}
                      />
                    </Stack>

                    {/* Revealed by ticking an unknown model, and only then: the
                        two numbers are the price of permitting something this
                        build has never heard of, and asking for them up front
                        for sixty models would be a wall of empty boxes. */}
                    {draft !== undefined && !model.known && errors && (
                      <Box sx={{ mt: 2 }}>
                        <AiModelNumberFields
                          modelId={model.id}
                          draft={draft}
                          errors={errors}
                          onChange={(numbers) =>
                            setSelected((current) => ({ ...current, [model.id]: numbers }))
                          }
                          required
                        />
                      </Box>
                    )}
                  </Paper>
                );
              })}
            </Stack>

            {overCapacity && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {chosen.length} models are ticked and only {remainingCapacity} more will fit
                — the policy holds at most 50 in total.
              </Alert>
            )}

            <Divider sx={{ my: 2 }} />

            <Typography variant="caption" color="text.secondary" component="p">
              This is the list <strong>your</strong> key can reach, filtered to what looks
              like a chat model. Another administrator&apos;s key may see a different one,
              and a model missing here can still be permitted by hand on the settings page.
              What you save is checked at generation time against each user&apos;s own key,
              never against this list.
            </Typography>
          </>
        )}

        {!isLoading && selectable.length === 0 && result?.ok && models.length > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Every model the provider listed is already permitted.
          </Alert>
        )}
      </DialogContent>

      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onReload} disabled={isLoading}>
          Try again
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleConfirm} disabled={!canConfirm}>
          {chosen.length > 0 ? `Permit ${chosen.length} model(s)` : 'Permit selected'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AiModelDiscoveryDialog;

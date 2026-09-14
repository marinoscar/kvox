/**
 * "Load models from the provider" — issue #78, epic #45; rebuilt by #97.
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
 *      by a click, repeated by an explicit "Try again", and — since #97 — by
 *      flipping "show every model", which is a SECOND REQUEST rather than a
 *      filter over a list already in hand, because the unfiltered list is an
 *      answer only the API can give. An effect that refreshed the list — on
 *      open, on provider change, on focus — would bill an individual person for
 *      a page render.
 *   2. THE LIST IS THE ONE **THEIR** KEY CAN REACH. On OpenAI that is
 *      project-scoped, so two administrators can legitimately see two different
 *      lists, and the policy saved from either is checked at generation time
 *      against each USER'S own key — not against this list. The footer says
 *      this, because an administrator who assumes otherwise will read a missing
 *      model as "this deployment cannot use it".
 *
 * =============================================================================
 * ⚠ #97: NOTHING HERE MAY DEMAND A NUMBER BEFORE A MODEL CAN BE PERMITTED
 * =============================================================================
 *
 * This dialog is where issue #97 was reported from, and the screenshot is worth
 * restating because it is what every change below is measured against. Each row
 * carried an orange "Needs token limits" chip and, once ticked, two REQUIRED
 * red-bordered inputs with the helper text "This build does not know this model,
 * so it cannot be offered without this number." A vendor ships a dated snapshot
 * per model per release, so that was forty-odd rows, eighty numbers, each to be
 * looked up in vendor documentation — and on a phone exactly ONE model fitted on
 * screen.
 *
 * The API now resolves both numbers for every id it returns (an exact catalogue
 * hit, a dated-snapshot match against a family, or a conservative floor), so the
 * three rules that follow are absolute:
 *
 *   • A BLANK NUMBER NEVER BLOCKS THE CONFIRM. Only a value somebody actually
 *     typed can be wrong, and only then inline, on that row.
 *   • A ROW'S DEFAULT STATE IS ONE LINE: id, one provenance chip, the detected
 *     numbers. The two inputs live behind an `Override` press.
 *   • THE CHIP STATES PROVENANCE, NEVER A DEMAND. `AiModelLimits` owns those
 *     words so this dialog and the permitted-models editor cannot drift into
 *     describing the same model two different ways.
 *
 * ⚠ `known` IS NOT THE GATE ANY MORE, AND MUST NOT BE REINTRODUCED AS ONE. It
 * narrowed to "an exact build-catalogue hit" — a dated snapshot is `known:
 * false` and carries its family's real limits. Branching on it to collect input
 * is re-implementing the bug. Branch on `source` to describe.
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
 * `onConfirm` returns — so an override the administrator typed by hand a minute
 * ago cannot be clobbered by a vendor list that carries no overrides at all.
 * "Replace the list with the vendor's" would be a one-click way to delete a
 * deliberate policy, and there is no undo on this page.
 *
 * ⚠ AND IT NEVER COPIES THE DETECTED NUMBERS INTO THE POLICY. What is returned
 * carries the administrator's OVERRIDE (usually blank) plus the provenance for
 * display; the resolved pair stays the API's to recompute. Freezing today's
 * numbers into the saved policy would quietly outlive the release that corrects
 * them — the same argument that kept a known model's numbers blank before #97,
 * now applying to every row rather than some of them.
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
import FormControlLabel from '@mui/material/FormControlLabel';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { AI_KEY_SETTINGS_PATH } from '../ai/AiKeyRequired';
import type { AiDiscoveryError } from '../../hooks/useAiSettings';
import type { AiDiscoveredModel, AiModelDiscovery } from '../../services/ai';
import {
  AiModelLimitChip,
  AiModelLimits,
  describeModelLimits,
  effectiveModelLimits,
  isModelOverridden,
  type ModelLimitProvenance,
} from './AiModelLimits';
import {
  EMPTY_MODEL_NUMBERS,
  hasModelNumbersError,
  validateModelNumbers,
  type ModelNumbersDraft,
} from './AiModelNumberFields';
import type { PermittedModelDraft } from './AiPermittedModels';

/** What the API resolved for one discovered model, in the shared display shape. */
function provenanceOf(model: AiDiscoveredModel): ModelLimitProvenance {
  return {
    source: model.source,
    derivedFrom: model.derivedFrom,
    contextWindowTokens: model.contextWindowTokens,
    maxOutputTokens: model.maxOutputTokens,
  };
}

export interface AiModelDiscoveryDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Re-run the probe. Wired to buttons only — see the file header.
   *
   * `includeAll` asks the API to skip its chat-model heuristic. It is a
   * parameter rather than dialog-local filtering because the unfiltered list is
   * not a superset this client holds.
   */
  onReload: (includeAll?: boolean) => void;
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
   * Which models are ticked, and the OVERRIDES typed for them.
   *
   * ONE MAP RATHER THAN A `Set` PLUS A RECORD: presence is the tick and the
   * value is the draft, so unticking a model cannot leave its half-typed
   * numbers behind to be silently submitted if it is ticked again — which is
   * the bug two parallel structures produce the first time somebody changes
   * their mind. Since #97 the value is blank for nearly every ticked model,
   * which is exactly the point.
   */
  const [selected, setSelected] = useState<Record<string, ModelNumbersDraft>>({});

  /** Whether the last request asked the API to skip its chat-model heuristic. */
  const [includeAll, setIncludeAll] = useState(false);

  // Cleared whenever a NEW list arrives, and on close. A selection carried over
  // from a previous probe could name a model this list does not contain — a row
  // nobody can see, added by a button whose label says "2 models".
  useEffect(() => {
    setSelected({});
  }, [result, open]);

  // The page's own "Load models" click asks for the filtered list, so the toggle
  // has to return to off with it — otherwise a reopened dialog would show a
  // filtered list under a switch claiming everything is shown.
  useEffect(() => {
    setIncludeAll(false);
  }, [open]);

  const models = result?.ok ? result.models : [];

  const selectable = useMemo(
    () => models.filter((model) => !alreadyPermitted.has(model.id)),
    [models, alreadyPermitted],
  );

  const chosen = Object.entries(selected);

  // ⚠ ONLY A TYPED VALUE CAN BE INVALID (#97). There is no "required" branch
  // here any more, and `validateModelNumbers` has no parameter that could
  // reintroduce one: what is checked is a bad number, or an output ceiling that
  // does not fit inside the context window in force for that model.
  const numbersInvalid = chosen.some(([id, draft]) => {
    const model = models.find((entry) => entry.id === id);
    return hasModelNumbersError(
      validateModelNumbers(
        draft,
        effectiveModelLimits(model ? provenanceOf(model) : null),
      ),
    );
  });

  const overCapacity = chosen.length > remainingCapacity;
  const canConfirm = chosen.length > 0 && !numbersInvalid && !overCapacity;

  // Selecting everything is legal since #97 — there is nothing left to fill in
  // per model — so it gets a control. It stops at the policy's own ceiling
  // rather than ticking rows the confirm would then refuse, and says so when it
  // had to stop early.
  const selectAllTruncated = selectable.length > remainingCapacity;

  const toggle = (id: string) => {
    setSelected((current) => {
      if (id in current) {
        const { [id]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [id]: EMPTY_MODEL_NUMBERS };
    });
  };

  const handleSelectAll = () => {
    setSelected((current) => {
      // MERGED, NOT REBUILT: an override already typed against a ticked model is
      // kept, because "select all" is an addition to the selection and losing
      // somebody's typing to a convenience button is never worth it.
      const next = { ...current };
      for (const model of selectable) {
        if (Object.keys(next).length >= remainingCapacity) break;
        if (!(model.id in next)) next[model.id] = EMPTY_MODEL_NUMBERS;
      }
      return next;
    });
  };

  const handleIncludeAll = (next: boolean) => {
    setIncludeAll(next);
    onReload(next);
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
          // that the API would have produced anyway.
          label: model && model.label !== model.id ? model.label : '',
          // ⚠ THE ADMINISTRATOR'S OVERRIDE, NOT THE DETECTED PAIR — usually
          // blank. See the file header: copying the resolved numbers in would
          // freeze today's inference into the saved policy.
          numbers,
          provenance: model ? provenanceOf(model) : null,
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
      slotProps={{
        paper: {
          // ⚠ CSS, NOT A BREAKPOINT GATE. MUI's default dialog margin is 32px a
          // side, which leaves 296px of a 360px phone for a list of model ids.
          // Narrowing the margin with an `sx` breakpoint value costs nothing;
          // a `useMediaQuery`-driven `fullScreen` would add a sixth
          // mount/unmount gate to the five Settings UI Pattern rule 5 already
          // couples, for a worse result.
          sx: {
            m: { xs: 1, sm: 4 },
            width: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
            maxHeight: { xs: 'calc(100% - 16px)', sm: 'calc(100% - 64px)' },
          },
        },
      }}
    >
      <DialogTitle id="ai-model-discovery-title">Models from the provider</DialogTitle>

      <DialogContent dividers sx={{ px: { xs: 2, sm: 3 } }}>
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

        {/* ====================================================================
            ⚠ THE ESCAPE HATCH FROM A HEURISTIC, LABELLED AS ONE. Outside the
            `result?.ok` branch below on purpose: the reason to reach for it is
            usually that the filtered list did NOT contain the model somebody
            wanted, which includes the case where it contained nothing at all.
            ================================================================= */}
        {!error && (
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={includeAll}
                  onChange={(event) => handleIncludeAll(event.target.checked)}
                  disabled={isLoading}
                  slotProps={{ input: { 'aria-label': 'Show every model the provider lists' } }}
                />
              }
              label="Show every model the provider lists"
            />
            <Typography variant="caption" color="text.secondary" component="p">
              Off, the list is filtered to what looks like a chat model. On, it is every id
              the provider returned — including embeddings, speech, image and moderation
              models, which cannot generate anything here. Reach for it when the model you
              want is missing. Each flip asks the provider again, on your own account.
            </Typography>
          </Box>
        )}

        {!isLoading && result?.ok && models.length > 0 && (
          <>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 1.5 }}>
              Tick the models this deployment should permit. Token limits are worked out for
              you — override one only if you know better. Anything already permitted is
              shown locked: confirming only ADDS, so nothing you have already configured is
              changed or removed.
            </Typography>

            {/* Bulk selection, legal since #97 and therefore offered. Stacks at
                `xs` so three controls never fight for a 360px row. */}
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ alignItems: { xs: 'stretch', sm: 'center' }, mb: 1.5 }}
            >
              <Button
                size="small"
                variant="outlined"
                onClick={handleSelectAll}
                disabled={selectable.length === 0}
              >
                Select all ({Math.min(selectable.length, remainingCapacity)})
              </Button>
              <Button size="small" onClick={() => setSelected({})} disabled={chosen.length === 0}>
                Clear
              </Button>
              <Box sx={{ flexGrow: 1 }} />
              <Typography variant="caption" color="text.secondary">
                {chosen.length} selected
                {selectAllTruncated &&
                  ` · ${selectable.length} available, ${remainingCapacity} will fit`}
              </Typography>
            </Stack>

            <Stack spacing={1} component="ul" role="list" sx={{ p: 0, m: 0 }}>
              {models.map((model) => {
                const permitted = alreadyPermitted.has(model.id);
                const draft = selected[model.id];
                const checked = permitted || draft !== undefined;
                const provenance = provenanceOf(model);
                const description = describeModelLimits(
                  provenance,
                  draft !== undefined && isModelOverridden(draft),
                );

                return (
                  <Paper
                    key={model.id}
                    variant="outlined"
                    component="li"
                    sx={{ p: { xs: 1.5, sm: 2 }, listStyle: 'none' }}
                  >
                    {/* ⚠ ONE ROW, NOT A CARD. The checkbox stays beside the id
                        at every width and everything else flows under it, so
                        several models are on screen at 360px — the single
                        measurable thing issue #97's screenshot complained
                        about. */}
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: 'flex-start', minWidth: 0 }}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={permitted}
                        onChange={() => toggle(model.id)}
                        size="small"
                        slotProps={{
                          input: {
                            'aria-label': permitted
                              ? `${model.id} is already permitted`
                              : `Permit ${model.id}`,
                          },
                        }}
                        sx={{ ml: -1, mt: -0.5 }}
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
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            component="p"
                          >
                            {model.label}
                          </Typography>
                        )}

                        <Stack
                          direction="row"
                          spacing={0.5}
                          useFlexGap
                          sx={{ flexWrap: 'wrap', my: 0.5 }}
                        >
                          {permitted && (
                            <Chip size="small" label="Already permitted" variant="outlined" />
                          )}
                          <AiModelLimitChip description={description} />
                        </Stack>

                        {/* The override, behind one press — and offered only
                            for a row somebody is actually permitting: numbers
                            typed against an unticked model would be collected,
                            validated and thrown away on close. The explanation
                            a conservative default needs is shown on the same
                            condition, because forty copies of one paragraph is
                            the wall of text this issue exists to remove. */}
                        <AiModelLimits
                          modelId={model.id}
                          provenance={provenance}
                          draft={draft ?? EMPTY_MODEL_NUMBERS}
                          onChange={(numbers) =>
                            setSelected((current) => ({ ...current, [model.id]: numbers }))
                          }
                          canOverride={checked && !permitted}
                          showExplanation={checked && !permitted}
                        />
                      </Box>
                    </Stack>
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
              This is the list <strong>your</strong> key can reach
              {includeAll ? ', unfiltered' : ', filtered to what looks like a chat model'}.
              Another administrator&apos;s key may see a different one, and a model missing
              here can still be permitted by hand on the settings page. What you save is
              checked at generation time against each user&apos;s own key, never against
              this list.
            </Typography>
          </>
        )}

        {!isLoading && selectable.length === 0 && result?.ok && models.length > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            Every model the provider listed is already permitted.
          </Alert>
        )}
      </DialogContent>

      {/* ⚠ OUTSIDE THE SCROLLING CONTENT, which `dividers` above is what
          guarantees: the actions are a sibling of the scroll container, so they
          cannot overlap a row however long the list is. `flexWrap` is what keeps
          that true at 360px, where three buttons do not fit on one line. */}
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: { xs: 2, sm: 3 } }}>
        <Button onClick={() => onReload(includeAll)} disabled={isLoading}>
          Try again
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleConfirm} disabled={!canConfirm}>
          {chosen.length > 0
            ? `Permit ${chosen.length} model${chosen.length === 1 ? '' : 's'}`
            : 'Permit selected'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default AiModelDiscoveryDialog;

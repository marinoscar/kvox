/**
 * Share a transcript with somebody (issue #29, epic #19).
 *
 * =============================================================================
 * SELF-CONTAINED, AND THAT IS DELIBERATE
 * =============================================================================
 *
 * This component owns the whole interaction: it loads the share list when it
 * opens, adds, promotes, demotes and removes, and reports its own errors. The
 * only things it needs from a parent are the transcript's id and title, and
 * `onClose` — so mounting it is three props and no plumbing, and issue #31 can
 * hang it off the transcript page's overflow menu without threading share state
 * through anything.
 *
 * =============================================================================
 * ⚠ NO AUTOCOMPLETE, NO DIRECTORY, NO TYPE-AHEAD LOOKUP
 * =============================================================================
 *
 * The email field is a plain text input that is read ONCE, on submit. It never
 * queries as somebody types. Issue #29 rejected autocomplete over the user
 * directory outright ("it would expose every user's email to every user"), and
 * the API enforces that by answering a generic 404 and rate-limiting per
 * caller — a speculative-lookup-on-keystroke UI would rebuild the enumerator on
 * the client and burn that budget doing it.
 *
 * A 404 from the add call therefore renders the API's own generic message, and
 * this component adds nothing to it — no "did you mean", no "that user is
 * deactivated". A 429 renders as the plain "wait a few minutes" the server
 * sends, because the rate limit is a real answer and not a bug to hide.
 *
 * =============================================================================
 * THE VISIBILITY NOTE IS NOT DECORATION
 * =============================================================================
 *
 * The line about the audio and the transcript becoming visible is a required
 * element of this dialog, not a nicety: the product's stated privacy stance is
 * that a recording is a private conversation, and the one screen where a user
 * ends that privacy for a specific person must say so in plain words before
 * they click. It sits above the submit control, not in a tooltip.
 *
 * =============================================================================
 * FULL SCREEN ON PHONES
 * =============================================================================
 *
 * `down('sm')` — the same compact-window read `SettingsHub.tsx`, `AppBar.tsx`
 * and `BroadcastDetailDialog.tsx` use, and one of the five coupled breakpoint
 * gates CLAUDE.md's Settings UI Pattern rule 5 names. The boundary is `sm`
 * (600px), never `md`: gating at 900px would hand the phone treatment to
 * tablets and landscape phones.
 */

import { useCallback, useEffect, useId, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { ApiError } from '../../services/api';
import {
  addShare,
  getShares,
  removeShare,
  shareDisplayLabel,
  shareRoleDescription,
  updateShareRole,
  type TranscriptShare,
  type TranscriptShareRole,
} from '../../services/transcriptShares';

export interface ShareDialogProps {
  open: boolean;
  transcriptId: string;
  /** Shown in the title so the owner knows which recording they are sharing. */
  transcriptTitle: string;
  onClose: () => void;
  /**
   * Called after any change that altered the share list.
   *
   * Optional, and the dialog works without it — it exists so a parent that
   * renders a "shared with N people" affordance can refresh without polling.
   */
  onSharesChanged?: (shares: TranscriptShare[]) => void;
}

/** The two role options, in the order the select offers them. */
const ROLE_OPTIONS: ReadonlyArray<{ value: TranscriptShareRole; label: string }> = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
];

/**
 * The message to show for a thrown error.
 *
 * ⚠ THE SERVER'S OWN WORDING IS PREFERRED FOR EVERY `ApiError`, including 404
 * and 429. Those two are not failures of this dialog — they are the answers the
 * sharing design deliberately produces, and rewording them here would either
 * leak more than the server chose to say or contradict it.
 */
export function shareErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.message.trim().length > 0) return error.message;

  if (error instanceof Error && error.message.trim().length > 0) return error.message;

  return fallback;
}

export function ShareDialog({
  open,
  transcriptId,
  transcriptTitle,
  onClose,
  onSharesChanged,
}: ShareDialogProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const titleId = useId();
  const emailFieldId = useId();

  const [shares, setShares] = useState<TranscriptShare[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TranscriptShareRole>('viewer');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /** The userId of the row whose role or removal is in flight, if any. */
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const publish = useCallback(
    (next: TranscriptShare[]) => {
      setShares(next);
      onSharesChanged?.(next);
    },
    [onSharesChanged],
  );

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    // Reset every transient piece of state on each open. A dialog that
    // remembered the last typed address, or the error from the last attempt,
    // would show the previous owner's mistake to the next transcript.
    setEmail('');
    setRole('viewer');
    setFormError(null);
    setRowError(null);
    setBusyUserId(null);
    setLoadError(null);
    setIsLoading(true);

    getShares(transcriptId)
      .then((items) => {
        if (cancelled) return;

        setShares(items);
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        setLoadError(shareErrorMessage(error, 'Could not load who this is shared with.'));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, transcriptId]);

  const handleAdd = async (): Promise<void> => {
    const address = email.trim();

    if (address.length === 0) {
      setFormError('Enter the email address of the person to share with.');

      return;
    }

    setIsSubmitting(true);
    setFormError(null);
    setRowError(null);

    try {
      const created = await addShare(transcriptId, { email: address, role });

      // Replace-or-append rather than append: the API updates an existing
      // share instead of failing, so an owner re-typing an address already on
      // the list must not produce two rows for one person.
      publish([
        ...shares.filter((share) => share.userId !== created.userId),
        created,
      ]);
      setEmail('');
    } catch (error) {
      setFormError(shareErrorMessage(error, 'Could not share this transcript.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRoleChange = async (
    share: TranscriptShare,
    nextRole: TranscriptShareRole,
  ): Promise<void> => {
    if (nextRole === share.role) return;

    setBusyUserId(share.userId);
    setRowError(null);

    try {
      const updated = await updateShareRole(transcriptId, share.userId, nextRole);

      publish(shares.map((row) => (row.userId === share.userId ? updated : row)));
    } catch (error) {
      setRowError(shareErrorMessage(error, 'Could not change that role.'));
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (share: TranscriptShare): Promise<void> => {
    setBusyUserId(share.userId);
    setRowError(null);

    try {
      await removeShare(transcriptId, share.userId);

      publish(shares.filter((row) => row.userId !== share.userId));
    } catch (error) {
      setRowError(shareErrorMessage(error, 'Could not remove that person.'));
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={isCompactWindow}
      aria-labelledby={titleId}
    >
      <DialogTitle id={titleId}>Share “{transcriptTitle}”</DialogTitle>

      <DialogContent dividers>
        <Stack spacing={2}>
          {/* ------------------------------------------------------------------
              THE VISIBILITY NOTE. Above the controls, in plain words, never in
              a tooltip: this is the moment a private conversation stops being
              private to one person, and the owner is told exactly what they
              are handing over before they hand it over.
              --------------------------------------------------------------- */}
          <Alert severity="info" icon={<LockOutlinedIcon fontSize="inherit" />}>
            Anyone you add here can play the original audio and read the full
            transcript of this conversation. Only you can delete it, or change
            and remove these people’s access.
          </Alert>

          <Box
            component="form"
            onSubmit={(event) => {
              event.preventDefault();

              void handleAdd();
            }}
          >
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1.5}
              sx={{ alignItems: { sm: 'flex-start' } }}
            >
              <TextField
                id={emailFieldId}
                label="Email address"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                fullWidth
                size="small"
                autoComplete="off"
                disabled={isSubmitting}
                error={Boolean(formError)}
                // The helper text carries the shape of the rule rather than a
                // list of who exists — there is no directory to browse here.
                helperText="They need an account with this exact address."
                slotProps={{ htmlInput: { 'aria-label': 'Email address' } }}
              />
              {/* NATIVE, not MUI's popover select. Two reasons, and both are
                  about the people using this: a native control is what a phone
                  renders as its own wheel picker, and it is operable by every
                  assistive technology without MUI's listbox choreography. */}
              <TextField
                select
                label="Role"
                value={role}
                onChange={(event) => setRole(event.target.value as TranscriptShareRole)}
                size="small"
                disabled={isSubmitting}
                // ⚠ THE `aria-label` GOES THROUGH `slotProps.select.inputProps`,
                // not through the TextField's own `inputProps`: with a native
                // select there is no `input` element for the latter to land on,
                // so it would silently label nothing.
                slotProps={{
                  select: { native: true, inputProps: { 'aria-label': 'Role' } },
                  inputLabel: { shrink: true },
                }}
                sx={{ minWidth: { sm: 140 }, width: { xs: '100%', sm: 'auto' } }}
              >
                {ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </TextField>
              <Button
                type="submit"
                variant="contained"
                disabled={isSubmitting}
                sx={{ width: { xs: '100%', sm: 'auto' }, flexShrink: 0 }}
              >
                {isSubmitting ? 'Sharing…' : 'Share'}
              </Button>
            </Stack>

            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              {shareRoleDescription(role)}
            </Typography>

            {formError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {formError}
              </Alert>
            )}
          </Box>

          <Divider />

          <Box>
            <Typography variant="overline" color="text.secondary">
              Shared with
            </Typography>

            {isLoading && (
              <Stack sx={{ py: 3, alignItems: 'center' }}>
                <CircularProgress size={24} aria-label="Loading shares" />
              </Stack>
            )}

            {loadError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {loadError}
              </Alert>
            )}

            {rowError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {rowError}
              </Alert>
            )}

            {!isLoading && !loadError && shares.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                This transcript is not shared with anyone yet.
              </Typography>
            )}

            {shares.length > 0 && (
              <List disablePadding>
                {shares.map((share) => (
                  <ListItem
                    key={share.userId}
                    disableGutters
                    sx={{
                      flexWrap: 'wrap',
                      gap: 1,
                      alignItems: { xs: 'flex-start', sm: 'center' },
                    }}
                    secondaryAction={null}
                  >
                    <ListItemText
                      primary={shareDisplayLabel(share)}
                      // The address is always shown beneath the name, because
                      // two colleagues can share a display name and the owner
                      // is about to decide whether to revoke one of them.
                      secondary={share.displayName ? share.email : null}
                      sx={{ flex: '1 1 200px', my: 0 }}
                    />
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <TextField
                        select
                        size="small"
                        value={share.role}
                        onChange={(event) =>
                          void handleRoleChange(
                            share,
                            event.target.value as TranscriptShareRole,
                          )
                        }
                        disabled={busyUserId === share.userId}
                        slotProps={{
                          select: {
                            native: true,
                            inputProps: {
                              'aria-label': `Role for ${shareDisplayLabel(share)}`,
                            },
                          },
                        }}
                        sx={{ minWidth: 120 }}
                      >
                        {ROLE_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </TextField>
                      <Tooltip title="Remove access">
                        {/* The span keeps the tooltip alive while the button is
                            disabled mid-request — a disabled button fires no
                            pointer events of its own. */}
                        <span>
                          <IconButton
                            edge="end"
                            aria-label={`Remove ${shareDisplayLabel(share)}`}
                            disabled={busyUserId === share.userId}
                            onClick={() => void handleRemove(share)}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </ListItem>
                ))}
              </List>
            )}
          </Box>
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}

export default ShareDialog;

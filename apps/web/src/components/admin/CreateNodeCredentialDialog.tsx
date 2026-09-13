/**
 * Admin → Worker Nodes → "New credential" (issue #271, epic #254).
 *
 * Modelled on `components/settings/CreatePatDialog.tsx` — same shape, same
 * validate-then-submit flow, same "reset the form and hand the response
 * upward" ending — because an operator who has created a personal access token
 * should not have to learn a second dialog to create a node credential.
 *
 * =============================================================================
 * WHY THIS IS NOT `CreatePatDialog` WITH DIFFERENT COPY
 * =============================================================================
 *
 * Reusing that component was the first thing tried, and the request bodies make
 * it impossible without lying to one of the two APIs. A PAT MUST expire —
 * `PersonalAccessToken.expiresAt` is a required column — so `CreatePatDialog`
 * collects a MANDATORY `{ durationValue, durationUnit }` pair and has no way to
 * express "no expiry". A node credential's expiry is OPTIONAL, and its absence
 * is the INTENDED DEFAULT: `create-node-credential.dto.ts` writes out why in
 * full — a worker node runs unattended for months, and a mandatory expiry turns
 * a fleet going dark at 3am into the default behaviour rather than an incident.
 * Revocation, not a clock, is the control.
 *
 * So the two dialogs collect genuinely different things, and the difference is
 * the most consequential decision on either form. Bending `CreatePatDialog` to
 * carry an optional expiry would have meant a `neverExpires` prop that changes
 * what its other three props mean — and a form where the PAT path and the node
 * path can each be broken by a change made for the other.
 *
 * The unit is DAYS ONLY, not the PAT's minutes/days/months menu, and that is
 * the API's shape rather than a simplification: `expiresInDays` is the only
 * field the schema has. A credential measured in minutes is not a use case
 * anybody has for an unattended machine, and offering a unit the endpoint
 * cannot take would be a control that lies.
 *
 * =============================================================================
 * "NEVER EXPIRES" IS THE DEFAULT, AND IT IS SPELLED OUT
 * =============================================================================
 *
 * The radio pair states both options in full rather than making "never" the
 * empty state of a days field. An operator must not be able to mint a
 * permanent credential by leaving a box blank and not noticing: the choice is
 * the one thing on this form worth being deliberate about, so it is asked as a
 * question with two written answers, the default is the one the API documents
 * as intended, and the consequence of each is printed underneath.
 */

import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import {
  MAX_NODE_CREDENTIAL_DAYS,
  MAX_NODE_CREDENTIAL_NAME_LENGTH,
} from '../../services/nodes';
import type { CreateNodeCredentialInput, NodeCredentialCreated } from '../../services/nodes';

interface CreateNodeCredentialDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the response — INCLUDING the raw token — on success. */
  onCreated: (response: NodeCredentialCreated) => void;
  /**
   * Resolves the created credential, or `null` when the create failed.
   *
   * `null` rather than a rejection, because that is the contract every hook in
   * this app follows (`useNodeActions`): a failure is a value a click handler
   * branches on, not an exception it has to catch.
   */
  onCreate: (input: CreateNodeCredentialInput) => Promise<NodeCredentialCreated | null>;
}

/** How the operator answered the expiry question. */
type ExpiryMode = 'never' | 'days';

const DEFAULT_DAYS = '90';

export function CreateNodeCredentialDialog({
  open,
  onClose,
  onCreated,
  onCreate,
}: CreateNodeCredentialDialogProps) {
  const [name, setName] = useState('');
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>('never');
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => {
    setName('');
    setExpiryMode('never');
    setDays(DEFAULT_DAYS);
    setError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmed = name.trim();
    // Validated here as well as on the server, and the bounds are the SCHEMA'S
    // — 1..100 characters, 1..3650 days — read from the constants this app
    // mirrors rather than invented. A client-side rule stricter than the
    // server's would forbid a credential the API would have accepted; a looser
    // one just moves the error message somewhere less helpful.
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    if (trimmed.length > MAX_NODE_CREDENTIAL_NAME_LENGTH) {
      setError(`Name must be at most ${MAX_NODE_CREDENTIAL_NAME_LENGTH} characters`);
      return;
    }

    let expiresInDays: number | undefined;
    if (expiryMode === 'days') {
      const parsed = Number.parseInt(days, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_NODE_CREDENTIAL_DAYS) {
        setError(`Expiry must be a whole number of days between 1 and ${MAX_NODE_CREDENTIAL_DAYS}`);
        return;
      }
      expiresInDays = parsed;
    }

    setIsSubmitting(true);
    try {
      // `expiresInDays` is left OFF the object when the answer is "never",
      // rather than sent as `undefined` or `null`. The schema's field is
      // optional and its ABSENCE is what the server reads as "no expiry" — an
      // explicit null would be a validation failure expressing the same intent.
      const response = await onCreate(
        expiresInDays === undefined ? { name: trimmed } : { name: trimmed, expiresInDays },
      );
      if (!response) {
        // The hook has already put the reason in the page's error banner. The
        // dialog stays OPEN with the form intact so the operator can fix and
        // retry rather than retyping.
        return;
      }
      reset();
      onCreated(response);
      onClose();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <form onSubmit={handleSubmit}>
        <DialogTitle>Create node credential</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {error}
              </Alert>
            )}

            <TextField
              label="Credential name"
              fullWidth
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={isSubmitting}
              slotProps={{ htmlInput: { maxLength: MAX_NODE_CREDENTIAL_NAME_LENGTH } }}
              placeholder="e.g. build-box-01, gpu-runner-eu"
              helperText="Shown in the credential list. Name it after the machine it will run on."
              sx={{ mb: 2 }}
            />

            <FormControl sx={{ mb: 1 }}>
              <FormLabel id="node-credential-expiry-label">Expiry</FormLabel>
              <RadioGroup
                aria-labelledby="node-credential-expiry-label"
                value={expiryMode}
                onChange={(event) => setExpiryMode(event.target.value as ExpiryMode)}
              >
                <FormControlLabel
                  value="never"
                  control={<Radio disabled={isSubmitting} />}
                  label="Never expires (revoke it to cut the node off)"
                />
                <FormControlLabel
                  value="days"
                  control={<Radio disabled={isSubmitting} />}
                  label="Expires after a number of days"
                />
              </RadioGroup>
            </FormControl>

            {expiryMode === 'days' && (
              <TextField
                label="Days"
                type="number"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                disabled={isSubmitting}
                slotProps={{
                  htmlInput: { min: 1, max: MAX_NODE_CREDENTIAL_DAYS, step: 1 },
                }}
                sx={{ mb: 1 }}
              />
            )}

            <Typography variant="body2" color="text.secondary">
              {expiryMode === 'never'
                ? 'The intended default for an unattended worker: a credential that expires ' +
                  'at 3am takes the fleet down with it. Revoke it here when the machine is ' +
                  'retired or compromised.'
                : 'The node stops authenticating the moment this elapses, with no warning and ' +
                  'no renewal. Only choose this for a machine you know is temporary.'}
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create credential'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

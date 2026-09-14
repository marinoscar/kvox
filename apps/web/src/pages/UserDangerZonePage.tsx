/**
 * Settings → Delete My Data (`/settings/danger-zone`).
 *
 * Issue #80. A card in `config/userSettingsSections.tsx`'s `Danger Zone` group
 * and a route in `App.tsx` — a registry destination, never a free route
 * (CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1), which is also what
 * gives this page its AppBar drill-down title and its position in the hub for
 * free.
 *
 * =============================================================================
 * TWO LAYERS, VISUALLY SEPARATED — THE PRODUCT DECISION ON THIS ISSUE
 * =============================================================================
 *
 * The page is not a list of five equivalent buttons. It is two layers, and the
 * gap between them is the design:
 *
 *   LAYER 1, "Delete specific data" — three targeted actions (recordings,
 *   notes, files), each carrying its own live count and size. This is the layer
 *   someone actually needs: "I uploaded forty hours of meetings I should not
 *   have kept." Showing the count and the size next to each is what turns an
 *   abstract, frightening button into a decision a person can check against
 *   what they believe they have — and a row whose count is zero has nothing to
 *   delete, so its button is disabled rather than offering an action whose only
 *   possible outcome is a no-op.
 *
 *   LAYER 2, "Danger zone" — the two compound actions, below a `Divider` and an
 *   error-coloured heading. They are separated because they are not "the same
 *   thing but more": `everything` also destroys the personal access tokens a
 *   user's scripts authenticate with, which is a consequence outside this
 *   page's apparent subject and the one most likely to be discovered by a
 *   cron job failing at 3am.
 *
 * ⚠ REJECTED: one scope picker (a `Select`, or radio buttons) feeding one
 * button. It is less code and strictly worse here: it makes the five actions
 * look interchangeable, hides each one's blast radius behind a dropdown the
 * user has to open to compare, and puts the narrowest and the widest action one
 * keystroke apart under a single button whose label never changes.
 *
 * =============================================================================
 * NEITHER ACTION DELETES THE ACCOUNT, AND THE PAGE SAYS SO IN WORDS
 * =============================================================================
 *
 * "Delete everything" is exactly the phrase a user reads as "and my account",
 * and a page that left that unanswered would make its safest honest action feel
 * like its most dangerous. So the account's survival, the fact that the session
 * continues, and the access-token consequence are stated in the page body AND
 * again in the dialog — not once, in a tooltip. `UserDataDeleteDialog` carries
 * the per-scope wording; see its header for why the force semantics are
 * repeated for every scope rather than only the compound ones.
 *
 * =============================================================================
 * WHILE A DELETION RUNS, EVERY BUTTON IS OFF — AND THE WORK IS NOT THIS TAB'S
 * =============================================================================
 *
 * `summary.activeDeletion` is the single disabling condition. The API refuses a
 * concurrent deletion with a **409**, so a page that left the buttons live
 * would be offering actions whose only outcome is an error message. The inline
 * `Alert` names the scope in flight, says the counts refresh by themselves, and
 * says the work continues if the page is closed — all three are true (it is a
 * background queue job, polled by `useUserData`), and the last one is the fact
 * a user staring at a spinner most needs, because the alternative belief is
 * that closing the tab leaves their data half-deleted.
 *
 * =============================================================================
 * NO PERMISSION IS CHECKED HERE, DELIBERATELY
 * =============================================================================
 *
 * `apps/api/src/user-data/`'s controller gates both routes on `@Auth()` and no
 * permission: the resource is the caller's OWN data, scoped by `userId` in the
 * query itself — the same posture `ai-credentials.controller.ts` and
 * `/api/user-settings` take. Like every other card in `USER_SETTINGS_SECTIONS`,
 * this one declares no `permission`, and the route carries no
 * `RequirePermission`. Inventing a gate here would be an authorization rule the
 * API does not enforce, and the direction it would fail in is the wrong one:
 * a user locked out of deleting data this deployment is holding about them.
 */

import { useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Container,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import { useUserData } from '../hooks/useUserData';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { UserDataDeleteDialog } from '../components/settings/UserDataDeleteDialog';
import type { UserDataScope, UserDataSummary } from '../services/userData';
import { formatBytes } from '../utils/transcriptDisplay';

/**
 * A byte count from this API, rendered for a person.
 *
 * The API sends decimal STRINGS because it sums Postgres `BIGINT` columns (see
 * `services/userData.ts`'s header). `formatBytes` is reused rather than
 * reimplemented — a third copy of the unit loop in this repository is not worth
 * avoiding one `Number()` call — and the parse is the only thing added: a value
 * that is absent or unparseable renders as an em dash rather than a confident
 * "0 B", because a zero here would read as "you have nothing stored" next to a
 * button that deletes something.
 *
 * ⚠ The `Number()` can lose integer precision above 2^53, and that is accepted
 * deliberately: the loss lands far below the one significant decimal a
 * human-readable "9.2 EB" shows, and this value is never sent back, compared or
 * summed — it is formatted and discarded.
 */
export function formatDataSize(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  return formatBytes(bytes);
}

/** One row of layer 1: what it is, which scope deletes it, and where to read its numbers. */
interface CategoryRow {
  scope: Extract<UserDataScope, 'transcripts' | 'notes' | 'files'>;
  title: string;
  description: string;
  buttonLabel: string;
  read: (summary: UserDataSummary) => { count: number; bytes: string };
  /** The noun to count, singular and plural — "1 recording", "4 recordings". */
  unit: [singular: string, plural: string];
  /**
   * A second line for something this scope also destroys that its own count
   * does not cover. Exists for exactly one row — see the `notes` row below.
   */
  addendum?: (summary: UserDataSummary) => string | null;
}

/**
 * The three targeted rows, in the order the data is created: a recording comes
 * first, a note is generated from one, and a standalone upload is the leftover
 * case. Declared as data rather than three copies of the same JSX so the row
 * markup — and therefore the disabled rule, the accessible name and the
 * responsive layout — exists exactly once.
 */
const CATEGORY_ROWS: CategoryRow[] = [
  {
    scope: 'transcripts',
    title: 'Recordings & transcripts',
    description:
      'Uploaded audio, its transcript, your corrections, the version history, exports and shares.',
    buttonLabel: 'Delete recordings',
    read: (summary) => summary.transcripts,
    unit: ['recording', 'recordings'],
  },
  {
    scope: 'notes',
    title: 'Notes',
    // ⚠ TEMPLATES GO WITH THE NOTES. `scopeIncludes` in
    // `apps/api/src/user-data/job-types.ts` maps the `noteTemplates` category
    // onto the `notes` scope — a template is the recipe a note was generated
    // from — and nothing about the word "Notes" says so. It is stated here, and
    // again in the dialog, because this row's own count cannot show it.
    description:
      'Generated notes, their full version history, any exports of them, and your own custom note templates. Built-in templates are unaffected.',
    buttonLabel: 'Delete notes',
    read: (summary) => summary.notes,
    unit: ['note', 'notes'],
    addendum: (summary) => {
      const { count } = summary.noteTemplates;
      if (count <= 0) return null;
      return `Also deletes ${count} custom ${count === 1 ? 'template' : 'templates'}.`;
    },
  },
  {
    scope: 'files',
    title: 'Uploaded files',
    description:
      'Files you uploaded to storage directly. Audio and source documents belonging to a recording or a note are not included here, and neither are note templates.',
    buttonLabel: 'Delete files',
    read: (summary) => summary.files,
    unit: ['file', 'files'],
  },
];

/** How each scope is named in the "deletion in progress" alert. */
const SCOPE_LABELS: Record<UserDataScope, string> = {
  transcripts: 'recordings and transcripts',
  notes: 'notes',
  files: 'uploaded files',
  content: 'all content',
  everything: 'everything',
};

/**
 * "4 recordings · 1.2 GB", or "No notes stored" — never a bare "0".
 *
 * The empty case names the CATEGORY rather than saying "Nothing stored",
 * because the `notes` row can be empty and still have an addendum below it
 * ("Also deletes 3 custom templates"), and a flat "Nothing stored" directly
 * above that line would contradict it.
 */
function describeCategory(
  count: number,
  bytes: string,
  [singular, plural]: [string, string],
): string {
  if (count <= 0) return `No ${plural} stored`;
  const noun = count === 1 ? singular : plural;
  return `${count} ${noun} · ${formatDataSize(bytes)}`;
}

export default function UserDangerZonePage() {
  const {
    summary,
    isLoading,
    loadError,
    isDeleting,
    deleteError,
    requestDeletion,
    clearDeleteError,
    isDeletionActive,
  } = useUserData();

  // `null` closes the dialog; a scope opens it for that scope. One piece of
  // state for all five actions, so two dialogs can never be open at once and
  // the typed confirmation always belongs to the scope on screen.
  const [pendingScope, setPendingScope] = useState<UserDataScope | null>(null);

  // Before any chrome: a page that rendered its buttons over an unknown summary
  // would briefly show every count as zero, which is both wrong and, on this
  // page specifically, reassuring in the wrong direction.
  if (isLoading) return <LoadingSpinner />;

  const activeDeletion = summary?.activeDeletion ?? null;
  // One flag for every control: a request in flight, or a job already running.
  const controlsDisabled = isDeleting || isDeletionActive || !summary;

  const closeDialog = () => {
    setPendingScope(null);
    clearDeleteError();
  };

  const confirmDialog = async () => {
    if (!pendingScope) return;
    const started = await requestDeletion(pendingScope);
    // Only close on success. A failure — most often the 409 that says another
    // deletion is already running — is rendered inside the dialog the user is
    // looking at; closing would throw away the only explanation they get.
    if (started) setPendingScope(null);
  };

  return (
    <Container maxWidth="md">
      <Box sx={{ py: 4 }}>
        {/* The `h1`, the description below it, and the registry card's title
            and description are deliberately the same strings, so the hub card,
            the compact AppBar title (#95) and this heading all name the page
            identically. */}
        <Typography variant="h4" component="h1" gutterBottom>
          Delete My Data
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Permanently delete the recordings, notes and files stored for your account. Your
          account itself is never deleted here.
        </Typography>

        {loadError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            <AlertTitle>Could not load your data</AlertTitle>
            {loadError}
          </Alert>
        )}

        {activeDeletion && (
          <Alert severity="info" sx={{ mb: 3 }}>
            <AlertTitle>Deletion in progress</AlertTitle>
            Deleting {SCOPE_LABELS[activeDeletion.scope]}. This runs in the background and
            continues even if you close this page. The counts below refresh by themselves as
            the work completes.
          </Alert>
        )}

        {deleteError && !pendingScope && (
          <Alert severity="error" sx={{ mb: 3 }} onClose={clearDeleteError}>
            <AlertTitle>Could not start the deletion</AlertTitle>
            {deleteError}
          </Alert>
        )}

        {/* ---------------------------------------------------------------
            LAYER 1 — the targeted actions, each with its own live numbers.
            --------------------------------------------------------------- */}
        <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 4 }}>
          <Typography variant="h6" component="h2" gutterBottom>
            Delete specific data
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Delete one kind of data and keep the rest. Each of these is permanent.
          </Typography>

          <Stack divider={<Divider />} spacing={0}>
            {CATEGORY_ROWS.map((row) => {
              const stats = summary ? row.read(summary) : { count: 0, bytes: '0' };
              const addendum = summary ? (row.addendum?.(summary) ?? null) : null;
              // "Nothing stored" is about THIS row's own count. A user with no
              // notes but three templates still has something the `notes` scope
              // would delete, so the button stays live when the addendum does.
              const isEmpty = stats.count <= 0 && !addendum;

              return (
                <Box
                  key={row.scope}
                  sx={{
                    display: 'flex',
                    // Stacks on a phone, sits side by side from `sm` up. The
                    // button goes full width when stacked so it is not a
                    // thumb-sized target floating in a wide row.
                    flexDirection: { xs: 'column', sm: 'row' },
                    alignItems: { xs: 'stretch', sm: 'center' },
                    justifyContent: 'space-between',
                    gap: 2,
                    py: 2,
                  }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" component="h3">
                      {row.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {describeCategory(stats.count, stats.bytes, row.unit)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                      {row.description}
                    </Typography>
                    {addendum && (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {addendum}
                      </Typography>
                    )}
                  </Box>
                  <Button
                    variant="outlined"
                    color="error"
                    // Nothing stored means nothing to delete: the button would
                    // be an action with no possible effect.
                    disabled={controlsDisabled || isEmpty}
                    onClick={() => setPendingScope(row.scope)}
                    sx={{ flexShrink: 0, alignSelf: { xs: 'stretch', sm: 'center' } }}
                  >
                    {row.buttonLabel}
                  </Button>
                </Box>
              );
            })}
          </Stack>
        </Paper>

        {/* ---------------------------------------------------------------
            LAYER 2 — the compound actions. Separated by a divider and an
            error-coloured heading because `everything` reaches outside this
            page's apparent subject and takes credentials with it.
            --------------------------------------------------------------- */}
        <Divider sx={{ my: 3 }} />

        <Typography variant="h6" component="h2" gutterBottom color="error">
          Danger zone
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          <strong>Delete all content</strong> removes every recording, transcript, note, note
          template and uploaded file. Your account, profile, settings and access tokens are
          kept.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          <strong>Delete everything</strong> removes all of that and also your stored AI
          provider keys and every personal access token you have created — any CLI or script
          using one stops working immediately. Your account is still <strong>not</strong>{' '}
          deleted, and you stay signed in.
        </Typography>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button
            variant="outlined"
            color="error"
            disabled={controlsDisabled}
            onClick={() => setPendingScope('content')}
          >
            Delete all content
          </Button>
          <Button
            variant="outlined"
            color="error"
            disabled={controlsDisabled}
            onClick={() => setPendingScope('everything')}
          >
            Delete everything
          </Button>
        </Stack>

        <UserDataDeleteDialog
          scope={pendingScope}
          isWorking={isDeleting}
          error={deleteError}
          onConfirm={() => void confirmDialog()}
          onClose={closeDialog}
        />
      </Box>
    </Container>
  );
}

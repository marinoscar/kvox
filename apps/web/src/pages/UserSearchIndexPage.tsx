/**
 * Settings → Search Indexing (`/settings/search-index`).
 *
 * Issue #191, epic #165 — the last issue in the epic, and the one that makes
 * the rest of it visible. A card in `config/userSettingsSections.tsx`'s
 * `Account` group and a route in `App.tsx` — a registry destination, never a
 * free route (CLAUDE.md's "MANDATORY: Settings UI Pattern" rule 1), which is
 * also what gives this page its AppBar drill-down title and its position in the
 * hub for free. It is a DESTINATION rather than a tab on an existing settings
 * page (rule 2), and it adds a card to the shared `SettingsHub` binding rather
 * than forking anything (rule 4). None of the five coupled breakpoint gates
 * (rule 5) is touched: this page mounts no app chrome.
 *
 * =============================================================================
 * WHY THIS IS A PER-USER PAGE AND NOT AN ADMIN ONE
 * =============================================================================
 *
 * THE KEY IS THE USER'S, THE CONTENT IS THE USER'S, AND THE BILL IS THE USER'S.
 *
 * Epic #45 is strict bring-your-own-key: this deployment holds no AI key of its
 * own, and `SearchIndexHandler` resolves the key from the DOCUMENT'S OWNER —
 * never from whoever queued the job. So an administrator pressing "Index the
 * library" on somebody else's behalf would be spending that person's money on
 * that person's private recordings, and with no deployment key to fall back on
 * it could not even work. There is no `search_index:read_any` and there is no
 * admin card, the same posture `transcripts:read_any` and `notes:read_any` were
 * deliberately never created with.
 *
 * That is also why there is no backfill cron anywhere in this epic
 * (`apps/api/src/search/indexing/job-types.ts` carries the full argument): a
 * timer that re-indexes a "stale-looking" corpus bills a person who pressed no
 * button, at an hour they are asleep, for an amount nothing in the UI
 * predicted. Indexing is an EXPLICIT ACTION — and an explicit action needs
 * somewhere to be taken, which is this page.
 *
 * =============================================================================
 * THE COST SENTENCE IS THE ONE THING ON THIS PAGE THAT MUST NOT BE SOFTENED
 * =============================================================================
 *
 * The primary action spends money on an account this application does not own
 * and cannot see the balance of. So the sentence naming whose account pays sits
 * directly under the button, in the page's own voice, not in a tooltip and not
 * in helper text under a field — the same decision `UserAiPage` makes about the
 * fact that generating a note runs on the user's key, and for the same reason:
 * it is the single most important fact here and the one most likely to be
 * misread.
 *
 * `UserSearchIndexPage.test.tsx` asserts the words "your own AI provider
 * account" and "billed to you" against the DOM, with those strings written out
 * in the test rather than imported from here. That is deliberate: a test that
 * imported the constant would keep passing while somebody quietly rewrote it
 * into "usage may apply".
 *
 * =============================================================================
 * "NOT INDEXED" IS THE NUMBER THIS PAGE EXISTS FOR
 * =============================================================================
 *
 * Four of the five per-type counts require an indexing record to exist. The
 * state a user most needs to see has none: a document that predates semantic
 * search, or one whose owner had no key when it arrived, was never queued and
 * therefore wrote no row. A table showing only the four would render an
 * entirely unsearchable library as "0 indexed, 0 pending, 0 failed" — three
 * zeroes that look like a healthy empty state and are in fact the whole
 * degradation. `Not indexed` is the column the button acts on, and it is
 * emphasised over the others for exactly that reason.
 *
 * =============================================================================
 * NO PERMISSION IS CHECKED HERE, DELIBERATELY
 * =============================================================================
 *
 * `search-index.controller.ts` gates both routes on `@Auth()` and no
 * permission: the resource is the caller's own content, scoped by `ownerId` in
 * the query itself. Like every other card in `USER_SETTINGS_SECTIONS`, this one
 * declares no `permission`, and the route carries no `RequirePermission`.
 * Inventing a gate here would be an authorization rule the API does not
 * enforce.
 */

import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Container,
  Divider,
  Link,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import ManageSearchIcon from '@mui/icons-material/ManageSearch';
import { Link as RouterLink } from 'react-router-dom';

import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { useSearchIndex } from '../hooks/useSearchIndex';
import {
  countNeedingIndex,
  describeIndexReason,
  describeUnavailableReason,
  DOCUMENT_TYPE_LABELS,
} from '../services/searchIndex';
import type { SearchIndexTypeCounts } from '../services/searchIndex';

/**
 * The five columns, declared as data so the row markup — and therefore the
 * emphasis rule and the accessible header association — exists exactly once.
 *
 * `Not indexed` is last and emphasised: it is the only one of the five that
 * describes an ABSENCE of a record, and it is what the button acts on.
 */
const COLUMNS: Array<{
  key: keyof Pick<
    SearchIndexTypeCounts,
    'indexed' | 'pending' | 'failed' | 'skipped' | 'unindexed'
  >;
  label: string;
  emphasise?: boolean;
}> = [
  { key: 'indexed', label: 'Indexed' },
  { key: 'pending', label: 'In progress' },
  { key: 'failed', label: 'Failed' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'unindexed', label: 'Not indexed', emphasise: true },
];

export default function UserSearchIndexPage() {
  const {
    status,
    isLoading,
    loadError,
    isIndexing,
    indexError,
    lastResult,
    requestIndex,
    clearIndexError,
    isRunning,
  } = useSearchIndex();

  if (isLoading) {
    return <LoadingSpinner />;
  }

  const unavailableReason = status ? describeUnavailableReason(status) : null;
  const outstanding = countNeedingIndex(status);
  // Disabled for a REASON THAT IS ALWAYS STATED. A control that is off with no
  // explanation is indistinguishable from a broken one — and here the two
  // possible reasons have different fixes and different people to talk to.
  const canIndex = Boolean(status) && unavailableReason === null;

  return (
    <Container maxWidth="md" sx={{ py: { xs: 2, md: 4 } }}>
      <Stack spacing={3}>
        <Box>
          <Typography variant="h5" component="h1" gutterBottom>
            Search indexing
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Semantic search finds a recording or a note by what it is about, not only by the
            words it happens to contain. It works on documents that have been indexed; anything
            below that is not indexed can still be found by keyword.
          </Typography>
        </Box>

        {loadError && <Alert severity="error">{loadError}</Alert>}

        {status && (
          <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h6" component="h2" gutterBottom>
              Your library
            </Typography>

            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Indexing status by document type">
                <TableHead>
                  <TableRow>
                    <TableCell component="th" scope="col">
                      Type
                    </TableCell>
                    {COLUMNS.map((column) => (
                      <TableCell key={column.key} component="th" scope="col" align="right">
                        {column.label}
                      </TableCell>
                    ))}
                    <TableCell component="th" scope="col" align="right">
                      Total
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {status.types.map((entry) => (
                    <TableRow key={entry.type}>
                      <TableCell component="th" scope="row">
                        {DOCUMENT_TYPE_LABELS[entry.type]?.plural ?? entry.type}
                      </TableCell>
                      {COLUMNS.map((column) => (
                        <TableCell
                          key={column.key}
                          align="right"
                          aria-label={`${DOCUMENT_TYPE_LABELS[entry.type]?.plural ?? entry.type} ${column.label}`}
                          sx={
                            column.emphasise && entry[column.key] > 0
                              ? { fontWeight: 600 }
                              : undefined
                          }
                        >
                          {entry[column.key]}
                        </TableCell>
                      ))}
                      <TableCell align="right">{entry.total}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>

            {status.model && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 2, display: 'block' }}>
                Indexed with {status.model}.
              </Typography>
            )}
          </Paper>
        )}

        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
          <Typography variant="h6" component="h2" gutterBottom>
            Index my library
          </Typography>

          {/* ⚠ THE COST SENTENCE. See the file header — this is the one piece of
              copy on the page that must not be softened, and the test asserts
              its words against the DOM. */}
          <Typography variant="body2" sx={{ mb: 2 }}>
            Indexing runs on <strong>your own AI provider account</strong>, using the key saved on
            your AI settings page. The embedding usage is <strong>billed to you</strong>, not to
            this deployment — which is also why nothing here ever starts indexing on its own.
          </Typography>

          {unavailableReason && (
            <Alert severity="info" sx={{ mb: 2 }}>
              <AlertTitle>Indexing is not available yet</AlertTitle>
              {unavailableReason}{' '}
              {status?.available === true && (
                <Link component={RouterLink} to="/settings/ai">
                  Add your AI provider key
                </Link>
              )}
            </Alert>
          )}

          {indexError && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={clearIndexError}>
              {indexError}
            </Alert>
          )}

          {lastResult && !indexError && (
            <Alert severity="success" sx={{ mb: 2 }}>
              {lastResult.queued === 0
                ? 'Everything in your library is already indexed or queued.'
                : `Queued ${lastResult.queued} document${lastResult.queued === 1 ? '' : 's'} for indexing.`}
              {lastResult.remaining > 0 &&
                ` ${lastResult.remaining} more will be queued the next time you press this — one press queues at most ${lastResult.cap}.`}
            </Alert>
          )}

          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            sx={{ alignItems: { sm: 'center' } }}
          >
            <Button
              variant="contained"
              startIcon={isIndexing ? <CircularProgress size={18} color="inherit" /> : <ManageSearchIcon />}
              disabled={!canIndex || isIndexing}
              onClick={() => void requestIndex()}
            >
              Index my library
            </Button>
            <Typography variant="body2" color="text.secondary">
              {outstanding > 0
                ? `${outstanding} document${outstanding === 1 ? '' : 's'} not indexed yet.`
                : 'Nothing is waiting to be indexed.'}
            </Typography>
          </Stack>

          {isRunning && (
            <Alert severity="info" icon={<CircularProgress size={18} />} sx={{ mt: 2 }}>
              Indexing is running. The numbers above refresh by themselves, and the work carries
              on if you close this page.
            </Alert>
          )}
        </Paper>

        {status && status.failures.length > 0 && (
          <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
            <Typography variant="h6" component="h2" gutterBottom>
              Documents that could not be indexed
            </Typography>
            <Typography variant="body2" color="text.secondary">
              These are still searchable by keyword. Pressing the button above tries them again.
            </Typography>
            <Divider sx={{ my: 2 }} />
            <List disablePadding>
              {status.failures.map((failure) => (
                <ListItem key={`${failure.type}:${failure.id}`} disableGutters alignItems="flex-start">
                  <ListItemText
                    primary={
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: 'center', flexWrap: 'wrap' }}
                      >
                        <Typography variant="subtitle2" component="span">
                          {failure.title}
                        </Typography>
                        <Chip
                          size="small"
                          label={DOCUMENT_TYPE_LABELS[failure.type]?.singular ?? failure.type}
                        />
                      </Stack>
                    }
                    // ⚠ PLAIN LANGUAGE, WITH THE RAW TOKEN AS THE FALLBACK. See
                    // `describeIndexReason`: `reason` is a growing text column,
                    // never an enum, so an unrecognised value is shown rather
                    // than swallowed — the failure worth reading is the one
                    // nobody has seen before.
                    secondary={
                      <>
                        {describeIndexReason(failure.reason)}
                        {failure.lastError && (
                          <Typography
                            variant="caption"
                            component="span"
                            color="text.secondary"
                            sx={{ display: 'block' }}
                          >
                            {failure.lastError}
                          </Typography>
                        )}
                      </>
                    }
                  />
                </ListItem>
              ))}
            </List>
          </Paper>
        )}
      </Stack>
    </Container>
  );
}

/**
 * Admin → Settings → About (`/admin/settings/about`).
 *
 * Issue #126, epic #118 (decision 8). A REGISTRY CARD and nothing else, per
 * `CLAUDE.md`'s MANDATORY Settings UI Pattern: one entry in `ADMIN_SECTIONS`
 * (`config/adminSections.tsx`), one route in `App.tsx` gated on the same
 * `system_settings:read` the API's `about.controller.ts` enforces, and no tab
 * anywhere. The hub, the Console rail and the compact AppBar title all pick
 * this page up from that single declaration.
 *
 * THREE SECTIONS IN ONE VERTICAL STACK, NOT THREE TABS. Nothing here is
 * parallel content — Application, Deployment and Server are three answers to
 * one question ("what is running here?"), read top to bottom, and an
 * administrator opening this page on a new server wants all three on one
 * screen rather than behind three clicks. A tab strip here would be the exact
 * mistake epic #90 undid on `SystemSettingsPage`.
 *
 * =============================================================================
 * EVERY TIMESTAMP IS UTC, THROUGH ONE HELPER
 * =============================================================================
 *
 * The owner asked for UTC: a server fact should read the same on every screen,
 * and "installed at 09:15" is a different claim in London than in Sydney. So
 * every timestamp on this page goes through `formatUtc` (`YYYY-MM-DD HH:mm:ss
 * UTC`) and NOTHING here calls `toLocaleString()`. The relative age beside it
 * ("3 hours ago") is computed against `runtime.serverTimeUtc` — the API's own
 * clock at the moment it answered — rather than the browser's, so a laptop
 * whose clock is an hour out does not show a deployment that "started in 58
 * minutes". Every row that carries a timestamp renders it in a `<time>`
 * element with the ISO value as `dateTime`, which is also what the page's
 * test enumerates to prove the rule holds for every row at once.
 *
 * =============================================================================
 * THE PAGE MUST RENDER ON A DEPLOYMENT THE CLI NEVER TOUCHED
 * =============================================================================
 *
 * The local dev stack and CI have no `deploy-info/info.json`, and the API
 * answers 200 with `deployInfoStatus: 'absent'` precisely so this card is
 * usable in the environment a contributor first opens it in. Application (the
 * running process's own facts) therefore ALWAYS renders; Deployment and Server
 * (facts the CLI recorded) are replaced by one Alert that says why they are
 * missing, with the API's own `detail` when the file exists but could not be
 * read.
 *
 * =============================================================================
 * THREE DEPLOYMENT-RECORD STATES, NOT TWO (issue #283)
 * =============================================================================
 *
 * This page once answered one question — is there a record? — and answered it
 * wrongly in both directions on the deployment that produced #283: a live
 * server the CLI had cloned, built, migrated, seeded, started and certificated,
 * whose install failed only at its very last action, AFTER the API was already
 * answering. The record was withheld, and the page said "this instance was not
 * deployed with the deploy CLI". Every word of that was false.
 *
 * So there are three states here now:
 *
 *   1. A record, and the run that wrote it finished — everything below,
 *      exactly as before.
 *   2. A record, and the run did NOT finish — THE SAME FULL DETAIL, plus a
 *      warning naming the step that stopped it. The facts are not degraded and
 *      not hidden: the CLI writes the record only once `/api/health/ready` has
 *      answered, so every one of them describes what is actually running. The
 *      warning is additional context, never a replacement for it.
 *   3. No record — wording that states what is KNOWN (nothing was found where
 *      the API looks) instead of asserting how the instance was deployed.
 *
 * TWO THINGS HERE ARE EASY TO GET WRONG, AND BOTH ARE THE BUG AGAIN:
 *
 *   * The warning branches on `about.deployRunComplete === false`, NEVER on
 *     `deployInfoStatus`. An incomplete run is `ok` — the record parsed
 *     perfectly. The four statuses answer "could the record be read"; this is
 *     a different question, and folding them together forces a choice between
 *     showing the facts and reporting the failure.
 *   * "Did it finish" is READ from the API, never re-derived from
 *     `deployInfo.run`. Every info.json already on every live server predates
 *     that block, and each was written only after a pipeline finished; the
 *     API's derivation is `run?.completed === false`, so absence reads as
 *     completed. A `run?.completed !== true` written here instead would report
 *     every one of those deployments as a failed deploy.
 *
 * NO POLL. This page changes only when somebody deploys; see `useAbout`.
 * Refresh is a button.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Container,
  IconButton,
  Link,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Navigate } from 'react-router-dom';
import { APP_NAME } from '@app/shared';
import { usePermissions } from '../../hooks/usePermissions';
import { useAbout } from '../../hooks/useAbout';
import { formatUtc } from '../../utils/formatUtc';
import { formatRelativeTime } from '../../utils/relativeTime';
import { formatBytes } from '../../utils/transcriptDisplay';
import type { AboutResponse, DeployInfo } from '../../types';

/** Mirrors the `About` card in `config/adminSections.tsx`, word for word. */
const PAGE_TITLE = 'About';
const PAGE_DESCRIPTION =
  'What is running here: version, revision, when it was installed and last updated, and the server it runs on.';

/**
 * How much of a SHA to show. Twelve, to match what the deploy CLI's `update --check`
 * prints (`current <sha12> → latest <sha12>`), so the terminal and this page
 * name the same revision the same way. The full SHA is one hover or one click
 * away — see `Revision`.
 */
const SHORT_SHA_LENGTH = 12;

/** What a missing fact renders as — the CLI could not tell, and the page says so rather than inventing. */
const UNKNOWN = '—';

// =============================================================================
// Row primitives
// =============================================================================

interface FactProps {
  label: string;
  children: ReactNode;
}

/**
 * One label/value pair in a section's `<dl>`.
 *
 * A DEFINITION LIST, not a table: these are facts with names, not rows with
 * columns, and `dt`/`dd` is what a screen reader announces as "term,
 * definition" rather than "row 3 of 12". Each pair sits in its own `<div>`,
 * which HTML permits inside a `dl` and which is what lets the pair stack on a
 * phone and sit side by side on a desktop without breaking the list's
 * semantics. The separator is a border rather than a `<Divider>`, because an
 * `<hr>` between `dt`/`dd` groups is exactly the invalid child axe's
 * `definition-list` rule exists to catch.
 */
function Fact({ label, children }: FactProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        gap: { xs: 0.25, sm: 2 },
        py: 1.25,
        borderBottom: 1,
        borderColor: 'divider',
        '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <Typography
        component="dt"
        variant="body2"
        color="text.secondary"
        sx={{ flex: { sm: '0 0 200px' } }}
      >
        {label}
      </Typography>
      <Typography
        component="dd"
        variant="body2"
        sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere', flex: 1 }}
      >
        {children}
      </Typography>
    </Box>
  );
}

interface SectionProps {
  title: string;
  children: ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <Paper component="section" sx={{ p: { xs: 2, sm: 3 } }}>
      <Typography variant="h6" component="h2" gutterBottom>
        {title}
      </Typography>
      <Box component="dl" sx={{ m: 0 }}>
        {children}
      </Box>
    </Paper>
  );
}

interface TimestampProps {
  iso: string | null | undefined;
  /** The instant to date the relative age against. Omit to show the absolute time alone. */
  now?: Date;
}

/**
 * `2026-09-15 18:02:11 UTC · 3 hours ago`, or the unknown mark.
 *
 * The `<time>` element is the page's timestamp CONTRACT made visible in the
 * DOM: the test enumerates every one and asserts it ends in ` UTC`, so a row
 * added later that reaches for `toLocaleString()` fails there rather than
 * shipping a local time between eleven UTC ones.
 */
function Timestamp({ iso, now }: TimestampProps) {
  if (!iso) return <>{UNKNOWN}</>;
  return (
    <>
      <time dateTime={iso}>{formatUtc(iso)}</time>
      {now && (
        <Typography component="span" variant="body2" color="text.secondary">
          {' · '}
          {formatRelativeTime(iso, now)}
        </Typography>
      )}
    </>
  );
}

/** Show something, or the unknown mark — never `null`, never `undefined`, never an empty cell. */
function orUnknown(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  return String(value);
}

/**
 * The short SHA, the full one on hover, and a button that copies the full
 * one. Copying the SHORT form would be the wrong default: the twelve
 * characters are for reading, and the reason anyone copies a revision is to
 * paste it into `git` or GitHub, where the whole thing is what disambiguates.
 */
function Revision({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Clipboard denied or unavailable (an insecure origin) — the full SHA is
      // still in the tooltip and the short one is selectable text.
    }
  };

  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', display: 'inline-flex' }}>
      <Tooltip title={sha}>
        <Typography component="code" sx={{ fontFamily: 'monospace' }}>
          {sha.slice(0, SHORT_SHA_LENGTH)}
        </Typography>
      </Tooltip>
      <Tooltip title={copied ? 'Copied' : 'Copy full revision'}>
        <IconButton size="small" onClick={() => void handleCopy()} aria-label="Copy revision">
          {copied ? (
            <CheckIcon fontSize="small" color="success" />
          ) : (
            <ContentCopyIcon fontSize="small" />
          )}
        </IconButton>
      </Tooltip>
    </Stack>
  );
}

/**
 * The repository, as TEXT unless it is an `https://` URL. A deploy-info file
 * can carry whatever `origin` said — `git@github.com:…`, a `file://` path in
 * CI — and turning an arbitrary string into a clickable link is how a page
 * ends up with an `<a href>` pointing at something a browser should not be
 * sent to.
 */
function Repository({ url }: { url: string | null | undefined }) {
  if (!url) return <>{UNKNOWN}</>;
  if (url.startsWith('https://')) {
    return (
      <Link href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </Link>
    );
  }
  return <>{url}</>;
}

// =============================================================================
// The Update row
// =============================================================================

interface UpdateStatusProps {
  about: AboutResponse;
  now: Date;
}

/**
 * `Up to date` / `N commits behind — checked 4 hours ago` / `Not checked yet`.
 *
 * Three states, not two, and the third is the one that matters most on a
 * fresh install: `updateAvailable` is `null` — UNKNOWN, not "no" — until
 * the deploy CLI's `update --check` has run at least once, and rendering that as
 * "Up to date" would tell an operator a deployment nobody has checked is
 * current. The chip is the warning colour and appears ONLY when the API says
 * an update exists; the API derives that from `remote.commitsBehind` so the
 * web page and the CLI's `about` command cannot disagree about it.
 */
function UpdateStatus({ about, now }: UpdateStatusProps) {
  const remote = about.deployInfo?.remote;
  if (about.updateAvailable === null || !remote) {
    return <>Not checked yet</>;
  }

  const behind = remote.commitsBehind ?? 0;
  const checked = about.checkedAt ? ` — checked ${formatRelativeTime(about.checkedAt, now)}` : '';

  if (!about.updateAvailable) {
    return <>Up to date{checked}</>;
  }

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <Chip size="small" color="warning" label="Update available" />
      <span>
        {behind} {behind === 1 ? 'commit' : 'commits'} behind{checked}
      </span>
    </Stack>
  );
}

// =============================================================================
// The three sections
// =============================================================================

interface ApplicationSectionProps {
  about: AboutResponse;
  now: Date;
}

function ApplicationSection({ about, now }: ApplicationSectionProps) {
  const { runtime, database, databaseError } = about;
  return (
    <Section title="Application">
      {/* The product name comes from the shared identity module, the same
          place the wordmark reads it from — never from the deploy-info file,
          which may be absent, and never typed here, where a rename would
          miss it. */}
      <Fact label="Name">{APP_NAME}</Fact>
      <Fact label="API version">{orUnknown(runtime.apiVersion)}</Fact>
      <Fact label="Environment">{orUnknown(runtime.environment)}</Fact>
      <Fact label="Node version">{orUnknown(runtime.nodeVersion)}</Fact>
      <Fact label="Process started">
        <Timestamp iso={runtime.processStartedAt} now={now} />
      </Fact>
      <Fact label="Server time">
        {/* "At last refresh", stated, because a clock rendered once and left
            on screen is a clock that is wrong a minute later. */}
        <Timestamp iso={runtime.serverTimeUtc} />
        <Typography component="span" variant="body2" color="text.secondary">
          {' · at last refresh'}
        </Typography>
      </Fact>
      {/* The database facts belong with the process, not the deployment:
          they are what THIS running API can see, and `databaseError` is the
          one thing an operator diagnosing a broken database needs the rest
          of this page for. */}
      <Fact label="Database">
        {database ? (
          <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace' }}>
            {database.serverVersion}
          </Typography>
        ) : (
          <Typography component="span" variant="body2" color="error.main">
            {databaseError ?? 'Unreachable'}
          </Typography>
        )}
      </Fact>
      {database && (
        <Fact label="Migrations">
          {database.appliedMigrations} applied
          {database.lastMigrationName && (
            <>
              {' · last '}
              <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace' }}>
                {database.lastMigrationName}
              </Typography>
              {database.lastMigrationAt && (
                <>
                  {' at '}
                  <Timestamp iso={database.lastMigrationAt} />
                </>
              )}
            </>
          )}
        </Fact>
      )}
    </Section>
  );
}

interface DeploymentSectionProps {
  about: AboutResponse;
  info: DeployInfo;
  now: Date;
}

function DeploymentSection({ about, info, now }: DeploymentSectionProps) {
  const deployedBy =
    info.deployedBy?.cli || info.deployedBy?.version
      ? `${info.deployedBy?.cli ?? UNKNOWN} ${info.deployedBy?.version ?? ''}`.trim()
      : UNKNOWN;

  return (
    <Section title="Deployment">
      <Fact label="Version">{orUnknown(info.app?.version)}</Fact>
      <Fact label="Revision">
        {info.app?.commitSha ? <Revision sha={info.app.commitSha} /> : UNKNOWN}
      </Fact>
      <Fact label="Ref">{orUnknown(info.app?.ref)}</Fact>
      <Fact label="Repository">
        <Repository url={info.app?.repoUrl} />
      </Fact>
      <Fact label="Installed">
        <Timestamp iso={info.installedAt} now={now} />
      </Fact>
      <Fact label="Last updated">
        <Timestamp iso={info.updatedAt} now={now} />
      </Fact>
      <Fact label="Last command">{orUnknown(info.lastCommand)}</Fact>
      <Fact label="Deployed by">{deployedBy}</Fact>
      <Fact label="Update">
        <UpdateStatus about={about} now={now} />
        <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Run <code>deploy update --check</code> with the deploy CLI on the server to refresh.
        </Typography>
      </Fact>
    </Section>
  );
}

function ServerSection({ info }: { info: DeployInfo }) {
  const host = info.host ?? {};
  const cpu =
    host.cpuModel || host.cpus
      ? `${host.cpuModel ?? UNKNOWN}${host.cpus ? ` × ${host.cpus}` : ''}`
      : UNKNOWN;

  return (
    <Section title="Server">
      <Fact label="Hostname">{orUnknown(host.hostname)}</Fact>
      <Fact label="Operating system">{orUnknown(host.os)}</Fact>
      <Fact label="Kernel">{orUnknown(host.kernel)}</Fact>
      <Fact label="Architecture">{orUnknown(host.arch)}</Fact>
      <Fact label="CPU">{cpu}</Fact>
      {/* `formatBytes` is the storage pages' own formatter (decimal units,
          "what a file manager shows"); it already renders the unknown mark
          for a non-number, so a null passes straight through it. */}
      <Fact label="Memory">{formatBytes(host.memoryBytes ?? NaN)}</Fact>
      <Fact label="Disk">{formatBytes(host.diskBytes ?? NaN)}</Fact>
      <Fact label="Docker">{orUnknown(host.dockerVersion)}</Fact>
      <Fact label="Compose">{orUnknown(host.composeVersion)}</Fact>
    </Section>
  );
}

/**
 * The warning that rides ABOVE the full deployment detail when the run that
 * wrote the record did not finish (issue #283).
 *
 * IT ADDS, IT DOES NOT REPLACE. The record is written from the `health` step
 * onward, so by the time this can render, the application has already answered
 * a readiness probe on the revision named below. Hiding or degrading those
 * facts would throw away the only accurate account of what is running, to warn
 * about a step that came after it.
 *
 * THE STEP ID IS RENDERED VERBATIM, in `code`, and never prettified: an
 * operator matches it against the CLI's own output and its `--resume`
 * behaviour, and a friendly rewording would break that match for no gain.
 *
 * THE TWO TIMESTAMPS ARE LABELLED APART. `deployAttemptedAt` is when the
 * unfinished run ENDED; the Deployment section's "Last updated" is
 * `deployInfo.updatedAt`, which keeps meaning THE LAST DEPLOY THAT SUCCEEDED —
 * on an update that failed past its health step the two genuinely differ,
 * while `app.commitSha` names the revision now serving. Two timestamps that
 * mean different things under one word is how this page would stop being
 * believed.
 */
function DeployRunIncomplete({ about, now }: { about: AboutResponse; now: Date }) {
  const step = about.deployFailedStep;

  return (
    <Alert severity="warning">
      <AlertTitle>The deploy run that wrote this record did not finish</AlertTitle>
      <Typography variant="body2" component="p" sx={{ m: 0 }}>
        {step ? (
          <>
            It stopped at the{' '}
            <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace' }}>
              {step}
            </Typography>{' '}
            step.{' '}
          </>
        ) : (
          <>It stopped before the end, and did not record which step. </>
        )}
        The record was written once the application was already answering, so the
        deployment details below describe what is running — but whatever that step
        would have done was not done.
      </Typography>
      {about.deployAttemptedAt && (
        <Typography variant="body2" component="p" sx={{ m: 0, mt: 1 }}>
          {'Run stopped: '}
          <Timestamp iso={about.deployAttemptedAt} now={now} />
          {'. “Last updated” below is a different instant — the last deploy that finished.'}
        </Typography>
      )}
    </Alert>
  );
}

/**
 * What stands in for Deployment and Server when the CLI's file is not there
 * to read. `absent` is the ordinary case; the other two are real problems and
 * carry the API's own `detail`, because "the file was invalid" without the
 * parse message sends the operator to a shell to find out what this page
 * already knew.
 *
 * THE `absent` COPY STATES WHAT IS KNOWN AND NOTHING MORE (issue #283). All
 * this status means is that there is no file where the API looks. That is
 * consistent with an instance deployed some other way — and equally with a
 * mis-set `DEPLOY_INFO_PATH`, a bind mount that did not attach, or a deploy
 * that stopped before the record was written. This page used to state the most
 * confident of those as fact, and was read by an administrator whose server the
 * CLI had in fact installed and certificated. It names the possibilities now
 * and asserts none of them.
 *
 * THE PATH ITSELF IS NOT PRINTED, because the API does not send it: `detail` is
 * null for `absent` by design (a missing file is not an error worth a message).
 * Naming the configuration key the operator would check is what this page can
 * honestly say; inventing the default path it may not be using is not.
 *
 * STILL `severity="info"`. An instance genuinely deployed another way is an
 * ordinary state, and every dev stack and CI run lands here — a warning would
 * cry wolf on all of them.
 */
function DeployInfoUnavailable({ about }: { about: AboutResponse }) {
  if (about.deployInfoStatus === 'absent') {
    return (
      <Alert severity="info">
        <AlertTitle>No deployment record was found</AlertTitle>
        The API found no deployment record where it looks for one (the path in{' '}
        <Typography component="code" variant="body2" sx={{ fontFamily: 'monospace' }}>
          DEPLOY_INFO_PATH
        </Typography>
        ), so there is nothing to show under Deployment or Server. That is the ordinary
        state for an instance deployed without the deploy CLI, and also what a mis-set
        path, a bind mount that did not attach, or a deploy that stopped before the
        record was written look like from here.
      </Alert>
    );
  }

  return (
    <Alert severity="warning">
      <AlertTitle>
        {about.deployInfoStatus === 'unreadable'
          ? 'The deployment record could not be read'
          : 'The deployment record is not in the expected format'}
      </AlertTitle>
      {about.detail ?? 'The API gave no further detail.'}
    </Alert>
  );
}

// =============================================================================
// Loading and error states
// =============================================================================

/** Three section-shaped placeholders, so the page does not jump when the facts arrive. */
function AboutSkeleton() {
  return (
    <Stack spacing={3} aria-busy="true" aria-label="Loading deployment details">
      {['Application', 'Deployment', 'Server'].map((title) => (
        <Paper key={title} sx={{ p: { xs: 2, sm: 3 } }}>
          <Skeleton variant="text" width={140} height={32} />
          <Skeleton variant="text" />
          <Skeleton variant="text" />
          <Skeleton variant="text" width="60%" />
        </Paper>
      ))}
    </Stack>
  );
}

// =============================================================================
// The page
// =============================================================================

export default function AboutPage() {
  const { hasPermission } = usePermissions();
  const { about, isLoading, loadError, refresh } = useAbout();

  // Defence, not the gate — `App.tsx` wraps the route in `RequirePermission`
  // with this same string, exactly as every sibling admin page does. This
  // catches the page mounted from anywhere else, and sits after every hook so
  // the hook order never changes.
  if (!hasPermission('system_settings:read')) {
    return <Navigate to="/" replace />;
  }

  // The API's own clock at the moment it answered — see the file header for
  // why relative ages are dated against this and not `new Date()`.
  const now = about ? new Date(about.runtime.serverTimeUtc) : new Date();
  const info = about?.deployInfoStatus === 'ok' ? about.deployInfo : null;

  return (
    <Container maxWidth="lg">
      <Box sx={{ py: 4 }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ alignItems: { sm: 'flex-start' }, justifyContent: 'space-between', mb: 3 }}
        >
          <Box>
            {/* Title and description MIRROR the `About` card so the hub card,
                the rail row, the compact AppBar title and this `h1` all name
                the page identically. */}
            <Typography variant="h4" component="h1" gutterBottom>
              {PAGE_TITLE}
            </Typography>
            <Typography color="text.secondary">{PAGE_DESCRIPTION}</Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => void refresh()}
            disabled={isLoading}
            sx={{ flexShrink: 0 }}
          >
            {isLoading && about ? 'Refreshing…' : 'Refresh'}
          </Button>
        </Stack>

        {/* A refresh that failed with an answer already on screen: keep the
            answer, say the refresh did not land. With no answer at all, the
            error IS the page, and it carries the retry. */}
        {loadError && (
          <Alert
            severity="error"
            sx={{ mb: 3 }}
            action={
              !about ? (
                <Button color="inherit" size="small" onClick={() => void refresh()} disabled={isLoading}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {loadError}
          </Alert>
        )}

        {!about && isLoading && <AboutSkeleton />}

        {about && (
          <Stack spacing={3}>
            <ApplicationSection about={about} now={now} />
            {info ? (
              <>
                {/* `=== false`, never `!== true` — see the file header. The
                    warning sits ABOVE the facts it is about, and the facts
                    below it are not degraded by one word. */}
                {about.deployRunComplete === false && (
                  <DeployRunIncomplete about={about} now={now} />
                )}
                <DeploymentSection about={about} info={info} now={now} />
                <ServerSection info={info} />
              </>
            ) : (
              <DeployInfoUnavailable about={about} />
            )}
          </Stack>
        )}
      </Box>
    </Container>
  );
}

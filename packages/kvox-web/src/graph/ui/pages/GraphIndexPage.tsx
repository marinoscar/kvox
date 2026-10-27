/**
 * `/graph/entities` — the knowledge graph's entity index (#373, epic #347;
 * spec §13). Moved from `/graph` by #782, which made the whole-graph overview
 * the knowledge landing; the index links back to it from its header.
 *
 * OWNED BY THE `knowledge` DESTINATION (#438) through the `/graph` prefix;
 * also reached from Home's Knowledge section ("All people & organizations").
 *
 * STATE LIVES IN THE URL (`?q=&type=Person,Organization`), so a filtered view
 * survives a reload, a drill-down and back, and can be shared with yourself.
 * An ABSENT `type` means the default selection (Person + Organization); an
 * explicit empty `type=` means every type.
 *
 * The phone treatment (horizontally scrolling chips) is one PAGE-LEVEL
 * `down('sm')` read — the same kind `LibraryPageFrame` makes. It decides where
 * this page puts its own controls, never whether app chrome mounts, so it is
 * not a sixth coupled breakpoint gate (CLAUDE.md, Settings UI Pattern rule 5).
 *
 * The header is the shared `KnowledgeHeader` (#782): links to Overview
 * (`/graph`), Explore, Review and Possible duplicates, and the overflow menu
 * with Synonyms, "Export graph…" and, for a caller holding `graph:write`,
 * "Import graph…". The caller's last five imports are listed in a small
 * "Imports" section below the entities, shown only when there is one.
 */

import SearchIcon from '@mui/icons-material/Search';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import InputAdornment from '@mui/material/InputAdornment';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Snackbar from '@mui/material/Snackbar';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { EntityListRow } from '../components/EntityListRow.js';
import { KnowledgeHeader } from '../components/KnowledgeHeader.js';
import { EntityTypeFilter } from '../components/EntityTypeFilter.js';
import { useGraphEntities } from '../../headless/hooks/useGraphEntities.js';
import { useRecentGraphImports } from '../../headless/hooks/useGraphImport.js';
import { useGraphEffectiveOntology } from '../../headless/hooks/useGraphAttributeDefs.js';
import { PROPOSAL_STATUS_LABELS } from '../components/review/ProposalHeader.js';
import type { ProposalStatus, ProposalSummary } from '../../headless/clients/graph.js';
import { importStatsOf } from '../../headless/clients/graph.js';
import {
  DEFAULT_INDEX_TYPES,
  entityTypeLabel,
  indexableEntityTypes,
} from '../../headless/utils/graphDisplay.js';

import { useHasPermission } from '../../../core/headless/index.js';
import { formatDate, useDisplayTimeZone } from '@marinoscar/platform-web/timezone/headless';
/**
 * How the entity page hands a "Forgetting…" message to this page.
 *
 * @stability experimental
 */
export interface GraphIndexLocationState {
  /** Message the entity page hands over to show in a snackbar, such as "Forgetting…". */
  snackbar?: string;
}

/** The entity index's `h1` (#782: `/graph` is now the overview). */
export const ENTITIES_TITLE = 'Entities';

const SKELETON_ROWS = 6;

/** An import's status, as the "Imports" section's chip names it. */
const IMPORT_STATUS_LABELS: Record<ProposalStatus, string> = {
  ...PROPOSAL_STATUS_LABELS,
  extracting: 'Checking',
  draft: 'To review',
};

const IMPORT_STATUS_COLORS: Record<ProposalStatus, 'default' | 'info' | 'success' | 'error' | 'warning'> = {
  extracting: 'info',
  draft: 'warning',
  committed: 'success',
  discarded: 'default',
  failed: 'error',
  reverted: 'default',
};

function RecentImports({ imports }: { imports: readonly ProposalSummary[] }) {
  // The import's day in the reader's display zone; a saved profile re-renders it.
  const zone = useDisplayTimeZone();
  if (imports.length === 0) return null;
  return (
    <Box component="section" aria-labelledby="graph-imports-heading" sx={{ mt: 3 }}>
      <Typography id="graph-imports-heading" variant="subtitle1" component="h2" sx={{ fontWeight: 600, mb: 0.5 }}>
        Imports
      </Typography>
      <List dense disablePadding aria-label="Recent imports">
        {imports.map((proposal) => {
          const stats = importStatsOf(proposal);
          return (
            <ListItemButton key={proposal.id} component={RouterLink} to={`/graph/imports/${encodeURIComponent(proposal.id)}`}>
              <ListItemText
                primary={stats.filename ?? 'Import'}
                secondary={formatDate(proposal.createdAt, { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone })}
                slotProps={{ primary: { noWrap: true } }}
              />
              <Chip size="small" label={IMPORT_STATUS_LABELS[proposal.status]} color={IMPORT_STATUS_COLORS[proposal.status]} sx={{ ml: 1 }} />
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}

/** `?type=` → the selection. Absent → the default; present-but-empty → everything. */
export function typesFromQuery(value: string | null): string[] {
  if (value === null) return [...DEFAULT_INDEX_TYPES];
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * The `/graph/entities` page: the caller's entities, filtered by type and search text held in the URL, with export and import actions in the header.
 *
 * @stability experimental
 */
export function GraphIndexPage() {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const selectedTypes = useMemo(
    () => typesFromQuery(searchParams.get('type')),
    [searchParams],
  );

  const { ontology } = useGraphEffectiveOntology();
  const typeOptions = useMemo(() => indexableEntityTypes(ontology), [ontology]);

  const list = useGraphEntities({ type: selectedTypes, q });
  const searching = q.trim().length > 0;

  const canImport = useHasPermission('graph:write');
  const recentImports = useRecentGraphImports(canImport);
  const [snackbar, setSnackbar] = useState<string | null>(
    () => (location.state as GraphIndexLocationState | null)?.snackbar ?? null,
  );

  // Consume the one-shot snackbar so a reload or Back does not show it again.
  useEffect(() => {
    if ((location.state as GraphIndexLocationState | null)?.snackbar) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.pathname, location.search, location.state, navigate]);

  const writeParams = (next: { q?: string; type?: string[] }) => {
    const params = new URLSearchParams(searchParams);
    if (next.q !== undefined) {
      if (next.q) params.set('q', next.q);
      else params.delete('q');
    }
    if (next.type !== undefined) params.set('type', next.type.join(','));
    setSearchParams(params, { replace: true });
  };

  const header = (
    <KnowledgeHeader
      current="entities"
      title={ENTITIES_TITLE}
      subtitle="People, organizations and projects from your reviewed notes."
    />
  );

  let body: ReactNode;
  if (list.isLoading) {
    body = (
      <Box role="status" aria-busy="true" aria-label="Loading your knowledge graph">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Stack key={index} direction="row" spacing={2} sx={{ alignItems: 'center', py: 1.25, px: 2 }}>
            <Skeleton variant="circular" width={40} height={40} />
            <Box sx={{ flexGrow: 1 }}>
              <Skeleton width="40%" />
              <Skeleton width="60%" />
            </Box>
          </Stack>
        ))}
      </Box>
    );
  } else if (list.error && list.data.length === 0) {
    body = (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => void list.refresh()}>
            Retry
          </Button>
        }
      >
        {list.error}
      </Alert>
    );
  } else if (list.data.length === 0) {
    body = searching ? (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
        <Typography>No matches for “{q.trim()}”</Typography>
      </Paper>
    ) : (
      <Paper variant="outlined" sx={{ p: { xs: 2.5, sm: 3 }, textAlign: 'center' }}>
        <Typography variant="subtitle1" component="h2" gutterBottom sx={{ fontWeight: 600 }}>
          Nothing in your graph yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Review a note&apos;s proposal to add people and organizations.
        </Typography>
        <Button component={RouterLink} to="/notes" variant="contained">
          Go to notes
        </Button>
      </Paper>
    );
  } else {
    body = (
      <>
        {list.error && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {list.error}
          </Alert>
        )}
        <List aria-label="Entities" disablePadding>
          {list.data.map((entity) => (
            <EntityListRow
              key={entity.id}
              entity={entity}
              typeLabel={entityTypeLabel(entity.type, ontology)}
            />
          ))}
        </List>
        {!searching && list.nextCursor && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Button
              variant="outlined"
              onClick={() => void list.loadMore()}
              disabled={list.isLoadingMore}
            >
              {list.isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </Box>
        )}
      </>
    );
  }

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', py: { xs: 2, sm: 3 }, minWidth: 0 }}>
      {header}

      <Stack spacing={1.5} sx={{ mb: 2, minWidth: 0 }}>
        <TextField
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            writeParams({ q: event.target.value.trim() });
          }}
          placeholder="Search people and organizations"
          size="small"
          fullWidth
          slotProps={{
            htmlInput: { 'aria-label': 'Search people and organizations' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <EntityTypeFilter
          options={typeOptions}
          selected={selectedTypes}
          onChange={(next) => writeParams({ type: next })}
          scroll={isPhone}
        />
      </Stack>

      {body}

      <RecentImports imports={recentImports.imports} />

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={6000}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
      />
    </Box>
  );
}

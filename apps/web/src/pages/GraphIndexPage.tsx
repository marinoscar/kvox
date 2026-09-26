/**
 * `/graph` — the knowledge graph's index (#373, epic #347; spec §13).
 *
 * OWNED BY THE `home` DESTINATION, not a bottom-bar tab of its own: the bar is
 * at its four-tab ceiling by design (CLAUDE.md, Navigation Destination Model),
 * and the graph is reached from Home's Knowledge section, library search and
 * transcript speaker chips instead.
 *
 * STATE LIVES IN THE URL (`?q=&type=Person,Organization`), so a filtered view
 * survives a reload, a drill-down and back, and can be shared with yourself.
 * An ABSENT `type` means the default selection (Person + Organization); an
 * explicit empty `type=` means every type.
 *
 * The phone treatment (horizontally scrolling chips, buttons folded into an
 * overflow menu) is one PAGE-LEVEL `down('sm')` read — the same kind
 * `LibraryPageFrame` makes. It decides where this page puts its own controls,
 * never whether app chrome mounts, so it is not a sixth coupled breakpoint gate
 * (CLAUDE.md, Settings UI Pattern rule 5).
 */

import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import InputAdornment from '@mui/material/InputAdornment';
import List from '@mui/material/List';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
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

import { EntityListRow } from '../components/graph/EntityListRow';
import { EntityTypeFilter } from '../components/graph/EntityTypeFilter';
import { useGraphEntities } from '../hooks/useGraphEntities';
import { useGraphOntology } from '../hooks/useGraphAttributeDefs';
import {
  DEFAULT_INDEX_TYPES,
  entityTypeLabel,
  indexableEntityTypes,
} from '../utils/graphDisplay';

/** How the entity page hands a "Forgetting…" message to this page. */
export interface GraphIndexLocationState {
  snackbar?: string;
}

const SKELETON_ROWS = 6;

/** `?type=` → the selection. Absent → the default; present-but-empty → everything. */
export function typesFromQuery(value: string | null): string[] {
  if (value === null) return [...DEFAULT_INDEX_TYPES];
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

export default function GraphIndexPage() {
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

  const { ontology } = useGraphOntology();
  const typeOptions = useMemo(() => indexableEntityTypes(ontology), [ontology]);

  const list = useGraphEntities({ type: selectedTypes, q });
  const searching = q.trim().length > 0;

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
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
    <Stack
      direction="row"
      spacing={2}
      sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
          Knowledge
        </Typography>
        <Typography variant="body2" color="text.secondary">
          People, organizations and projects from your reviewed notes.
        </Typography>
      </Box>
      {isPhone ? (
        <>
          <IconButton
            aria-label="More knowledge views"
            aria-haspopup="menu"
            onClick={(event) => setMenuAnchor(event.currentTarget)}
          >
            <MoreVertIcon />
          </IconButton>
          <Menu
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={() => setMenuAnchor(null)}
          >
            <MenuItem component={RouterLink} to="/graph/explore" onClick={() => setMenuAnchor(null)}>
              Explore
            </MenuItem>
            <MenuItem component={RouterLink} to="/graph/overview" onClick={() => setMenuAnchor(null)}>
              Overview
            </MenuItem>
          </Menu>
        </>
      ) : (
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          <Button component={RouterLink} to="/graph/explore" variant="outlined">
            Explore
          </Button>
          <Button component={RouterLink} to="/graph/overview" variant="outlined">
            Overview
          </Button>
        </Stack>
      )}
    </Stack>
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

      <Snackbar
        open={Boolean(snackbar)}
        autoHideDuration={6000}
        onClose={() => setSnackbar(null)}
        message={snackbar ?? ''}
      />
    </Box>
  );
}

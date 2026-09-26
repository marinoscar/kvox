/**
 * `ClusterSidePanel` — what the selected overview cluster is, and the way into
 * it (#375; spec §22.3).
 *
 * A right-hand `Paper` from `sm` up; a bottom `Drawer` on a phone — the
 * `ExplorerSidePanel` (#374) shape exactly. That `down('sm')` is a PAGE-LEVEL
 * read deciding where one page puts one panel, not a sixth app-chrome
 * breakpoint gate (CLAUDE.md, Settings UI Pattern rule 5).
 *
 * The primary action is **Explore this cluster** — the drill-down that hands
 * the cluster's members to the explorer. Labels are the server's live labels
 * (§15), so a forgotten member never appears here.
 */

import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { Link as RouterLink } from 'react-router-dom';

import type { GraphOverviewCluster } from '../../../services/graph';
import { EntityTypeIcon } from '../entityTypeIcon';
import { UNCONNECTED_CLUSTER_ID, entityCount, topTypes } from './overviewModel';

export const EXPLORE_CLUSTER_LABEL = 'Explore this cluster';

export interface ClusterSidePanelProps {
  cluster: GraphOverviewCluster | null;
  color: string | null;
  typeLabel: (type: string) => string;
  onExplore: (clusterId: number) => void;
  onClose: () => void;
}

export function ClusterSidePanel(props: ClusterSidePanelProps) {
  const { cluster, onClose } = props;
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  if (isCompactWindow) {
    return (
      <Drawer
        anchor="bottom"
        open={cluster !== null}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '60vh' },
            'aria-label': cluster?.label ?? 'Cluster',
          },
        }}
      >
        {cluster && <PanelBody {...props} cluster={cluster} />}
      </Drawer>
    );
  }

  if (!cluster) return null;
  return (
    <Paper
      variant="outlined"
      component="aside"
      aria-label={cluster.label}
      sx={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 300,
        maxWidth: 'calc(100% - 24px)',
        maxHeight: 'calc(100% - 24px)',
        overflowY: 'auto',
        zIndex: 2,
      }}
    >
      <PanelBody {...props} cluster={cluster} />
    </Paper>
  );
}

function PanelBody({
  cluster,
  color,
  typeLabel,
  onExplore,
  onClose,
}: ClusterSidePanelProps & { cluster: GraphOverviewCluster }) {
  const types = topTypes(cluster.typeCounts, Infinity);
  return (
    <Box sx={{ p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, mb: 0.5 }}>
        {color && (
          <Box
            aria-hidden
            sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: color, mt: 1, flexShrink: 0 }}
          />
        )}
        <Typography variant="h6" component="h2" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
          {cluster.label}
        </Typography>
        <IconButton size="small" aria-label="Close" onClick={onClose} edge="end">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {entityCount(cluster.size)}
        {cluster.id === UNCONNECTED_CLUSTER_ID && ' with no connections yet'}
      </Typography>
      {types.length > 0 && (
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
          {types.map((type) => (
            <Chip
              key={type}
              size="small"
              variant="outlined"
              label={`${typeLabel(type)} ${cluster.typeCounts[type]}`}
            />
          ))}
        </Stack>
      )}
      {cluster.memberSample.length > 0 && (
        <>
          <Typography variant="subtitle2" component="h3" id={`cluster-${cluster.id}-members`}>
            Most connected
          </Typography>
          <List dense disablePadding aria-labelledby={`cluster-${cluster.id}-members`} sx={{ mb: 1 }}>
            {cluster.memberSample.slice(0, 8).map((member) => (
              <ListItem key={member.id} disableGutters sx={{ gap: 1, py: 0.25 }}>
                <EntityTypeIcon type={member.type} fontSize="small" sx={{ color: 'text.secondary' }} />
                <Link
                  component={RouterLink}
                  to={`/graph/entities/${encodeURIComponent(member.id)}`}
                  underline="hover"
                  sx={{ minWidth: 0, overflowWrap: 'anywhere' }}
                >
                  {member.label}
                </Link>
              </ListItem>
            ))}
          </List>
        </>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        <Button variant="contained" size="small" onClick={() => onExplore(cluster.id)}>
          {EXPLORE_CLUSTER_LABEL}
        </Button>
        {cluster.labelEntityId && (
          <Button
            size="small"
            variant="outlined"
            component={RouterLink}
            to={`/graph/entities/${encodeURIComponent(cluster.labelEntityId)}`}
          >
            Open {cluster.label}
          </Button>
        )}
      </Box>
    </Box>
  );
}

/**
 * `ClusterListView` — the overview as a list (#375; spec §22.3).
 *
 * The ACCESSIBLE view of the overview (every canvas action is a real control
 * here) and the ONLY view without WebGL. Clusters largest first, "Unconnected"
 * last (`overviewModel.toClusterList`); each row expands (a native button, so
 * Enter/Space work) to its sample members as links and the same
 * **Explore this cluster** drill-down the side panel offers.
 */

import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import { EntityTypeIcon } from '../entityTypeIcon';
import { EXPLORE_CLUSTER_LABEL } from './ClusterSidePanel';
import { entityCount, type ClusterListRow } from './overviewModel';

export const CLUSTER_LIST_LABEL = 'Clusters as a list';

export interface ClusterListViewProps {
  rows: ClusterListRow[];
  colorOf: (clusterId: number) => string;
  typeLabel: (type: string) => string;
  selectedId: number | null;
  onSelect: (clusterId: number | null) => void;
  onExplore: (clusterId: number) => void;
}

export function ClusterListView({
  rows,
  colorOf,
  typeLabel,
  selectedId,
  onSelect,
  onExplore,
}: ClusterListViewProps) {
  if (rows.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No clusters to show.
        </Typography>
      </Paper>
    );
  }

  return (
    <Box component="section" aria-label={CLUSTER_LIST_LABEL}>
      {rows.map((row) => {
        const summaryId = `cluster-row-${row.id}`;
        const types = row.topTypes.map(typeLabel).join(', ');
        return (
          <Accordion
            key={row.id}
            disableGutters
            variant="outlined"
            expanded={selectedId === row.id}
            onChange={(_, expanded) => onSelect(expanded ? row.id : null)}
            // h2: the page's only heading above the list is its h1.
            slotProps={{ transition: { unmountOnExit: true }, heading: { component: 'h2' } }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />} id={summaryId} aria-controls={`${summaryId}-panel`}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
                <Box
                  aria-hidden
                  sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: colorOf(row.id), flexShrink: 0 }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <Typography component="span" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
                    {row.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="span" sx={{ display: 'block' }}>
                    {entityCount(row.size)}
                    {types && ` · ${types}`}
                  </Typography>
                </Box>
              </Box>
            </AccordionSummary>
            <AccordionDetails id={`${summaryId}-panel`} sx={{ pt: 0 }}>
              {row.members.length > 0 && (
                <List dense disablePadding aria-label={`Most connected in ${row.label}`}>
                  {row.members.map((member) => (
                    <ListItem key={member.id} disableGutters sx={{ gap: 1, py: 0.25 }}>
                      <EntityTypeIcon type={member.type} fontSize="small" sx={{ color: 'text.secondary' }} />
                      <Link
                        component={RouterLink}
                        to={`/graph/entities/${encodeURIComponent(member.id)}`}
                        underline="hover"
                        sx={{ overflowWrap: 'anywhere' }}
                      >
                        {member.label}
                      </Link>
                    </ListItem>
                  ))}
                </List>
              )}
              <Button
                variant="contained"
                size="small"
                sx={{ mt: 1 }}
                onClick={() => onExplore(row.id)}
                aria-label={`${EXPLORE_CLUSTER_LABEL}: ${row.label}`}
              >
                {EXPLORE_CLUSTER_LABEL}
              </Button>
            </AccordionDetails>
          </Accordion>
        );
      })}
    </Box>
  );
}

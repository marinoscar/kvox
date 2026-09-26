/**
 * `EntitySearchHits` — "People & organizations" matching the library search
 * box, shown ABOVE the ranked transcript/note results (#373, spec §13's
 * "from search results that resolve to a graph entity").
 *
 * ⚠ SEARCH MUST NEVER BREAK BECAUSE THE GRAPH FAILED. No hits, a failed
 * request, a missing permission or an empty box all render NOTHING — no
 * skeleton, no error box. The library's own results are the page; this row is
 * an enhancement on top of it.
 */

import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useNavigate } from 'react-router-dom';

import { useGraphEntities } from '../../hooks/useGraphEntities';
import { usePermissions } from '../../hooks/usePermissions';
import { EntityTypeIcon } from './entityTypeIcon';
import { entityPath } from './EntityListRow';

export const SEARCH_HIT_TYPES = ['Person', 'Organization', 'Project'] as const;
export const SEARCH_HIT_LIMIT = 5;

export interface EntitySearchHitsProps {
  /** The library search box's raw value. */
  query: string;
}

export function EntitySearchHits({ query }: EntitySearchHitsProps) {
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const q = query.trim();
  const enabled = hasPermission('graph:read') && q.length > 0;

  const hits = useGraphEntities({
    q,
    type: SEARCH_HIT_TYPES,
    limit: SEARCH_HIT_LIMIT,
    enabled,
  });

  if (!enabled || hits.isLoading || hits.error || hits.data.length === 0) return null;

  return (
    <Box component="section" aria-labelledby="entity-search-hits" sx={{ mb: 2, minWidth: 0 }}>
      <Typography id="entity-search-hits" variant="subtitle2" component="h2" color="text.secondary" sx={{ mb: 0.75 }}>
        People &amp; organizations
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, overflowX: 'auto', pb: 0.5, minWidth: 0 }}>
        {hits.data.map((entity) => (
          <Chip
            key={entity.id}
            icon={<EntityTypeIcon type={entity.type} fontSize="small" />}
            label={entity.label}
            clickable
            variant="outlined"
            onClick={() => navigate(entityPath(entity.id))}
            sx={{ flexShrink: 0 }}
          />
        ))}
      </Box>
    </Box>
  );
}

export default EntitySearchHits;

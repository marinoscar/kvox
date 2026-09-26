/**
 * `EntityTimeline` — everything dated about one entity, newest first, grouped
 * by month (#373 over #370's timeline).
 *
 * Dates are written to their PRECISION ("2026", "Mar 2026", "4 Mar 2026").
 * Superseded items stay — history is the point (§5.5) — struck through with a
 * "Superseded" chip.
 *
 * ⚠ SENSITIVE FACTS ARE OPT-IN PER VIEW (§5.6). The switch is off on every
 * mount, flipping it re-asks the API with `includeSensitive=true` (the list is
 * a new question, not a filter over data already held), and the answer lives
 * in component state only — never `localStorage`. Sensitive facts render in a
 * warning-tinted block so they are never mistaken for ordinary ones.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useGraphTimeline } from '../../hooks/useGraphTimeline';
import type { GraphOntology, TimelineEvent } from '../../services/graph';
import { formatPrecisionDate, monthGroupKey, relationTypeLabel } from '../../utils/graphDisplay';
import { EvidenceChips } from './EvidenceChip';
import { entityPath } from './EntityListRow';

export interface EntityTimelineProps {
  entityId: string;
  ontology: GraphOntology | null;
}

/** Pure grouping by month, preserving the API's order. Exported for tests. */
export function groupByMonth(events: readonly TimelineEvent[]): { key: string; events: TimelineEvent[] }[] {
  const groups: { key: string; events: TimelineEvent[] }[] = [];
  for (const event of events) {
    const key = monthGroupKey(event.at, event.precision);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, events: [event] });
  }
  return groups;
}

function EventBody({ event, ontology }: { event: TimelineEvent; ontology: GraphOntology | null }) {
  if (event.eventKind === 'meeting' && event.meeting) {
    return (
      <Typography variant="body2" component="p">
        Meeting:{' '}
        <Link component={RouterLink} to={entityPath(event.meeting.id)}>
          {event.meeting.label}
        </Link>
      </Typography>
    );
  }
  if ((event.eventKind === 'relation_started' || event.eventKind === 'relation_ended') && event.relation) {
    const verb = event.eventKind === 'relation_started' ? 'Started' : 'Ended';
    return (
      <Typography variant="body2" component="p">
        {verb}: {relationTypeLabel(event.relation.type, ontology)}{' '}
        <Link component={RouterLink} to={entityPath(event.relation.other.id)}>
          {event.relation.other.label}
        </Link>
        <EvidenceChips ids={event.evidenceIds} />
      </Typography>
    );
  }
  if (event.item) {
    const { item } = event;
    return (
      <>
        <Typography
          variant="body2"
          component="p"
          sx={{
            fontWeight: item.title ? 600 : 400,
            textDecoration: item.superseded ? 'line-through' : 'none',
            color: item.superseded ? 'text.secondary' : 'text.primary',
          }}
        >
          {item.title ?? item.statement}
          <EvidenceChips ids={event.evidenceIds} />
        </Typography>
        {item.title && (
          <Typography variant="body2" color="text.secondary">
            {item.statement}
          </Typography>
        )}
      </>
    );
  }
  return null;
}

function kindLabel(event: TimelineEvent): string {
  switch (event.item?.kind) {
    case 'commitment':
      return 'Commitment';
    case 'decision':
      return 'Decision';
    case 'claim':
      return 'Claim';
    case 'person_fact':
      return 'Fact';
    default:
      return event.eventKind === 'meeting' ? 'Meeting' : 'Relationship';
  }
}

export function EntityTimeline({ entityId, ontology }: EntityTimelineProps) {
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const timeline = useGraphTimeline(entityId, { includeSensitive });
  const groups = useMemo(() => groupByMonth(timeline.data), [timeline.data]);

  return (
    <Box component="section" aria-labelledby="entity-timeline-title" sx={{ mb: 3 }}>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', mb: 1 }}
      >
        <Typography id="entity-timeline-title" variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          Timeline
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={includeSensitive}
              onChange={(event) => setIncludeSensitive(event.target.checked)}
            />
          }
          label="Show sensitive facts"
        />
      </Stack>

      {timeline.isLoading ? (
        <Box aria-busy="true" aria-label="Loading timeline" role="status">
          <Skeleton width="60%" />
          <Skeleton width="80%" />
          <Skeleton width="50%" />
        </Box>
      ) : timeline.error && timeline.data.length === 0 ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => void timeline.refresh()}>
              Retry
            </Button>
          }
        >
          {timeline.error}
        </Alert>
      ) : timeline.data.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing dated yet.
        </Typography>
      ) : (
        <>
          {groups.map((group) => (
            <Box key={group.key} sx={{ mb: 2 }}>
              <Typography variant="subtitle2" component="h3" color="text.secondary" sx={{ mb: 0.5 }}>
                {group.key}
              </Typography>
              <Box component="ul" sx={{ m: 0, p: 0 }}>
                {group.events.map((event) => {
                  const sensitive = event.item?.sensitivity === 'sensitive';
                  return (
                    <Box
                      component="li"
                      key={event.id}
                      sx={(theme) => ({
                        listStyle: 'none',
                        py: 1,
                        px: sensitive ? 1.5 : 0,
                        my: sensitive ? 0.5 : 0,
                        borderRadius: 1,
                        ...(sensitive
                          ? {
                              bgcolor: alpha(theme.palette.warning.main, 0.12),
                              borderLeft: `3px solid ${theme.palette.warning.main}`,
                            }
                          : {}),
                      })}
                    >
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.25, flexWrap: 'wrap' }}>
                        <Typography variant="caption" color="text.secondary">
                          {formatPrecisionDate(event.at, event.precision)}
                        </Typography>
                        <Chip size="small" variant="outlined" label={kindLabel(event)} />
                        {event.item?.superseded && <Chip size="small" label="Superseded" />}
                        {sensitive && <Chip size="small" color="warning" label="Sensitive" />}
                      </Stack>
                      <EventBody event={event} ontology={ontology} />
                      {event.evidenceCount > event.evidenceIds.length && (
                        <Typography variant="caption" color="text.secondary">
                          +{event.evidenceCount - event.evidenceIds.length} more sources
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Box>
          ))}
          {timeline.nextCursor && (
            <Button
              variant="outlined"
              onClick={() => void timeline.loadMore()}
              disabled={timeline.isLoadingMore}
            >
              {timeline.isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </Box>
  );
}

export default EntityTimeline;

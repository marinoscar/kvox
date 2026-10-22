/**
 * The inspector's Timeline tab (GIC-11, #672): an entity's dated events, newest
 * first, each with how many quotes back it.
 *
 * The timeline is read WITHOUT `includeSensitive`, and an item event that is
 * `sensitive` is dropped here too: the inspector has no switch for sensitive
 * facts (that opt-in lives on the entity page). The quote counts are plain text,
 * not evidence chips, so nothing here resolves a citation.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { Link as RouterLink } from 'react-router-dom';

import type { GraphOntology, TimelineEvent } from '../../../../headless/clients/graph.js';
import { useGraphTimeline } from '../../../../headless/hooks/useGraphTimeline.js';
import { formatPrecisionDate, relationTypeLabel } from '../../../../headless/utils/graphDisplay.js';
import { entityPath } from '../../EntityListRow.js';

/** What one event says, in a sentence. */
export function timelineEventText(event: TimelineEvent, ontology: GraphOntology | null): string {
  if (event.eventKind === 'meeting' && event.meeting) return `Meeting: ${event.meeting.label}`;
  if ((event.eventKind === 'relation_started' || event.eventKind === 'relation_ended') && event.relation) {
    const verb = event.eventKind === 'relation_started' ? 'Started' : 'Ended';
    return `${verb}: ${relationTypeLabel(event.relation.type, ontology)} ${event.relation.other.label}`;
  }
  if (event.item) return event.item.title ?? event.item.statement;
  return 'Event';
}

/**
 * Props of {@link TimelineTab}.
 *
 * @stability experimental
 */
export interface TimelineTabProps {
  /** The entity. */
  entityId: string;
  /** The ontology, for relation labels. */
  ontology: GraphOntology | null;
  /** A coarse pointer. */
  touch: boolean;
  /** Sets the TimeBar's brush to the bucket holding an event (GIC-15). Without it no "Show in TimeBar" link is drawn. */
  onShowInTimeBar?: (at: string) => void;
}

/**
 * The entity's timeline, 25 events at a time.
 *
 * @stability experimental
 */
export function TimelineTab({ entityId, ontology, touch, onShowInTimeBar }: TimelineTabProps) {
  const timeline = useGraphTimeline(entityId, { limit: 25 });
  const events = timeline.data.filter((event) => event.item?.sensitivity !== 'sensitive');
  if (timeline.isLoading) {
    return (
      <Box aria-busy sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Skeleton variant="rounded" height={48} />
        <Skeleton variant="rounded" height={48} />
      </Box>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {timeline.error && <Alert severity="error">{timeline.error}</Alert>}
      {!timeline.error && events.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          Nothing dated has been recorded yet.
        </Typography>
      )}
      {events.length > 0 && (
        <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {events.map((event) => (
            <li key={event.id}>
              <Typography variant="caption" color="text.secondary" component="p">
                {formatPrecisionDate(event.at, event.precision)}
                {event.evidenceCount > 0 &&
                  ` · ${event.evidenceCount === 1 ? '1 quote' : `${event.evidenceCount} quotes`}`}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  wordBreak: 'break-word',
                  textDecoration: event.item?.superseded ? 'line-through' : 'none',
                }}
              >
                {timelineEventText(event, ontology)}
              </Typography>
              {onShowInTimeBar && event.at && (
                <Button
                  size="small"
                  onClick={() => onShowInTimeBar(event.at!)}
                  sx={{ px: 0.5, minWidth: 0, minHeight: touch ? 44 : undefined }}
                  aria-label={`Show ${formatPrecisionDate(event.at, event.precision)} in the time bar`}
                >
                  Show in TimeBar
                </Button>
              )}
            </li>
          ))}
        </Box>
      )}
      {timeline.nextCursor && (
        <Button
          onClick={() => void timeline.loadMore()}
          disabled={timeline.isLoadingMore}
          sx={{ alignSelf: 'flex-start', minHeight: touch ? 44 : undefined }}
        >
          Show more events
        </Button>
      )}
      <Link component={RouterLink} to={entityPath(entityId)} variant="body2" sx={{ alignSelf: 'flex-start' }}>
        Open the full timeline
      </Link>
    </Box>
  );
}

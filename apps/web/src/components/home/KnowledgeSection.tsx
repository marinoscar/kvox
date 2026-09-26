/**
 * `KnowledgeSection` — Home's entry point to the knowledge graph (#373, spec
 * §13: "a new Knowledge section on HomePage.tsx surfacing recent entities").
 *
 * The graph has no bottom-bar tab (the bar is at its four-tab ceiling by
 * design), so this is where most people will find it.
 *
 * HIDDEN ENTIRELY unless it has something to show: no `graph:read`, an empty
 * graph, a slow first answer or a failed one all render NOTHING — no skeleton,
 * no error box. Home is about the user's recordings and notes; a section that
 * flashes a placeholder and then vanishes for everyone without a graph would
 * be noise on the page most people open first.
 *
 * ⚠ IT CAN NEVER TAKE HOME DOWN WITH IT. The section renders inside its own
 * error boundary that renders nothing on a throw, so a render-time bug here
 * (or a malformed response slipping past `listGraphEntities`' shape check)
 * costs the Knowledge section only — never the transcripts and notes above
 * it. Before this boundary existed, a harness stub answering `{}` crashed
 * the whole app into the root `ErrorBoundary` (PR #415's visual regression).
 */

import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CardActionArea from '@mui/material/CardActionArea';
import Grid from '@mui/material/Grid';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { EntityTypeIcon } from '../graph/entityTypeIcon';
import { entityPath } from '../graph/EntityListRow';
import { useGraphEntities } from '../../hooks/useGraphEntities';
import { usePermissions } from '../../hooks/usePermissions';
import { initials } from '../../utils/graphDisplay';
import { formatRelativeTime } from '../../utils/relativeTime';

export const KNOWLEDGE_TYPES = ['Person', 'Organization'] as const;
export const KNOWLEDGE_LIMIT = 6;

/**
 * Swallows a render error in the section below it and renders nothing — the
 * section is optional content, so "absent" is the right failure, not a banner.
 * Logged so the bug is still visible in the console.
 */
class KnowledgeSectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  public state = { failed: false };

  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Knowledge section failed to render:', error, info);
  }

  public render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export function KnowledgeSection() {
  return (
    <KnowledgeSectionBoundary>
      <KnowledgeSectionContent />
    </KnowledgeSectionBoundary>
  );
}

function KnowledgeSectionContent() {
  const { hasPermission } = usePermissions();
  const enabled = hasPermission('graph:read');
  const recent = useGraphEntities({ type: KNOWLEDGE_TYPES, limit: KNOWLEDGE_LIMIT, enabled });

  if (!enabled || recent.isLoading || recent.error || recent.data.length === 0) return null;

  return (
    <Box component="section" aria-labelledby="home-knowledge" sx={{ mb: { xs: 3, sm: 4 } }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.5, flexWrap: 'wrap' }}
      >
        <Typography id="home-knowledge" variant="h6" component="h2" sx={{ fontWeight: 600 }}>
          Knowledge
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button size="small" component={RouterLink} to="/graph/explore">
            Explore
          </Button>
          <Button size="small" endIcon={<ChevronRightIcon />} component={RouterLink} to="/graph">
            All people &amp; organizations
          </Button>
        </Stack>
      </Stack>

      <Grid container spacing={1.5} component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {recent.data.slice(0, KNOWLEDGE_LIMIT).map((entity) => (
          <Grid key={entity.id} component="li" size={{ xs: 12, sm: 6, md: 4 }} sx={{ display: 'flex' }}>
            <Paper variant="outlined" sx={{ flexGrow: 1, display: 'flex' }}>
              <CardActionArea component={RouterLink} to={entityPath(entity.id)} sx={{ p: 1.5 }}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
                  <Avatar aria-hidden sx={{ bgcolor: 'primary.main', color: 'primary.contrastText' }}>
                    {initials(entity.label)}
                  </Avatar>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" component="p" noWrap sx={{ fontWeight: 600 }}>
                      {entity.label}
                    </Typography>
                    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', color: 'text.secondary' }}>
                      <EntityTypeIcon type={entity.type} sx={{ fontSize: 16 }} />
                      <Typography variant="caption" noWrap>
                        {entity.lastSeenAt
                          ? `Seen ${formatRelativeTime(entity.lastSeenAt)}`
                          : `${entity.mentionCount} ${entity.mentionCount === 1 ? 'mention' : 'mentions'}`}
                      </Typography>
                    </Stack>
                  </Box>
                </Stack>
              </CardActionArea>
            </Paper>
          </Grid>
        ))}
      </Grid>
    </Box>
  );
}

export default KnowledgeSection;

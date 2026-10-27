/**
 * `KnowledgeHeader` — the header the two knowledge landing views share (#782):
 * the whole-graph overview at `/graph` and the entity index at
 * `/graph/entities`.
 *
 * ONE HEADER, TWO PAGES, so nothing the index header carried becomes
 * unreachable when `/graph` turns into the overview: the links to the other
 * view (Overview or Entities), Explore, Review and Possible duplicates (#766,
 * with the number of pairs from one `?limit=50` read), and an overflow menu
 * with Synonyms (#767), "Export graph…" (#386) and, for a caller holding
 * `graph:write`, "Import graph…" (#387). The dialogs are mounted here too.
 *
 * The phone treatment (every link folded into the overflow menu) is one
 * PAGE-LEVEL `down('sm')` read, the same kind `LibraryPageFrame` makes. It
 * decides where this header puts its own controls, never whether app chrome
 * mounts, so it is not a sixth coupled breakpoint gate (CLAUDE.md, Settings
 * UI Pattern rule 5).
 */

import MoreVertIcon from '@mui/icons-material/MoreVert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { useHasPermission } from '../../../core/headless/index.js';
import { useGraphDuplicates } from '../../headless/hooks/useGraphDuplicates.js';
import { DUPLICATES_BADGE_LIMIT, DuplicatesLink, duplicatesBadgeText } from './DuplicatesLink.js';
import { ExportGraphDialog } from './ExportGraphDialog.js';
import { ImportGraphDialog } from './ImportGraphDialog.js';
import { GRAPH_ENTITIES_PATH, GRAPH_OVERVIEW_PATH } from '../paths.js';


/**
 * Which knowledge view the header sits on; the header links to the other one.
 *
 * @stability experimental
 */
export type KnowledgeView = 'overview' | 'entities';

/**
 * Props of {@link KnowledgeHeader}.
 *
 * @stability experimental
 */
export interface KnowledgeHeaderProps {
  /** The view the header sits on; the header links to the other one. */
  current: KnowledgeView;
  /** The page's `h1`. */
  title: string;
  /** A line under the title (a caption, a skeleton), when there is one. */
  subtitle?: ReactNode;
}

interface ViewLink {
  label: string;
  to: string;
}

function viewLinks(current: KnowledgeView): ViewLink[] {
  const other: ViewLink =
    current === 'overview'
      ? { label: 'Entities', to: GRAPH_ENTITIES_PATH }
      : { label: 'Overview', to: GRAPH_OVERVIEW_PATH };
  return [other, { label: 'Explore', to: '/graph/explore' }, { label: 'Review', to: '/graph/review' }];
}

/**
 * The header of the knowledge overview and the entity index: title, the
 * links between the knowledge views and the overflow menu with Synonyms,
 * Export and (with `graph:write`) Import.
 *
 * @stability experimental
 */
export function KnowledgeHeader({ current, title, subtitle }: KnowledgeHeaderProps) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const canImport = useHasPermission('graph:write');
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // One cheap read for the "Possible duplicates" badge (#766).
  const duplicateCount = useGraphDuplicates({ limit: DUPLICATES_BADGE_LIMIT }).pairs.length;
  const duplicateBadge = duplicatesBadgeText(duplicateCount);
  const links = viewLinks(current);

  const closeMenu = () => setMenuAnchor(null);
  const openExport = () => {
    closeMenu();
    setExportOpen(true);
  };
  const openImport = () => {
    closeMenu();
    setImportOpen(true);
  };

  const overflowItems = [
    <MenuItem key="synonyms" component={RouterLink} to="/graph/synonyms" onClick={closeMenu}>
      Synonyms
    </MenuItem>,
    <MenuItem key="export" onClick={openExport}>
      Export graph…
    </MenuItem>,
    canImport ? (
      <MenuItem key="import" onClick={openImport}>
        Import graph…
      </MenuItem>
    ) : null,
  ];

  return (
    <>
      <Stack
        direction="row"
        spacing={2}
        sx={{ alignItems: 'flex-start', justifyContent: 'space-between', mb: 2 }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h4" component="h1" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          {subtitle !== undefined && (
            <Typography variant="body2" color="text.secondary" component="div">
              {subtitle}
            </Typography>
          )}
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
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
              {links.map((link) => (
                <MenuItem key={link.to} component={RouterLink} to={link.to} onClick={closeMenu}>
                  {link.label}
                </MenuItem>
              ))}
              <MenuItem
                component={RouterLink}
                to="/graph/duplicates"
                onClick={closeMenu}
                aria-label={duplicateBadge ? `Possible duplicates (${duplicateBadge})` : 'Possible duplicates'}
              >
                Possible duplicates
                {duplicateBadge && (
                  <Chip size="small" color="warning" label={duplicateBadge} aria-hidden="true" sx={{ ml: 1, height: 20 }} />
                )}
              </MenuItem>
              {overflowItems}
            </Menu>
          </>
        ) : (
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
            {links.map((link) => (
              <Button key={link.to} component={RouterLink} to={link.to} variant="outlined">
                {link.label}
              </Button>
            ))}
            <DuplicatesLink count={duplicateCount} />
            <IconButton
              aria-label="More knowledge actions"
              aria-haspopup="menu"
              onClick={(event) => setMenuAnchor(event.currentTarget)}
            >
              <MoreVertIcon />
            </IconButton>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
              {overflowItems}
            </Menu>
          </Stack>
        )}
      </Stack>
      <ExportGraphDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      {canImport && <ImportGraphDialog open={importOpen} onClose={() => setImportOpen(false)} />}
    </>
  );
}

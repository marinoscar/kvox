/**
 * The inspector's Connections tab (GIC-11, #672): the selected node's
 * neighbours that are on the canvas, grouped by relation type.
 *
 * Each group says how many are drawn and, when the entity's counts say more
 * exist, how many there are in all, with two actions: "Show on canvas" rings the
 * group's nodes (the canvas's own marked rings) and "Expand" fetches the rest of
 * that relation type through the same type-filtered expand as the Expand menu.
 * Selecting a neighbour moves the inspector to it. An `INVOLVED_IN` row carries
 * its role and stance chips.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useMemo } from 'react';

import type { GraphOntology } from '../../../../headless/clients/graph.js';
import type { ExpandOnly } from '../../../hooks/useGraphExplorer.js';
import { STANCE_COLORS } from '../explorerEncoding.js';
import type { ExplorerGraph } from '../explorerModel.js';
import { TypeGlyph } from './TypeGlyph.js';
import { connectionGroups } from './inspectorModel.js';

/**
 * Props of {@link ConnectionsTab}.
 *
 * @stability experimental
 */
export interface ConnectionsTabProps {
  /** The explorer's graph. */
  graph: ExplorerGraph;
  /** Changes whenever the graph does, so the groups are read again. */
  version: number;
  /** The selected node. */
  nodeId: string;
  /** The ontology, for relation labels. */
  ontology: GraphOntology | null;
  /** The type label function. */
  typeLabel: (type: string) => string;
  /** `counts.relationsByType` of the entity, when the API sends it. */
  totals?: Readonly<Record<string, number>>;
  /** Whether the node can be expanded further (an entity, below the cap). */
  canExpand: boolean;
  /** Select a neighbour. */
  onSelectNode: (id: string) => void;
  /** Ring these nodes on the canvas. */
  onShowOnCanvas: (ids: string[]) => void;
  /** Expand along one relation type. */
  onExpand: (id: string, only: ExpandOnly) => void;
  /** A coarse pointer. */
  touch: boolean;
}

/**
 * Neighbours grouped by relation type, with "Show on canvas" and a per-relation "Expand".
 *
 * @stability experimental
 */
export function ConnectionsTab(props: ConnectionsTabProps) {
  const { graph, version, nodeId, ontology, typeLabel, totals, canExpand, onSelectNode, onShowOnCanvas, onExpand, touch } =
    props;
  const mode = useTheme().palette.mode;
  const groups = useMemo(
    () => connectionGroups(graph, nodeId, ontology, totals),
    // The graph is mutated in place; `version` is what changes.
    [graph, version, nodeId, ontology, totals],
  );
  const height = touch ? 44 : undefined;

  if (groups.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        Nothing connected is on the canvas yet. Use Expand to bring the neighbours in.
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {groups.map((group) => {
        const drawn = group.items.length;
        const more = group.total !== null && group.total > drawn;
        return (
          <Box component="section" key={group.relationType} aria-label={group.label}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Typography variant="subtitle2" component="h3" sx={{ flex: 1, minWidth: 0 }}>
                {group.label}{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  {more ? `${drawn} of ${group.total}` : drawn}
                </Typography>
              </Typography>
              <Button
                size="small"
                aria-label={`Show ${group.label} on canvas`}
                onClick={() => onShowOnCanvas(group.items.map((item) => item.nodeId))}
                sx={{ minHeight: height }}
              >
                Show on canvas
              </Button>
              {more && canExpand && (
                <Button
                  size="small"
                  aria-label={`Expand ${group.label}`}
                  onClick={() => onExpand(nodeId, { relationTypes: [group.relationType] })}
                  sx={{ minHeight: height }}
                >
                  Expand
                </Button>
              )}
            </Box>
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
              {group.items.map((item) => (
                <li key={item.edgeId}>
                  <ButtonBase
                    onClick={() => onSelectNode(item.nodeId)}
                    sx={{
                      width: '100%',
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      gap: 1,
                      px: 0.5,
                      py: 0.5,
                      minHeight: touch ? 44 : 36,
                      borderRadius: 1,
                      '&:hover': { bgcolor: 'action.hover' },
                      '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                    }}
                    aria-label={`${item.label}, ${typeLabel(item.type)}, ${item.direction === 'out' ? 'outgoing' : 'incoming'}${
                      item.chips.length > 0 ? `, ${item.chips.join(', ')}` : ''
                    }`}
                  >
                    <TypeGlyph type={item.type} mode={mode} size={22} />
                    <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                      {item.label}
                    </Typography>
                    <Typography aria-hidden variant="caption" color="text.secondary">
                      {item.direction === 'out' ? '→' : '←'}
                    </Typography>
                    {item.chips.map((chip) => (
                      <Chip
                        key={chip}
                        size="small"
                        variant="outlined"
                        label={chip}
                        sx={
                          item.stance && chip === item.stance
                            ? { borderColor: STANCE_COLORS[mode][item.stance], color: STANCE_COLORS[mode][item.stance] }
                            : undefined
                        }
                      />
                    ))}
                  </ButtonBase>
                </li>
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * `GraphLegend` — what the canvas's colours, pictograms and lines mean, and the
 * type filter (#667, epic #661).
 *
 * A STANDALONE component: it renders from a `LegendModel` (`legendModel()` in
 * `explorerModel.ts`) and reports clicks; it does not know where it sits. The
 * responsive shell (#669) places it: in the facets pane on an expanded window,
 * in the chip-rail popover on a medium one, in the left drawer on a compact one.
 *
 * It is a LIST OF TOGGLE BUTTONS, not a picture: each type is a `button` with
 * `aria-pressed` whose accessible name is the type's label and whose description
 * announces the count ("12 on the canvas", or "hidden"), so a screen reader gets
 * what a sighted user reads off the chip. The pictogram beside it repeats the
 * node's colour AND glyph, so the legend teaches both channels.
 *
 * `useLegendTypeFilter` is the URL half: the existing `types` search parameter
 * (the SHOWN types; absent means all), through the same `hiddenFromShown` /
 * `shownParamFromHidden` helpers the page's own chips use, so the two agree and
 * a shared link restores the filter.
 */

import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { useCallback, useId, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { visuallyHidden } from '../../visuallyHidden.js';
import { hiddenFromShown, shownParamFromHidden } from '../../../headless/utils/explorerFilters.js';
import { STANCES, STANCE_COLORS, type ExplorerMode } from './explorerEncoding.js';
import type { LegendModel, LegendRelation, LegendType } from './explorerModel.js';
import { PICTOGRAMS, type PictogramName } from './icons/pictograms.js';

/**
 * Props of {@link GraphLegend}.
 *
 * @stability experimental
 */
export interface GraphLegendProps {
  /** The legend as data: `legendModel(state, nodeTypes, relationTypes, mode)`. */
  model: LegendModel;
  /** Light or dark variant, for the stance key's colours. Default `light`. */
  mode?: ExplorerMode;
  /** A type row was toggled. */
  onToggleType: (key: string) => void;
  /** A relation row was toggled; without it the relation section is a plain list. */
  onToggleRelation?: (key: string) => void;
  /** Heading of the legend. Default "Legend". */
  title?: string;
  /** Disable every toggle (a request is in flight). */
  disabled?: boolean;
}

function Glyph({ type }: { type: LegendType }) {
  const d = PICTOGRAMS[type.icon as PictogramName];
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden focusable="false" style={{ flexShrink: 0 }}>
      <circle cx={12} cy={12} r={12} fill={type.color} />
      <g transform="translate(4.8 4.8) scale(0.6)">
        <path d={d} fill={type.iconColor} fillRule="evenodd" />
      </g>
    </svg>
  );
}

const rowSx = {
  display: 'flex',
  alignItems: 'center',
  gap: 1,
  width: '100%',
  minHeight: 40,
  px: 1,
  py: 0.5,
  borderRadius: 1,
  textAlign: 'left',
  justifyContent: 'flex-start',
  '&:hover': { bgcolor: 'action.hover' },
  '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
} as const;

function describe(count: number, shown: boolean, noun: string): string {
  return shown ? `${count} ${noun}` : 'hidden';
}

function TypeRow({
  type,
  onToggle,
  disabled,
}: {
  type: LegendType;
  onToggle: (key: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <li>
      <ButtonBase
        sx={{ ...rowSx, opacity: type.shown ? 1 : 0.55 }}
        aria-pressed={type.shown}
        aria-describedby={id}
        disabled={disabled}
        onClick={() => onToggle(type.key)}
      >
        <Glyph type={type} />
        <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {type.label}
        </Typography>
        <Typography
          aria-hidden
          variant="caption"
          color="text.secondary"
          sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
        >
          {type.shown ? type.count : 'hidden'}
        </Typography>
      </ButtonBase>
      {/* Outside the button, so it describes it and is not part of its name. */}
      <Box component="span" id={id} sx={visuallyHidden}>
        {describe(type.count, type.shown, 'on the canvas')}
      </Box>
    </li>
  );
}

function RelationRow({
  relation,
  onToggle,
  disabled,
}: {
  relation: LegendRelation;
  onToggle?: (key: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const content = (
    <>
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
        {relation.label}
      </Typography>
      <Typography
        aria-hidden
        variant="caption"
        color="text.secondary"
        sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {relation.shown ? relation.count : 'hidden'}
      </Typography>
    </>
  );
  const description = (
    <Box component="span" id={id} sx={visuallyHidden}>
      {describe(relation.count, relation.shown, 'on the canvas')}
    </Box>
  );
  if (!onToggle) {
    return (
      <li>
        <Box sx={rowSx} aria-describedby={id}>
          {content}
        </Box>
        {description}
      </li>
    );
  }
  return (
    <li>
      <ButtonBase
        sx={{ ...rowSx, opacity: relation.shown ? 1 : 0.55 }}
        aria-pressed={relation.shown}
        aria-describedby={id}
        disabled={disabled}
        onClick={() => onToggle(relation.key)}
      >
        {content}
      </ButtonBase>
      {description}
    </li>
  );
}

const listSx = { listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 0.25 } as const;

/**
 * The legend and type filter. Renders a "Types" list of toggle buttons, a
 * "Relations" list when any relation is on the canvas, and the stance key when an
 * `INVOLVED_IN` edge carries a stance.
 *
 * @stability experimental
 */
export function GraphLegend({
  model,
  mode = 'light',
  onToggleType,
  onToggleRelation,
  title = 'Legend',
  disabled,
}: GraphLegendProps) {
  const headingId = useId();
  const typesId = useId();
  const relationsId = useId();
  const stanceId = useId();
  return (
    <Box component="section" aria-labelledby={headingId} sx={{ minWidth: 0 }}>
      <Typography id={headingId} variant="subtitle2" component="h2" sx={{ mb: 0.5 }}>
        {title}
      </Typography>

      <Typography id={typesId} variant="overline" color="text.secondary" component="h3" sx={{ display: 'block' }}>
        Types
      </Typography>
      {model.types.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing on the canvas yet.
        </Typography>
      ) : (
        <Box component="ul" aria-labelledby={typesId} sx={listSx}>
          {model.types.map((type) => (
            <TypeRow key={type.key} type={type} onToggle={onToggleType} disabled={disabled} />
          ))}
        </Box>
      )}

      {model.relations.length > 0 && (
        <>
          <Typography
            id={relationsId}
            variant="overline"
            color="text.secondary"
            component="h3"
            sx={{ display: 'block', mt: 1.5 }}
          >
            Relations
          </Typography>
          <Box component="ul" aria-labelledby={relationsId} sx={listSx}>
            {model.relations.map((relation) => (
              <RelationRow key={relation.key} relation={relation} onToggle={onToggleRelation} disabled={disabled} />
            ))}
          </Box>
        </>
      )}

      {model.hasStance && (
        <>
          <Typography
            id={stanceId}
            variant="overline"
            color="text.secondary"
            component="h3"
            sx={{ display: 'block', mt: 1.5 }}
          >
            Stance
          </Typography>
          <Box component="ul" aria-labelledby={stanceId} sx={listSx}>
            {STANCES.map((stance) => (
              <Box component="li" key={stance} sx={{ ...rowSx, minHeight: 28, '&:hover': undefined }}>
                <svg width={24} height={8} aria-hidden focusable="false" style={{ flexShrink: 0 }}>
                  <line x1={0} y1={4} x2={24} y2={4} stroke={STANCE_COLORS[mode][stance]} strokeWidth={3} />
                </svg>
                <Typography variant="body2" sx={{ textTransform: 'capitalize' }}>
                  {stance}
                </Typography>
              </Box>
            ))}
          </Box>
        </>
      )}
    </Box>
  );
}

/**
 * What {@link useLegendTypeFilter} returns.
 *
 * @stability experimental
 */
export interface LegendTypeFilter {
  /** Types currently hidden by the `types` URL parameter. */
  hiddenTypes: ReadonlySet<string>;
  /** Show a hidden type or hide a shown one; writes `types` (and drops it when nothing is hidden). */
  toggleType: (key: string) => void;
}

/**
 * The legend's type filter, kept in the existing `types` search parameter. The
 * parameter holds the SHOWN types (absent means all), so `?types=Person,Project`
 * round-trips: reload it and every other type reads as hidden.
 *
 * @param allTypeKeys - every type key the filter knows (the ontology's node types).
 * @returns The hidden types and a toggle that writes the URL.
 *
 * @stability experimental
 */
export function useLegendTypeFilter(allTypeKeys: readonly string[]): LegendTypeFilter {
  const [searchParams, setSearchParams] = useSearchParams();
  const typesParam = searchParams.get('types');
  const keysKey = allTypeKeys.join('\n');
  const hiddenTypes = useMemo(
    () => hiddenFromShown(typesParam, keysKey ? keysKey.split('\n') : []),
    [typesParam, keysKey],
  );
  const toggleType = useCallback(
    (key: string) => {
      const next = new Set(hiddenTypes);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      const shown = shownParamFromHidden(next, keysKey ? keysKey.split('\n') : []);
      setSearchParams(
        (previous) => {
          const params = new URLSearchParams(previous);
          if (shown === null) params.delete('types');
          else params.set('types', shown);
          return params;
        },
        { replace: true },
      );
    },
    [hiddenTypes, keysKey, setSearchParams],
  );
  return { hiddenTypes, toggleType };
}

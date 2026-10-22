/**
 * `PathPicker` — the form of path mode (GIC-13, #674): two entity fields (A and
 * B, searched with the same `listGraphEntities` call as the seed search), a
 * swap button, the longest path (2 to 5 hops) and the relation types a path may
 * follow. Nothing is searched until "Find paths".
 *
 * It renders the form only. `PathPickerHost` puts it in a full-screen sheet on
 * a phone and in a popover from the top bar elsewhere.
 */

import CloseIcon from '@mui/icons-material/Close';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import { useEffect, useId, useState } from 'react';

import type { GraphEntitySummary } from '../../../../headless/clients/graph.js';
import { useGraphEntities } from '../../../../headless/hooks/useGraphEntities.js';
import { EntityTypeIcon } from '../../entityTypeIcon.js';
import { MAX_PATH_HOPS, MIN_PATH_HOPS, type PathRequest } from './pathModel.js';

/**
 * An entity chosen in a field.
 *
 * @stability experimental
 */
export interface PathEndpoint {
  /** The entity's id. */
  id: string;
  /** Its label. */
  label: string;
  /** Its type key. */
  type: string;
}

/**
 * One relation type chip of the picker.
 *
 * @stability experimental
 */
export interface PathRelationOption {
  /** Relation type key. */
  key: string;
  /** Label shown on the chip. */
  label: string;
}

/**
 * Props of {@link PathPicker}.
 *
 * @stability experimental
 */
export interface PathPickerProps {
  /** A as it stands (from the URL or the entry point), or `null`. */
  from: PathEndpoint | null;
  /** B as it stands, or `null`. */
  to: PathEndpoint | null;
  /** The longest path as it stands. */
  maxHops: number;
  /** The relation types as they stand; empty means all. */
  relationTypes: readonly string[];
  /** Every relation type the ontology knows. */
  relationOptions: readonly PathRelationOption[];
  /** A coarse pointer: controls are at least 44px tall. */
  touch: boolean;
  /** Called with the request when the user presses "Find paths". */
  onSubmit: (request: Pick<PathRequest, 'from' | 'to' | 'maxHops' | 'relationTypes'>, endpoints: { from: PathEndpoint; to: PathEndpoint }) => void;
}

function EntityField({
  label,
  value,
  onChange,
  touch,
}: {
  label: string;
  value: PathEndpoint | null;
  onChange: (next: PathEndpoint | null) => void;
  touch: boolean;
}) {
  const [input, setInput] = useState(value?.label ?? '');
  useEffect(() => {
    setInput(value?.label ?? '');
  }, [value?.id, value?.label]);
  const search = useGraphEntities({ q: input, limit: 8, enabled: input.trim().length > 0 && input !== value?.label });
  return (
    <Autocomplete<GraphEntitySummary | PathEndpoint, false, false, false>
      value={value}
      options={input.trim() && input !== value?.label ? search.data : value ? [value] : []}
      getOptionLabel={(option) => option.label}
      filterOptions={(options) => options}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      loading={search.isLoading && input.trim().length > 0}
      inputValue={input}
      onInputChange={(_event, next) => setInput(next)}
      onChange={(_event, next) => onChange(next ? { id: next.id, label: next.label, type: next.type } : null)}
      noOptionsText={input.trim() ? 'Nothing in your graph matches' : 'Type a name'}
      renderOption={(optionProps, option) => {
        const { key, ...rest } = optionProps as typeof optionProps & { key: string };
        return (
          <li key={key} {...rest} style={{ minHeight: touch ? 44 : undefined }}>
            <EntityTypeIcon type={option.type} fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {option.label}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {option.type}
              </Typography>
            </Box>
          </li>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          size="small"
          slotProps={{ ...params.slotProps, htmlInput: { ...params.slotProps.htmlInput, 'aria-label': label } }}
        />
      )}
    />
  );
}

/**
 * The picker's form: A, B, swap, hops, relation chips and the submit button.
 *
 * @stability experimental
 */
export function PathPicker(props: PathPickerProps) {
  const { relationOptions, touch, onSubmit } = props;
  const [from, setFrom] = useState<PathEndpoint | null>(props.from);
  const [to, setTo] = useState<PathEndpoint | null>(props.to);
  const [hops, setHops] = useState(props.maxHops);
  const [relations, setRelations] = useState<string[]>([...props.relationTypes]);
  const hopsId = useId();

  // A was filled in after the form opened (its label arrives from the API).
  useEffect(() => setFrom((current) => current ?? props.from), [props.from]);
  useEffect(() => setTo((current) => current ?? props.to), [props.to]);

  const ready = from !== null && to !== null && from.id !== to.id;
  const toggleRelation = (key: string) =>
    setRelations((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit({ from: from.id, to: to.id, maxHops: hops, relationTypes: relations }, { from, to });
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1, minWidth: 0 }}>
          <EntityField label="From (A)" value={from} onChange={setFrom} touch={touch} />
          <EntityField label="To (B)" value={to} onChange={setTo} touch={touch} />
        </Box>
        <IconButton
          aria-label="Swap A and B"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
          sx={{ width: 44, height: 44 }}
        >
          <SwapVertIcon />
        </IconButton>
      </Box>
      {from && to && from.id === to.id && (
        <Typography variant="caption" color="error" role="alert">
          Pick two different things.
        </Typography>
      )}

      <Box>
        <Typography id={hopsId} variant="subtitle2" component="h3" gutterBottom>
          Longest connection
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={hops}
          aria-labelledby={hopsId}
          onChange={(_event, next: number | null) => {
            if (next !== null) setHops(next);
          }}
        >
          {Array.from({ length: MAX_PATH_HOPS - MIN_PATH_HOPS + 1 }, (_unused, i) => MIN_PATH_HOPS + i).map((n) => (
            <ToggleButton key={n} value={n} aria-label={`${n} hops`} sx={{ minWidth: 44, minHeight: touch ? 44 : undefined }}>
              {n}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          hops
        </Typography>
      </Box>

      {relationOptions.length > 0 && (
        <Box>
          <Typography variant="subtitle2" component="h3" gutterBottom>
            Only follow {relations.length === 0 ? '(all relations)' : `(${relations.length})`}
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, maxHeight: 160, overflowY: 'auto' }}>
            {relationOptions.map((option) => {
              const on = relations.includes(option.key);
              return (
                <Chip
                  key={option.key}
                  size="small"
                  label={option.label}
                  color={on ? 'primary' : 'default'}
                  variant={on ? 'filled' : 'outlined'}
                  onClick={() => toggleRelation(option.key)}
                  aria-pressed={on}
                  sx={touch ? { minHeight: 44 } : undefined}
                />
              );
            })}
          </Box>
        </Box>
      )}

      <Button type="submit" variant="contained" disabled={!ready} sx={{ alignSelf: 'flex-start', minHeight: touch ? 44 : undefined }}>
        Find paths
      </Button>
    </Box>
  );
}

/**
 * Props of {@link PathPickerHost}.
 *
 * @stability experimental
 */
export interface PathPickerHostProps extends PathPickerProps {
  /** Whether the picker is open. */
  open: boolean;
  /** A phone: a full-screen sheet instead of a popover. */
  fullScreen: boolean;
  /** The element a popover hangs from (the top bar's button); absent: the top centre of the window. */
  anchorEl: HTMLElement | null;
  /** Called when the picker is dismissed. */
  onClose: () => void;
}

/**
 * Where the picker lives: a full-screen sheet on a phone, a popover from the top bar elsewhere.
 *
 * @stability experimental
 */
export function PathPickerHost(props: PathPickerHostProps) {
  const { open, fullScreen, anchorEl, onClose, ...form } = props;
  const titleId = useId();
  const title = 'Connect two things';
  if (fullScreen) {
    return (
      <Dialog open={open} onClose={onClose} fullScreen aria-labelledby={titleId}>
        <DialogTitle id={titleId} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {title}
          <IconButton aria-label="Close" onClick={onClose} sx={{ width: 44, height: 44 }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <PathPicker {...form} />
        </DialogContent>
      </Dialog>
    );
  }
  const anchored = anchorEl !== null && anchorEl.isConnected;
  return (
    <Popover
      open={open}
      onClose={onClose}
      {...(anchored
        ? { anchorEl, anchorOrigin: { vertical: 'bottom' as const, horizontal: 'right' as const }, transformOrigin: { vertical: 'top' as const, horizontal: 'right' as const } }
        : {
            anchorReference: 'anchorPosition' as const,
            anchorPosition: { top: 96, left: typeof window === 'undefined' ? 0 : window.innerWidth / 2 },
            transformOrigin: { vertical: 'top' as const, horizontal: 'center' as const },
          })}
      slotProps={{ paper: { 'aria-labelledby': titleId, sx: { width: 420, maxWidth: 'calc(100vw - 32px)', p: 2 } } }}
    >
      <Typography id={titleId} variant="h6" component="h2" gutterBottom>
        {title}
      </Typography>
      <PathPicker {...form} />
    </Popover>
  );
}

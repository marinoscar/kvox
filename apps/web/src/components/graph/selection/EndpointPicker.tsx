/**
 * Pick an entity for a new row's endpoint (#368): one of THIS DRAFT's entity
 * rows ("In this draft", listed first — the person the note just mentioned is
 * usually not in the graph yet) or an entity already in the user's graph
 * (#370's search, debounced).
 */

import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { useEffect, useMemo, useState } from 'react';

import { useIsMounted } from '../../../hooks/useIsMounted';
import { searchGraphEntities } from '../../../services/graph';
import type { EndpointRef, ProposalItem } from '../../../services/graph';
import { ENTITY_SEARCH_DEBOUNCE_MS } from '../schema/EntitySearchField';

export interface EndpointOption {
  key: string;
  group: 'In this draft' | 'In your graph';
  label: string;
  type: string;
  endpoint: EndpointRef;
}

/** The draft's entity rows a new row may point at (rejected rows excluded). */
export function draftEntityOptions(items: readonly ProposalItem[]): EndpointOption[] {
  return items
    .filter((item) => item.kind === 'entity' && item.decision !== 'reject')
    .flatMap((item) => {
      const payload = item.effectivePayload as { ref?: unknown; type?: unknown };
      if (typeof payload.ref !== 'string') return [];
      return [
        {
          key: `ref:${payload.ref}`,
          group: 'In this draft' as const,
          label: item.display.title,
          type: typeof payload.type === 'string' ? payload.type : '',
          endpoint: { ref: payload.ref },
        },
      ];
    });
}

export interface EndpointPickerProps {
  label: string;
  items: readonly ProposalItem[];
  /** Allowed entity type keys; empty/absent = any. */
  types?: readonly string[];
  value: EndpointOption | null;
  onChange: (value: EndpointOption | null) => void;
  required?: boolean;
  error?: string | null;
  disabled?: boolean;
}

export function EndpointPicker({ label, items, types, value, onChange, required, error, disabled }: EndpointPickerProps) {
  const [input, setInput] = useState('');
  const [found, setFound] = useState<EndpointOption[]>([]);
  const isMounted = useIsMounted();
  const typeKey = (types ?? []).join(',');

  const draft = useMemo(() => {
    const allowed = typeKey ? typeKey.split(',') : [];
    return draftEntityOptions(items).filter((option) => allowed.length === 0 || allowed.includes(option.type));
  }, [items, typeKey]);

  useEffect(() => {
    const q = input.trim();
    if (!q || (value && q === value.label)) {
      setFound([]);
      return;
    }
    const allowed = typeKey ? typeKey.split(',') : [];
    const timer = window.setTimeout(() => {
      searchGraphEntities({ q, type: allowed.length === 1 ? allowed[0] : undefined, limit: 10 })
        .then((rows) => {
          if (!isMounted()) return;
          setFound(
            rows
              .filter((row) => allowed.length === 0 || allowed.includes(row.type))
              .map((row) => ({
                key: `entity:${row.id}`,
                group: 'In your graph' as const,
                label: row.label,
                type: row.type,
                endpoint: { entityId: row.id },
              })),
          );
        })
        .catch(() => {
          if (isMounted()) setFound([]);
        });
    }, ENTITY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [input, isMounted, typeKey, value]);

  const options = [...draft, ...found];
  if (value && !options.some((option) => option.key === value.key)) options.push(value);

  return (
    <Autocomplete
      value={value}
      options={options}
      disabled={disabled}
      groupBy={(option) => option.group}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.key === selected.key}
      filterOptions={(list, state) => {
        const q = state.inputValue.trim().toLowerCase();
        return list.filter((option) => option.group === 'In your graph' || !q || option.label.toLowerCase().includes(q));
      }}
      onInputChange={(_event, next) => setInput(next)}
      onChange={(_event, next) => onChange(next)}
      noOptionsText={input.trim() ? 'No matches' : 'Type to search your graph'}
      renderInput={(params) => (
        <TextField
          {...params}
          size="small"
          label={label}
          required={required}
          error={Boolean(error)}
          helperText={error ?? undefined}
        />
      )}
    />
  );
}

export default EndpointPicker;

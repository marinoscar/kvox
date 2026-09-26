/**
 * Search the caller's own graph for an entity (#367; #370's
 * `GET /api/graph/entities?type&q&limit`). Used by re-linking, merge-into and
 * every `entity_ref` attribute. Results are debounced and limited to ten.
 */

import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { useEffect, useState } from 'react';

import { useIsMounted } from '../../../hooks/useIsMounted';
import { searchGraphEntities } from '../../../services/graph';
import type { GraphEntitySearchResult } from '../../../services/graph';

export const ENTITY_SEARCH_DEBOUNCE_MS = 250;

export interface EntitySearchFieldProps {
  label: string;
  /** Allowed entity type keys. One → sent as `type`; several → filtered here. */
  types?: readonly string[];
  value: GraphEntitySearchResult | null;
  onChange: (value: GraphEntitySearchResult | null) => void;
  /** Ids never offered (e.g. candidates marked "not the same"). */
  excludeIds?: readonly string[];
  error?: string | null;
  helperText?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export function EntitySearchField({
  label,
  types,
  value,
  onChange,
  excludeIds = [],
  error,
  helperText,
  disabled,
  autoFocus,
}: EntitySearchFieldProps) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<GraphEntitySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const isMounted = useIsMounted();
  const typeKey = (types ?? []).join(',');
  const excludeKey = excludeIds.join(',');

  useEffect(() => {
    const q = input.trim();
    if (!q) {
      setOptions([]);
      return;
    }
    const allowed = typeKey ? typeKey.split(',') : [];
    const excluded = new Set(excludeKey ? excludeKey.split(',') : []);
    const timer = window.setTimeout(() => {
      setLoading(true);
      searchGraphEntities({ q, type: allowed.length === 1 ? allowed[0] : undefined, limit: 10 })
        .then((rows) => {
          if (!isMounted()) return;
          setOptions(
            rows.filter(
              (row) => !excluded.has(row.id) && (allowed.length === 0 || allowed.includes(row.type)),
            ),
          );
        })
        .catch(() => {
          if (isMounted()) setOptions([]);
        })
        .finally(() => {
          if (isMounted()) setLoading(false);
        });
    }, ENTITY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [excludeKey, input, isMounted, typeKey]);

  return (
    <Autocomplete
      value={value}
      options={value && !options.some((o) => o.id === value.id) ? [value, ...options] : options}
      loading={loading}
      disabled={disabled}
      filterOptions={(x) => x}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(option, selected) => option.id === selected.id}
      onInputChange={(_event, next) => setInput(next)}
      onChange={(_event, next) => onChange(next)}
      noOptionsText={input.trim() ? 'No matches in your graph' : 'Type to search your graph'}
      renderOption={(props, option) => {
        const { key, ...rest } = props as typeof props & { key: string };
        return (
          <li key={key} {...rest}>
            {option.label}
            {option.aliases.length > 0 ? ` (${option.aliases.join(', ')})` : ''} · {option.type}
          </li>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          autoFocus={autoFocus}
          error={Boolean(error)}
          helperText={error ?? helperText}
        />
      )}
    />
  );
}

export default EntitySearchField;

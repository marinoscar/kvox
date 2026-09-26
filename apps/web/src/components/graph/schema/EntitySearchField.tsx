/**
 * `EntitySearchField` — pick an entity of the caller's graph by name, for an
 * `entity_ref` attribute (§17.4). Searches `GET /api/graph/entities?q=` limited
 * to the attribute's `targetTypes`.
 *
 * ⚠ Issue #367 specifies this component for the proposal sheet. This is a
 * minimal implementation created here because #367 had not merged; whichever
 * lands second keeps one file.
 */

import Autocomplete from '@mui/material/Autocomplete';
import TextField from '@mui/material/TextField';
import { useEffect, useState } from 'react';

import { listGraphEntities } from '../../../services/graph';
import type { GraphEntitySummary } from '../../../services/graph';
import { useDebouncedValue } from '../../../hooks/useGraphEntities';

export interface EntitySearchFieldProps {
  label: string;
  /** The referenced entity id, or null. */
  value: string | null;
  onChange: (id: string | null) => void;
  targetTypes?: readonly string[];
  disabled?: boolean;
  error?: string;
  helperText?: string;
}

type Option = Pick<GraphEntitySummary, 'id' | 'label' | 'type'>;

export function EntitySearchField({
  label,
  value,
  onChange,
  targetTypes,
  disabled,
  error,
  helperText,
}: EntitySearchFieldProps) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<Option[]>([]);
  const [selected, setSelected] = useState<Option | null>(
    value ? { id: value, label: 'Linked entity', type: '' } : null,
  );
  const debounced = useDebouncedValue(input.trim(), 250);
  const typesKey = (targetTypes ?? []).join(',');

  useEffect(() => {
    if (!debounced) {
      setOptions([]);
      return undefined;
    }
    const controller = new AbortController();
    listGraphEntities(
      { q: debounced, type: typesKey ? typesKey.split(',') : undefined, limit: 10 },
      controller.signal,
    )
      .then((page) => {
        if (!controller.signal.aborted) setOptions(page.items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setOptions([]);
      });
    return () => controller.abort();
  }, [debounced, typesKey]);

  return (
    <Autocomplete<Option>
      options={options}
      value={selected}
      disabled={disabled}
      filterOptions={(x) => x}
      getOptionLabel={(option) => option.label}
      isOptionEqualToValue={(a, b) => a.id === b.id}
      onInputChange={(_, next) => setInput(next)}
      onChange={(_, next) => {
        setSelected(next);
        onChange(next?.id ?? null);
      }}
      renderInput={(params) => (
        <TextField {...params} label={label} error={Boolean(error)} helperText={error ?? helperText} />
      )}
    />
  );
}

export default EntitySearchField;

/**
 * One ontology attribute as a form widget (#367; ontology.md §13, §17.4).
 *
 * `kind` → widget, and nothing else: text `TextField`, number `type=number`,
 * date `type=date`, boolean `Switch`, select `Select`, multi_select
 * `Autocomplete multiple`, url `type=url`, entity_ref `EntitySearchField`.
 * A `list` attribute of a scalar kind is a free-entry chip list. There is no
 * per-type code anywhere: a type added to the ontology renders here unchanged.
 */

import Autocomplete from '@mui/material/Autocomplete';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import { useState } from 'react';

import type { GraphAttribute } from '../../../services/graph';
import { EntitySearchField } from './EntitySearchField';

export interface AttributeFieldProps {
  attribute: GraphAttribute;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string | null;
  readOnly?: boolean;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function EntityRefField({ attribute, value, onChange, error, readOnly }: AttributeFieldProps) {
  const id = typeof value === 'string' ? value : null;
  const [selected, setSelected] = useState<{ id: string; label: string; type: string; aliases: string[] } | null>(
    id ? { id, label: id, type: '', aliases: [] } : null,
  );
  return (
    <EntitySearchField
      label={attribute.label}
      types={attribute.options?.targetTypes}
      value={selected}
      disabled={readOnly}
      error={error}
      helperText={attribute.deprecated ? 'Retired field' : undefined}
      onChange={(next) => {
        setSelected(next);
        onChange(next ? next.id : null);
      }}
    />
  );
}

export function AttributeField(props: AttributeFieldProps) {
  const { attribute, value, onChange, error, readOnly } = props;
  const helperText = error ?? (attribute.deprecated ? 'Retired field — shown because it has a value' : undefined);
  const common = {
    label: attribute.label,
    fullWidth: true,
    size: 'small' as const,
    error: Boolean(error),
    helperText,
    disabled: readOnly,
    required: attribute.required,
  };
  const choices = attribute.options?.choices ?? [];

  switch (attribute.kind) {
    case 'boolean':
      return (
        <Box>
          <FormControlLabel
            control={
              <Switch
                checked={value === true}
                disabled={readOnly}
                onChange={(event) => onChange(event.target.checked)}
              />
            }
            label={attribute.label}
          />
          {helperText && <FormHelperText error={Boolean(error)}>{helperText}</FormHelperText>}
        </Box>
      );
    case 'select':
      return (
        <TextField
          {...common}
          select
          value={asString(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        >
          <MenuItem value="">
            <em>None</em>
          </MenuItem>
          {choices.map((choice) => (
            <MenuItem key={choice.value} value={choice.value}>
              {choice.label}
            </MenuItem>
          ))}
        </TextField>
      );
    case 'multi_select':
      return (
        <Autocomplete
          multiple
          disabled={readOnly}
          options={choices.map((choice) => choice.value)}
          getOptionLabel={(option) => choices.find((choice) => choice.value === option)?.label ?? option}
          value={asStringArray(value)}
          onChange={(_event, next) => onChange(next)}
          renderInput={(params) => (
            <TextField {...params} label={attribute.label} size="small" error={Boolean(error)} helperText={helperText} />
          )}
        />
      );
    case 'entity_ref':
      return <EntityRefField {...props} />;
    case 'number':
      return (
        <TextField
          {...common}
          type="number"
          value={asString(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
        />
      );
    case 'date':
      return (
        <TextField
          {...common}
          type="date"
          value={asString(value)}
          slotProps={{ inputLabel: { shrink: true } }}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
      );
    default: {
      // text, url — and any kind a newer server adds, as plain text.
      if (attribute.list) {
        return (
          <Autocomplete
            multiple
            freeSolo
            disabled={readOnly}
            options={[] as string[]}
            value={asStringArray(value)}
            onChange={(_event, next) => onChange(next)}
            renderInput={(params) => (
              <TextField {...params} label={attribute.label} size="small" error={Boolean(error)} helperText={helperText} />
            )}
          />
        );
      }
      return (
        <TextField
          {...common}
          type={attribute.kind === 'url' ? 'url' : 'text'}
          value={asString(value)}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
      );
    }
  }
}

export default AttributeField;

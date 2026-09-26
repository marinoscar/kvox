/**
 * `AttributeField` — one control for one ontology attribute, chosen by `kind`
 * (§17.4). NO PER-TYPE CODE: a type or attribute added to the ontology renders
 * through this switch with zero web changes.
 *
 * ⚠ Issue #367 specifies this component for the proposal sheet. This is a
 * minimal implementation created here because #367 had not merged; whichever
 * lands second keeps one file.
 */

import Autocomplete from '@mui/material/Autocomplete';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import { useId } from 'react';

import type { GraphAttributeDef } from '../../../services/graph';
import { EntitySearchField } from './EntitySearchField';

export interface AttributeFieldProps {
  attribute: GraphAttributeDef;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  disabled?: boolean;
}

function asString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export function AttributeField({ attribute, value, onChange, error, disabled }: AttributeFieldProps) {
  const id = useId();
  const readOnly = disabled || attribute.deprecated;
  const label = attribute.deprecated ? `${attribute.label} (retired)` : attribute.label;
  const helper = error ?? (attribute.source === 'user' ? attribute.description : undefined);
  const choices = attribute.options?.choices ?? [];

  if (attribute.kind === 'boolean') {
    return (
      <FormControl error={Boolean(error)}>
        <FormControlLabel
          control={
            <Switch
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
              disabled={readOnly}
            />
          }
          label={label}
        />
        {helper && <FormHelperText>{helper}</FormHelperText>}
      </FormControl>
    );
  }

  if (attribute.kind === 'select' || attribute.kind === 'multi_select') {
    const multiple = attribute.kind === 'multi_select' || attribute.list;
    return (
      <FormControl fullWidth error={Boolean(error)} disabled={readOnly}>
        <InputLabel id={`${id}-label`}>{label}</InputLabel>
        <Select
          labelId={`${id}-label`}
          label={label}
          multiple={multiple}
          value={multiple ? asStringList(value) : asString(value)}
          onChange={(event) => {
            const next = event.target.value;
            if (multiple) onChange(typeof next === 'string' ? next.split(',') : next);
            else onChange(next === '' ? null : next);
          }}
        >
          {!multiple && (
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
          )}
          {choices.map((choice) => (
            <MenuItem key={choice.value} value={choice.value}>
              {choice.label}
            </MenuItem>
          ))}
        </Select>
        {helper && <FormHelperText>{helper}</FormHelperText>}
      </FormControl>
    );
  }

  if (attribute.kind === 'entity_ref' && !attribute.list) {
    return (
      <EntitySearchField
        label={label}
        value={typeof value === 'string' ? value : null}
        onChange={onChange}
        targetTypes={attribute.options?.targetTypes}
        disabled={readOnly}
        error={error}
        helperText={helper}
      />
    );
  }

  if (attribute.list) {
    return (
      <Autocomplete<string, true, false, true>
        multiple
        freeSolo
        options={[]}
        value={asStringList(value)}
        disabled={readOnly}
        onChange={(_, next) => onChange(next)}
        renderInput={(params) => (
          <TextField {...params} label={label} error={Boolean(error)} helperText={helper} />
        )}
      />
    );
  }

  const inputType =
    attribute.kind === 'number' ? 'number' : attribute.kind === 'date' ? 'date' : attribute.kind === 'url' ? 'url' : 'text';

  return (
    <TextField
      fullWidth
      label={label}
      type={inputType}
      value={asString(value)}
      disabled={readOnly}
      required={attribute.required}
      error={Boolean(error)}
      helperText={helper}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw === '') onChange(null);
        else if (attribute.kind === 'number') onChange(Number(raw));
        else onChange(raw);
      }}
      slotProps={inputType === 'date' ? { inputLabel: { shrink: true } } : undefined}
    />
  );
}

export default AttributeField;

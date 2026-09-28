/**
 * The attributes of one ontology type, as a form (#367; ontology.md §13,
 * §17.4). Driven entirely by `GET /api/graph/ontology`'s effective payload:
 * built-in, mixin and the user's own attributes alike, in `sortOrder`.
 * A deprecated attribute renders only when it carries a value, read-only —
 * with a "Clear retired value" button (#442) that removes the key from the
 * form value, exactly as emptying a live field does. The field then leaves the
 * form (it no longer has a value); a polite status line says so, and the
 * caller's save turns the missing key into the removal: the entity edit
 * dialog's diff sends `props: { key: null }`, a proposal item's payload
 * simply no longer carries it. Cancel is the undo, as for any other edit.
 */

import ClearIcon from '@mui/icons-material/Clear';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { useRef, useState } from 'react';

import type { GraphAttribute } from '../../../services/graph';
import { AttributeField } from './AttributeField';

export interface SchemaFormProps {
  attributes: readonly GraphAttribute[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Keyed by attribute key. */
  errors?: Record<string, string>;
  readOnly?: boolean;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** The attributes a form shows: live ones, plus retired ones that carry a value. */
export function visibleAttributes(
  attributes: readonly GraphAttribute[],
  value: Record<string, unknown>,
): GraphAttribute[] {
  return [...attributes]
    .filter((attribute) => !attribute.deprecated || hasValue(value[attribute.key]))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function SchemaForm({ attributes, value, onChange, errors = {}, readOnly }: SchemaFormProps) {
  const [announcement, setAnnouncement] = useState('');
  const formRef = useRef<HTMLDivElement>(null);
  const shown = visibleAttributes(attributes, value);

  const write = (key: string, next: unknown) => {
    const updated = { ...value };
    if (next === null || next === undefined) delete updated[key];
    else updated[key] = next;
    onChange(updated);
  };

  const clearRetired = (attribute: GraphAttribute) => {
    write(attribute.key, null);
    setAnnouncement(`${attribute.label} cleared. It will be removed when you save.`);
    // The button leaves with its field; keep focus inside the form rather than
    // dropping it to the document body.
    formRef.current?.focus();
  };

  if (shown.length === 0 && !announcement) return null;
  return (
    <>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>
      {shown.length > 0 && (
        <Stack spacing={2} ref={formRef} tabIndex={-1} sx={{ outline: 'none' }}>
          {shown.map((attribute) => {
            const field = (
              <AttributeField
                key={attribute.key}
                attribute={attribute}
                value={value[attribute.key]}
                error={errors[attribute.key]}
                readOnly={readOnly || attribute.deprecated}
                onChange={(next) => write(attribute.key, next)}
              />
            );
            if (!attribute.deprecated) return field;
            const clearLabel = `Clear retired value: ${attribute.label}`;
            return (
              <Box key={attribute.key} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>{field}</Box>
                {!readOnly && (
                  <Tooltip title={clearLabel}>
                    <IconButton aria-label={clearLabel} size="small" onClick={() => clearRetired(attribute)} sx={{ mt: 0.5 }}>
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            );
          })}
        </Stack>
      )}
    </>
  );
}

export default SchemaForm;

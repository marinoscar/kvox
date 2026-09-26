/**
 * The attributes of one ontology type, as a form (#367; ontology.md §13,
 * §17.4). Driven entirely by `GET /api/graph/ontology`'s effective payload:
 * built-in, mixin and the user's own attributes alike, in `sortOrder`.
 * A deprecated attribute renders only when it carries a value, read-only.
 */

import Stack from '@mui/material/Stack';

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
  const shown = visibleAttributes(attributes, value);
  if (shown.length === 0) return null;
  return (
    <Stack spacing={2}>
      {shown.map((attribute) => (
        <AttributeField
          key={attribute.key}
          attribute={attribute}
          value={value[attribute.key]}
          error={errors[attribute.key]}
          readOnly={readOnly || attribute.deprecated}
          onChange={(next) => {
            const updated = { ...value };
            if (next === null || next === undefined) delete updated[attribute.key];
            else updated[attribute.key] = next;
            onChange(updated);
          }}
        />
      ))}
    </Stack>
  );
}

export default SchemaForm;

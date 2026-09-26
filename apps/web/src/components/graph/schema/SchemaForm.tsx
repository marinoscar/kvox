/**
 * `SchemaForm` — every attribute of one ontology type, as a form (§13, §17.4).
 *
 * Generated from the effective-schema payload (`GET /api/graph/ontology`),
 * never a per-type component: a type added to the definition file renders here
 * with zero web changes. Deprecated attributes appear read-only, and only when
 * they still carry a value.
 *
 * ⚠ Issue #367 specifies this component for the proposal sheet. This is a
 * minimal implementation of that contract created here because #367 had not
 * merged; whichever lands second keeps one file.
 */

import Stack from '@mui/material/Stack';

import type { GraphAttributeDef } from '../../../services/graph';
import { AttributeField } from './AttributeField';

export interface SchemaFormProps {
  attributes: readonly GraphAttributeDef[];
  values: Readonly<Record<string, unknown>>;
  onChange: (key: string, value: unknown) => void;
  errors?: Readonly<Record<string, string>>;
  disabled?: boolean;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function SchemaForm({ attributes, values, onChange, errors, disabled }: SchemaFormProps) {
  const visible = [...attributes]
    .filter((attribute) => !attribute.deprecated || hasValue(values[attribute.key]))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  if (visible.length === 0) return null;

  return (
    <Stack spacing={2}>
      {visible.map((attribute) => (
        <AttributeField
          key={attribute.key}
          attribute={attribute}
          value={values[attribute.key]}
          onChange={(value) => onChange(attribute.key, value)}
          error={errors?.[attribute.key]}
          disabled={disabled}
        />
      ))}
    </Stack>
  );
}

export default SchemaForm;

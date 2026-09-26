import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { render } from '../../utils/test-utils';
import { graphReader } from '../../utils/graphTestUsers';
import { SchemaForm } from '../../../components/graph/schema/SchemaForm';
import type { GraphAttributeDef } from '../../../services/graph';

/**
 * The schema-driven form (#373's minimal stand-in for #367's): one control per
 * attribute, chosen by `kind`, with no per-type code — so a type nobody coded
 * for renders here unchanged.
 */

function attr(key: string, kind: GraphAttributeDef['kind'], overrides: Partial<GraphAttributeDef> = {}): GraphAttributeDef {
  return {
    key,
    label: key,
    kind,
    required: false,
    list: false,
    options: null,
    extractable: true,
    description: `${key} hint`,
    sensitivity: 'business',
    source: 'builtin',
    domain: 'core',
    attributeDefId: null,
    deprecated: false,
    sortOrder: 0,
    ...overrides,
  };
}

const ATTRIBUTES: GraphAttributeDef[] = [
  attr('Text', 'text', { sortOrder: 1 }),
  attr('Count', 'number', { sortOrder: 2 }),
  attr('Started', 'date', { sortOrder: 3 }),
  attr('Active', 'boolean', { sortOrder: 4 }),
  attr('Stage', 'select', { sortOrder: 5, options: { choices: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] } }),
  attr('Home page', 'url', { sortOrder: 6 }),
  attr('Tags', 'text', { sortOrder: 7, list: true }),
  attr('Employer', 'entity_ref', { sortOrder: 8, options: { targetTypes: ['Organization'] } }),
  attr('Custom', 'text', { sortOrder: 9, source: 'user' }),
  attr('Old', 'text', { sortOrder: 10, deprecated: true }),
  attr('Gone', 'text', { sortOrder: 11, deprecated: true }),
];

function Harness({ onChange }: { onChange: (key: string, value: unknown) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({ Old: 'kept' });
  return (
    <SchemaForm
      attributes={ATTRIBUTES}
      values={values}
      errors={{ Text: 'Bad text' }}
      onChange={(key, value) => {
        onChange(key, value);
        setValues((current) => ({ ...current, [key]: value }));
      }}
    />
  );
}

describe('SchemaForm', () => {
  it('renders one control per kind and reports typed values', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />, { wrapperOptions: { user: graphReader } });

    expect(screen.getByText('Bad text')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Text' }), 'x');
    expect(onChange).toHaveBeenLastCalledWith('Text', 'x');

    await user.type(screen.getByRole('spinbutton', { name: 'Count' }), '7');
    expect(onChange).toHaveBeenLastCalledWith('Count', 7);

    await user.click(screen.getByRole('switch', { name: 'Active' }));
    expect(onChange).toHaveBeenLastCalledWith('Active', true);

    await user.click(screen.getByRole('combobox', { name: 'Stage' }));
    await user.click(await screen.findByRole('option', { name: 'Beta' }));
    expect(onChange).toHaveBeenLastCalledWith('Stage', 'b');

    const url = screen.getByRole('textbox', { name: 'Home page' });
    expect(url).toHaveAttribute('type', 'url');
    await user.type(url, 'h');
    await user.clear(url);
    expect(onChange).toHaveBeenLastCalledWith('Home page', null);

    await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'one{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('Tags', ['one']);

    // A user attribute shows its hint; a retired one with a value is read-only;
    // a retired one without a value is not rendered at all.
    expect(screen.getByText('Custom hint')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Old (retired)' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: /Gone/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Started')).toHaveAttribute('type', 'date');
  });

  it('searches the graph for an entity reference', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />, { wrapperOptions: { user: graphReader } });

    await user.type(screen.getByRole('combobox', { name: 'Employer' }), 'acm');
    const listbox = await screen.findByRole('listbox', {}, { timeout: 3000 });
    await user.click(within(listbox).getByRole('option', { name: 'Acme Corp' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('Employer', expect.any(String)));
  });

  it('renders nothing for a type with no attributes', () => {
    const { container } = render(<SchemaForm attributes={[]} values={{}} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

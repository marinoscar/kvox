import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { SchemaForm, visibleAttributes } from '../../../components/graph/schema/SchemaForm';
import type { GraphAttribute } from '../../../services/graph';
import { render } from '../../utils/test-utils';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function attr(key: string, kind: GraphAttribute['kind'], overrides: Partial<GraphAttribute> = {}): GraphAttribute {
  return {
    key,
    label: key[0].toUpperCase() + key.slice(1),
    kind,
    required: false,
    list: false,
    options: null,
    extractable: true,
    description: key,
    sensitivity: 'business',
    source: 'builtin',
    domain: 'core',
    attributeDefId: null,
    deprecated: false,
    sortOrder: 0,
    ...overrides,
  };
}

const EVERY_KIND: GraphAttribute[] = [
  attr('nickname', 'text'),
  attr('headcount', 'number'),
  attr('founded', 'date'),
  attr('active', 'boolean'),
  attr('stage', 'select', { options: { choices: [{ value: 'seed', label: 'Seed' }, { value: 'growth', label: 'Growth' }] } }),
  attr('markets', 'multi_select', { options: { choices: [{ value: 'eu', label: 'Europe' }] } }),
  attr('website', 'url'),
  attr('parent', 'entity_ref', { options: { targetTypes: ['Organization'] } }),
];

function Harness({ attributes, initial = {}, onChange }: { attributes: GraphAttribute[]; initial?: Record<string, unknown>; onChange?: (v: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <SchemaForm
      attributes={attributes}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('SchemaForm', () => {
  it('maps every attribute kind to its widget', async () => {
    const { container } = render(<Harness attributes={EVERY_KIND} />);
    expect(screen.getByRole('textbox', { name: 'Nickname' })).toHaveAttribute('type', 'text');
    expect(screen.getByRole('spinbutton', { name: 'Headcount' })).toBeInTheDocument();
    expect(screen.getByLabelText('Founded')).toHaveAttribute('type', 'date');
    expect(screen.getByRole('switch', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Stage' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Markets' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Website' })).toHaveAttribute('type', 'url');
    expect(screen.getByRole('combobox', { name: 'Parent' })).toBeInTheDocument();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('writes values back under the attribute key, and clears empties', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness attributes={EVERY_KIND} onChange={onChange} />);
    await user.type(screen.getByRole('textbox', { name: 'Nickname' }), 'Sam');
    expect(onChange).toHaveBeenLastCalledWith({ nickname: 'Sam' });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Headcount' }), { target: { value: '12' } });
    expect(onChange).toHaveBeenLastCalledWith({ nickname: 'Sam', headcount: 12 });
    await user.click(screen.getByRole('switch', { name: 'Active' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }));
    await user.clear(screen.getByRole('textbox', { name: 'Nickname' }));
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty('nickname');
  });

  it('shows a retired attribute only when it has a value, read-only', () => {
    const retired = attr('desk', 'text', { deprecated: true });
    expect(visibleAttributes([retired], {})).toEqual([]);
    render(<Harness attributes={[retired]} initial={{ desk: '4B' }} />);
    expect(screen.getByRole('textbox', { name: 'Desk' })).toBeDisabled();
    expect(screen.getByText('Retired field — shown because it has a value')).toBeInTheDocument();
  });

  it('renders a list attribute as free entry chips', () => {
    render(<Harness attributes={[attr('tags', 'text', { list: true })]} initial={{ tags: ['a', 'b'] }} />);
    expect(screen.getByRole('combobox', { name: 'Tags' })).toBeInTheDocument();
    expect(screen.getByText('a')).toBeInTheDocument();
  });
});

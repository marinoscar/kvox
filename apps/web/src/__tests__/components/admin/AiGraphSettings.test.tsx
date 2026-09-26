/**
 * `AiGraphSettings` — the "Connected knowledge" section of `/admin/settings/ai`
 * (issue #361): the `ai.graphEnabled` switch and its cost statement.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import { AiGraphSettings } from '../../../components/admin/AiGraphSettings';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const graphSwitch = () => screen.getByRole('switch', { name: /enable connected knowledge/i });

describe('AiGraphSettings', () => {
  it('states who pays, beside the switch', () => {
    render(<AiGraphSettings value={false} onChange={vi.fn()} aiEnabled disabled={false} />);

    expect(
      screen.getByRole('heading', { level: 2, name: 'Connected knowledge' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/runs on the requesting user's own ai key and bills their provider account/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/nothing enters anyone's graph without their review/i)
    ).toBeInTheDocument();
  });

  it('calls onChange with the new value when toggled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AiGraphSettings value={false} onChange={onChange} aiEnabled disabled={false} />);

    expect(graphSwitch()).not.toBeChecked();
    await user.click(graphSwitch());

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('explains that it cannot run while AI itself is off', () => {
    const { rerender } = render(
      <AiGraphSettings value onChange={vi.fn()} aiEnabled={false} disabled={false} />
    );

    expect(
      screen.getByText(
        /ai is switched off above, so connected knowledge cannot run until it is on/i
      )
    ).toBeInTheDocument();

    // Not when the graph is off, and not when AI is on.
    rerender(
      <AiGraphSettings value={false} onChange={vi.fn()} aiEnabled={false} disabled={false} />
    );
    expect(screen.queryByText(/ai is switched off above/i)).toBeNull();
    rerender(<AiGraphSettings value onChange={vi.fn()} aiEnabled disabled={false} />);
    expect(screen.queryByText(/ai is switched off above/i)).toBeNull();
  });

  it('is disabled when read-only', () => {
    render(<AiGraphSettings value onChange={vi.fn()} aiEnabled disabled />);

    expect(graphSwitch()).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <AiGraphSettings value onChange={vi.fn()} aiEnabled={false} disabled={false} />
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

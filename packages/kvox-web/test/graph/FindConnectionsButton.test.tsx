import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FindConnectionsButton } from '../../src/graph/ui/components/explorer/connect/ConnectResults.js';
import { gid } from './graphData.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => gid(300 + i));
const button = () => screen.getByRole('button', { name: /Find|Finding/ });

describe('FindConnectionsButton (GIC-14)', () => {
  it('is disabled below two entities, with the reason', () => {
    render(<FindConnectionsButton entityIds={ids(1)} max={3} busy={false} onFind={vi.fn()} touch={false} />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('title', 'Select at least two entities');
  });

  it('is disabled above the limit, with the reason', () => {
    render(<FindConnectionsButton entityIds={ids(4)} max={3} busy={false} onFind={vi.fn()} touch={false} />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute('title', 'Select at most 3 entities');
  });

  it('asks with the entities when two to the limit are given', async () => {
    const onFind = vi.fn();
    render(<FindConnectionsButton entityIds={ids(2)} max={3} busy={false} onFind={onFind} touch />);
    await userEvent.setup().click(button());
    expect(onFind).toHaveBeenCalledWith(ids(2));
  });

  it('is disabled and says so while a request is in flight', () => {
    render(<FindConnectionsButton entityIds={ids(2)} max={3} busy onFind={vi.fn()} touch={false} />);
    expect(screen.getByRole('button', { name: 'Finding…' })).toBeDisabled();
  });
});

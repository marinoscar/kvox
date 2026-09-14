/**
 * `AiModelDiscoveryDialog` — issue #97.
 *
 * The dialog is rendered directly with its props, not through
 * `AiSettingsPage`: everything it does is driven by `result`/`error`/
 * `alreadyPermitted`/`remainingCapacity` and reported back through
 * `onReload`/`onConfirm`, so a page harness would only add indirection. See
 * the component's own file header for the full behaviour contract this file
 * checks against.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { AiModelDiscoveryDialog } from '../../../components/admin/AiModelDiscoveryDialog';
import type { AiDiscoveredModel, AiModelDiscovery } from '../../../services/ai';

function model(overrides: Partial<AiDiscoveredModel> = {}): AiDiscoveredModel {
  return {
    id: 'gpt-9-turbo',
    label: 'gpt-9-turbo',
    known: false,
    contextWindowTokens: 32_000,
    maxOutputTokens: 4_096,
    source: 'default',
    derivedFrom: null,
    ...overrides,
  };
}

function discovery(models: AiDiscoveredModel[]): AiModelDiscovery {
  return { ok: true, detail: `Listed ${models.length} model(s).`, models };
}

interface RenderProps {
  onReload?: ReturnType<typeof vi.fn>;
  onConfirm?: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
  isLoading?: boolean;
  result?: AiModelDiscovery | null;
  error?: null;
  alreadyPermitted?: Set<string>;
  remainingCapacity?: number;
  open?: boolean;
}

function renderDialog(props: RenderProps = {}) {
  const onReload = props.onReload ?? vi.fn();
  const onConfirm = props.onConfirm ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();

  const utils = render(
    <AiModelDiscoveryDialog
      open={props.open ?? true}
      onClose={onClose}
      onReload={onReload}
      isLoading={props.isLoading ?? false}
      result={props.result === undefined ? discovery([model()]) : props.result}
      error={props.error ?? null}
      alreadyPermitted={props.alreadyPermitted ?? new Set()}
      remainingCapacity={props.remainingCapacity ?? 50}
      onConfirm={onConfirm}
    />,
  );

  return { ...utils, onReload, onConfirm, onClose };
}

// ============================================================================
// #97 regression: a model with no typed numbers must be permittable.
// ============================================================================

describe('a model with no typed numbers is permittable (#97 regression)', () => {
  it('enables Confirm and submits blank numbers when nothing is typed', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      result: discovery([
        model({
          id: 'gpt-9-turbo',
          label: 'gpt-9-turbo',
          source: 'default',
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
        }),
      ]),
    });

    const confirmButton = screen.getByRole('button', { name: /permit selected/i });
    expect(confirmButton).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /permit gpt-9-turbo/i }));

    // Nothing was typed into either number field, and that must not block it.
    const enabledConfirm = screen.getByRole('button', { name: /permit 1 model/i });
    expect(enabledConfirm).toBeEnabled();

    await user.click(enabledConfirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith([
      {
        id: 'gpt-9-turbo',
        label: '',
        numbers: { contextWindowTokens: '', maxOutputTokens: '' },
        provenance: {
          source: 'default',
          derivedFrom: null,
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_096,
        },
      },
    ]);
  });

  it('never shows the number fields for an unticked row at all', () => {
    renderDialog({ result: discovery([model({ id: 'gpt-9-turbo' })]) });

    expect(
      screen.queryByLabelText(/context window in tokens for gpt-9-turbo/i),
    ).not.toBeInTheDocument();
  });
});

// ============================================================================
// Select all: respects remaining capacity, and merges rather than rebuilds.
// ============================================================================

describe('select all', () => {
  it('stops ticking once the remaining capacity is used up, and says so', async () => {
    const user = userEvent.setup();
    const models = ['model-a', 'model-b', 'model-c', 'model-d'].map((id) =>
      model({ id, label: id }),
    );
    renderDialog({ result: discovery(models), remainingCapacity: 2 });

    await user.click(screen.getByRole('button', { name: /select all \(2\)/i }));

    const checked = screen
      .getAllByRole('checkbox')
      .filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(2);
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
    expect(screen.getByText(/4 available, 2 will fit/i)).toBeInTheDocument();
  });

  it('merges into the existing selection rather than rebuilding it — a typed override on an already-ticked row survives', async () => {
    const user = userEvent.setup();
    const models = [model({ id: 'model-a', label: 'model-a' }), model({ id: 'model-b', label: 'model-b' })];
    renderDialog({ result: discovery(models), remainingCapacity: 2 });

    const rowA = screen
      .getByRole('checkbox', { name: /permit model-a/i })
      .closest('li') as HTMLElement;

    await user.click(within(rowA).getByRole('checkbox', { name: /permit model-a/i }));
    await user.click(within(rowA).getByRole('button', { name: /^override$/i }));
    await user.type(
      within(rowA).getByLabelText(/context window in tokens for model-a/i),
      '99000',
    );

    await user.click(screen.getByRole('button', { name: /select all/i }));

    // model-a's typed override is untouched by the merge.
    expect(
      within(rowA).getByLabelText(/context window in tokens for model-a/i),
    ).toHaveValue(99_000);
    // model-b is now also ticked, added by the merge.
    expect(screen.getByRole('checkbox', { name: /permit model-b/i })).toBeChecked();
  });
});

// ============================================================================
// "Show every model the provider lists" — a second request, not a filter.
// ============================================================================

describe('"Show every model the provider lists"', () => {
  it('reloads with includeAll: true when switched on', async () => {
    const user = userEvent.setup();
    const { onReload } = renderDialog();

    await user.click(
      screen.getByRole('switch', { name: /show every model the provider lists/i }),
    );

    expect(onReload).toHaveBeenCalledWith(true);
  });

  it('resets to off whenever the dialog is reopened', async () => {
    const user = userEvent.setup();
    const { rerender, onReload } = renderDialog({ open: true });

    await user.click(
      screen.getByRole('switch', { name: /show every model the provider lists/i }),
    );
    expect(
      screen.getByRole('switch', { name: /show every model the provider lists/i }),
    ).toBeChecked();

    rerender(
      <AiModelDiscoveryDialog
        open={false}
        onClose={vi.fn()}
        onReload={onReload}
        isLoading={false}
        result={discovery([model()])}
        error={null}
        alreadyPermitted={new Set()}
        remainingCapacity={50}
        onConfirm={vi.fn()}
      />,
    );
    rerender(
      <AiModelDiscoveryDialog
        open
        onClose={vi.fn()}
        onReload={onReload}
        isLoading={false}
        result={discovery([model()])}
        error={null}
        alreadyPermitted={new Set()}
        remainingCapacity={50}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('switch', { name: /show every model the provider lists/i }),
    ).not.toBeChecked();
  });
});

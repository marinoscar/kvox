/**
 * `AiTaskModels` — the "Task models" section of `/admin/settings/ai` (issue #361).
 *
 * Rendered through a small stateful harness so a selection flows back in as
 * the next `value`, exactly as the page drives it, while a spy records every
 * map the component emits.
 */

import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { render } from '../../utils/test-utils';
import {
  AiTaskModels,
  taskModelsHaveError,
  toTaskModelsInput,
  type AiTaskModelsProps,
  type TaskModelsDraft,
} from '../../../components/admin/AiTaskModels';
import type { AiTaskDefinition, AiTaskModelStatus } from '../../../services/ai';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

// Deliberately NOT the labels any real API ships: the component must render
// whatever `tasks[]` says, in the order it says it.
const TASKS: AiTaskDefinition[] = [
  {
    key: 'graph.extract',
    label: 'Extraction',
    description: 'Turns a finished note into a graph proposal.',
    requires: ['structuredOutput'],
  },
  {
    key: 'graph.adjudicate',
    label: 'Adjudication',
    description: 'Decides whether two entities are the same.',
    requires: ['structuredOutput'],
  },
  {
    key: 'graph.digest',
    label: 'Digest',
    description: 'Summarises what changed.',
    requires: [],
  },
  {
    key: 'graph.agent',
    label: 'Ask',
    description: 'Answers questions about the graph.',
    requires: ['toolCalling'],
  },
];

const PERMITTED = ['gpt-4o', 'gpt-4o-mini', 'legacy-model', 'gpt-new'];

const CAPABILITIES: AiTaskModelsProps['capabilities'] = {
  'gpt-4o': { structuredOutput: true, toolCalling: true },
  'gpt-4o-mini': { structuredOutput: true, toolCalling: false },
  'legacy-model': { structuredOutput: false, toolCalling: false },
  // `gpt-new` is absent on purpose: a model added in this unsaved draft.
};

function Harness({
  initial = {},
  onChange = vi.fn(),
  ...overrides
}: Partial<Omit<AiTaskModelsProps, 'value' | 'onChange'>> & {
  initial?: TaskModelsDraft;
  onChange?: (next: TaskModelsDraft) => void;
}) {
  const [value, setValue] = useState<TaskModelsDraft>(initial);
  return (
    <AiTaskModels
      tasks={TASKS}
      permittedModelIds={PERMITTED}
      defaultModel="gpt-4o"
      capabilities={CAPABILITIES}
      status={[]}
      serverErrorTask={null}
      disabled={false}
      {...overrides}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

const modelSelect = (label: string) =>
  screen.getByRole('combobox', { name: new RegExp(`^model for ${label}`, 'i') });
const reasoningSelect = (label: string) =>
  screen.getByRole('combobox', { name: new RegExp(`^reasoning for ${label}`, 'i') });

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  select: HTMLElement,
  option: string | RegExp
) {
  await user.click(select);
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByRole('option', { name: option }));
}

describe('AiTaskModels', () => {
  it('renders one row per task, in API order, with its requirements as chips', () => {
    render(<Harness />);

    expect(screen.getByRole('heading', { level: 2, name: 'Task models' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    ).toEqual(['Extraction', 'Adjudication', 'Digest', 'Ask']);
    expect(screen.getByText('Answers questions about the graph.')).toBeInTheDocument();

    expect(screen.getAllByText('Structured output')).toHaveLength(2);
    expect(screen.getAllByText('Tool calling')).toHaveLength(1);
    expect(
      screen.getByText(/leave a task on “default” to use the default model/i)
    ).toBeInTheDocument();
  });

  it('gives every select an accessible name naming its task', () => {
    render(<Harness />);

    for (const task of TASKS) {
      expect(modelSelect(task.label)).toBeInTheDocument();
      expect(reasoningSelect(task.label)).toBeInTheDocument();
    }
  });

  it('shows Default in both closed selects rather than a blank box', () => {
    render(<Harness />);

    expect(modelSelect('Extraction')).toHaveTextContent('Default (gpt-4o)');
    expect(reasoningSelect('Extraction')).toHaveTextContent('Default');
  });

  it('offers exactly Default (<defaultModel>) plus the permitted models', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(modelSelect('Extraction'));
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Default (gpt-4o)', ...PERMITTED]);
  });

  it('offers a model the moment it joins the permitted list', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness permittedModelIds={['gpt-4o']} />);
    rerender(<Harness permittedModelIds={['gpt-4o', 'gpt-brand-new']} />);

    await user.click(modelSelect('Digest'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'gpt-brand-new' })).toBeInTheDocument();
  });

  it('disables the reasoning select while the model is Default, and enables it once one is chosen', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(reasoningSelect('Extraction')).toHaveAttribute('aria-disabled', 'true');

    await choose(user, modelSelect('Extraction'), 'gpt-4o-mini');

    expect(reasoningSelect('Extraction')).not.toHaveAttribute('aria-disabled');
  });

  it('offers Default, Low, Medium and High reasoning', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ 'graph.digest': { model: 'gpt-4o' } }} />);

    await user.click(reasoningSelect('Digest'));
    const listbox = await screen.findByRole('listbox');
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['Default', 'Low', 'Medium', 'High']);
  });

  it('warns when the chosen model lacks a capability the task needs, and clears once a capable one is chosen', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await choose(user, modelSelect('Extraction'), 'legacy-model');
    const row = screen.getByTestId('task-model-row-graph.extract');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      "legacy-model can't do Structured output, which Extraction needs. Users will get an error until you choose a model that can."
    );

    await choose(user, modelSelect('Extraction'), 'gpt-4o');
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('judges a task left on Default by the default model', () => {
    render(<Harness defaultModel="gpt-4o-mini" />);

    const row = screen.getByTestId('task-model-row-graph.agent');
    expect(within(row).getByRole('alert')).toHaveTextContent(
      "gpt-4o-mini can't do Tool calling, which Ask needs."
    );
    // Extraction only needs structured output, which gpt-4o-mini has.
    expect(
      within(screen.getByTestId('task-model-row-graph.extract')).queryByRole('alert')
    ).toBeNull();
  });

  it('says capabilities are checked on save for a model whose flags are unknown', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await choose(user, modelSelect('Ask'), 'gpt-new');

    const row = screen.getByTestId('task-model-row-graph.agent');
    expect(within(row).getByText('Capabilities are checked when you save.')).toBeInTheDocument();
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('keeps a no-longer-permitted value visible, selectable and flagged', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ 'graph.extract': { model: 'retired-model' } }} />);

    expect(modelSelect('Extraction')).toHaveTextContent('retired-model');
    expect(
      screen.getByText('No longer permitted — choose another or use Default')
    ).toBeInTheDocument();

    await user.click(modelSelect('Extraction'));
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByRole('option', { name: 'retired-model' })).toBeInTheDocument();
  });

  it('emits the expected map as rows change, dropping a row set back to Default', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await choose(user, modelSelect('Adjudication'), 'gpt-4o-mini');
    expect(onChange).toHaveBeenLastCalledWith({ 'graph.adjudicate': { model: 'gpt-4o-mini' } });

    await choose(user, reasoningSelect('Adjudication'), 'High');
    expect(onChange).toHaveBeenLastCalledWith({
      'graph.adjudicate': { model: 'gpt-4o-mini', reasoningEffort: 'high' },
    });

    // Changing the model keeps the per-task reasoning effort.
    await choose(user, modelSelect('Adjudication'), 'gpt-4o');
    expect(onChange).toHaveBeenLastCalledWith({
      'graph.adjudicate': { model: 'gpt-4o', reasoningEffort: 'high' },
    });

    await choose(user, reasoningSelect('Adjudication'), 'Default');
    expect(onChange).toHaveBeenLastCalledWith({ 'graph.adjudicate': { model: 'gpt-4o' } });

    await choose(user, modelSelect('Adjudication'), 'Default (gpt-4o)');
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('notes when the server fell back to the default for a configured model', () => {
    const status: AiTaskModelStatus[] = [
      {
        task: 'graph.digest',
        configuredModel: 'gpt-3.5',
        effectiveModel: 'gpt-4o',
        source: 'default',
        missing: [],
        problem: 'not_permitted',
      },
      {
        task: 'graph.extract',
        configuredModel: null,
        effectiveModel: 'gpt-4o',
        source: 'default',
        missing: [],
        problem: null,
      },
    ];
    render(<Harness status={status} />);

    expect(
      within(screen.getByTestId('task-model-row-graph.digest')).getByText(
        'Configured model gpt-3.5 is no longer permitted; using the default.'
      )
    ).toBeInTheDocument();
    // A task nobody configured is simply on Default — nothing to explain.
    expect(
      within(screen.getByTestId('task-model-row-graph.extract')).queryByText(/no longer permitted/i)
    ).toBeNull();
  });

  it('marks the row a save error named', () => {
    render(
      <Harness
        serverErrorTask="graph.agent"
        initial={{ 'graph.agent': { model: 'gpt-4o-mini' } }}
      />
    );

    const row = screen.getByTestId('task-model-row-graph.agent');
    expect(within(row).getByText(/the last save was refused for this task/i)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('task-model-row-graph.extract')).queryByText(/refused/i)
    ).toBeNull();
  });

  it('disables every select when read-only', () => {
    render(<Harness disabled initial={{ 'graph.extract': { model: 'gpt-4o' } }} />);

    for (const task of TASKS) {
      expect(modelSelect(task.label)).toHaveAttribute('aria-disabled', 'true');
      expect(reasoningSelect(task.label)).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('stacks each row vertically on a phone and goes horizontal from sm', () => {
    render(<Harness />);

    const stack = screen.getByTestId('task-model-row-graph.extract')
      .firstElementChild as HTMLElement;
    // jsdom evaluates no media queries, so the computed style is the `xs` value.
    expect(stack).toHaveStyle({ flexDirection: 'column' });
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Harness
        defaultModel="gpt-4o-mini"
        initial={{ 'graph.extract': { model: 'retired-model' } }}
      />
    );

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('taskModelsHaveError', () => {
  it('is true only when a task names a model outside the permitted list', () => {
    expect(taskModelsHaveError({}, ['gpt-4o'])).toBe(false);
    expect(taskModelsHaveError({ 'graph.extract': { model: 'gpt-4o' } }, ['gpt-4o'])).toBe(false);
    expect(taskModelsHaveError({ 'graph.extract': { model: 'gone' } }, ['gpt-4o'])).toBe(true);
  });
});

describe('toTaskModelsInput', () => {
  it('omits Default rows and Default reasoning efforts', () => {
    expect(
      toTaskModelsInput({
        'graph.extract': { model: 'gpt-4o', reasoningEffort: 'low' },
        'graph.digest': { model: 'gpt-4o-mini' },
        'graph.agent': { model: '' },
      })
    ).toEqual({
      'graph.extract': { model: 'gpt-4o', reasoningEffort: 'low' },
      'graph.digest': { model: 'gpt-4o-mini' },
    });
  });
});

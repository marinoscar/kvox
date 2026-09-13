import { describe, expect, it } from 'vitest';

import type { Journal } from '../journal.js';
import { runPipeline, type DeployStep, type StepContext } from './pipeline.js';

function fakeJournal(): Journal & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    path: '/tmp/journal.log',
    redact: (value: string) => value,
    step: (id, title) => lines.push(`step:${id}:${title}`),
    line: (text) => lines.push(text),
    command: () => undefined,
    finish: () => undefined,
  } as Journal & { lines: string[] };
}

interface Ctx extends StepContext {
  ran: string[];
}

function context(completed: string[] = []): Ctx & { journal: Journal & { lines: string[] } } {
  return {
    journal: fakeJournal(),
    hooks: undefined,
    completed: new Set(completed),
    ran: [],
  } as Ctx & { journal: Journal & { lines: string[] } };
}

function step(id: string, options: Partial<DeployStep<Ctx>> = {}): DeployStep<Ctx> {
  return {
    id,
    title: id,
    run: async (ctx) => {
      ctx.ran.push(id);
    },
    ...options,
  };
}

describe('runPipeline', () => {
  it('runs steps in order', async () => {
    const ctx = context();
    const result = await runPipeline([step('a'), step('b'), step('c')], ctx);

    expect(ctx.ran).toEqual(['a', 'b', 'c']);
    expect(result.completed).toEqual(['a', 'b', 'c']);
    expect(result.failed).toBeUndefined();
  });

  it('stops at the first failure', async () => {
    const ctx = context();
    const result = await runPipeline(
      [
        step('a'),
        step('b', {
          run: async () => {
            throw new Error('build failed');
          },
        }),
        step('c'),
      ],
      ctx,
    );

    // Continuing past a failed step is how a deployment ends up half-applied.
    expect(ctx.ran).toEqual(['a']);
    expect(result.failed?.id).toBe('b');
    expect(result.failed?.detail).toBe('build failed');
    expect(result.completed).toEqual(['a']);
  });

  it('honours a skip guard, recording why', async () => {
    const ctx = context();
    const result = await runPipeline(
      [step('a', { skip: () => 'skipped with --skip-a' }), step('b')],
      ctx,
    );

    expect(ctx.ran).toEqual(['b']);
    expect(result.steps[0]?.outcome).toBe('skipped');
    expect(result.steps[0]?.detail).toContain('--skip-a');
  });

  it('skips a step already completed, for --resume', async () => {
    const ctx = context(['a']);
    await runPipeline([step('a'), step('b')], ctx);

    // A rerun after a fixed database password should not rebuild images.
    expect(ctx.ran).toEqual(['b']);
  });

  it('reports every step through the hooks, in order', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const ctx = {
      ...context(),
      hooks: {
        onStepStart: ({ id }: { id: string }) => started.push(id),
        onStepResult: ({ id, outcome }: { id: string; outcome: string }) =>
          finished.push(`${id}:${outcome}`),
      },
    } as Ctx;

    await runPipeline([step('a'), step('b', { skip: () => 'nope' })], ctx);

    expect(started).toEqual(['a']);
    expect(finished).toEqual(['a:ok', 'b:skipped']);
  });

  it('tells the hooks how many steps there are', async () => {
    const seen: Array<{ index: number; total: number }> = [];
    const ctx = {
      ...context(),
      hooks: { onStepStart: (info: { index: number; total: number }) => seen.push(info) },
    } as Ctx;

    await runPipeline([step('a'), step('b')], ctx);

    expect(seen.map(({ index, total }) => ({ index, total }))).toEqual([
      { index: 0, total: 2 },
      { index: 1, total: 2 },
    ]);
  });

  it('writes nothing to a terminal', async () => {
    // The whole point of the hooks seam: #184's ink screen is a second
    // renderer, not a second implementation.
    const ctx = context();
    await runPipeline([step('a')], ctx);

    expect(ctx.journal.lines.some((line) => line.startsWith('step:a'))).toBe(true);
  });
});

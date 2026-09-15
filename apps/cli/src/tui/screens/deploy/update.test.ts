import { describe, expect, it } from 'vitest';

import { CLI_NAME } from '../../../branding.js';
import { buildUpdateSteps, renderUpdateCheck, type UpdateCheck } from '../../../deploy/update.js';
import { CONFIRM_DEFAULT_INDEX, confirmChoices } from '../../components/index.js';
import {
  UPDATE_ABORT_DIALOG,
  UPDATE_FLAG_DEFAULTS,
  UPDATE_PIPELINE_STEPS,
  updateDiffHints,
  updateDiffModel,
  updateDoneModel,
  updateFailedModel,
  updateFlagRows,
  updateItems,
} from './update-model.js';

// =============================================================================
// The update screen  (issue #132, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency (see status.test.ts), so this
// asserts the data. Which is the right level for this screen anyway: the thing
// the issue is actually about is that an update is SHOWN before it is applied,
// and "what is shown" is `updateDiffModel`. The rest is the two shapes that
// must not drift — the pipeline step list against the real pipeline, and the
// failed view's recovery command against the one `runUpdate` prints.
// =============================================================================

const CURRENT = 'aaaaaaaaaaaabbbbbbbbbbbbccccccccccccdddd';
const LATEST = 'ffffffffffff111111111111222222222222eeee';

function check(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    current: CURRENT,
    latest: LATEST,
    commitsBehind: 3,
    commits: [
      { sha: '1111111', subject: 'feat(api): add the thing' },
      { sha: '2222222', subject: 'fix(web): stop the other thing' },
      { sha: '3333333', subject: 'chore(deps): bump' },
    ],
    checkedAt: '2026-09-15T18:02:11.000Z',
    ...overrides,
  };
}

const NOW = Date.parse('2026-09-15T21:02:11.000Z');

describe('updateDiffModel', () => {
  it('heads the diff with current, latest, behind and checked', () => {
    const model = updateDiffModel(check(), { now: NOW });

    expect(model.upToDate).toBe(false);
    expect(model.rows.map((row) => row.key)).toEqual(['Current', 'Latest', 'Behind', 'Checked']);
    expect(model.rows[0]?.value).toBe('aaaaaaaaaaaa');
    expect(model.rows[1]?.value).toBe('ffffffffffff');
    expect(model.rows[2]?.value).toBe('3 commits');
  });

  it('shows the checked time in UTC with its age beside it', () => {
    const checked = updateDiffModel(check(), { now: NOW }).rows.at(-1);

    expect(checked?.key).toBe('Checked');
    expect(checked?.value).toBe('2026-09-15 18:02:11 UTC');
    expect(checked?.value.endsWith(' UTC')).toBe(true);
    expect(checked?.note).toBe('(3 hours ago)');
  });

  it('lists the commit subjects exactly as the terminal renderer does', () => {
    const model = updateDiffModel(check(), { now: NOW });

    expect(model.commits).toEqual([
      '1111111  feat(api): add the thing',
      '2222222  fix(web): stop the other thing',
      '3333333  chore(deps): bump',
    ]);
    // The same lines `update --check` prints, minus its headline.
    expect(renderUpdateCheck(check()).slice(1)).toEqual(model.commits);
  });

  it('asks before applying, and the default answer is no', () => {
    const model = updateDiffModel(check(), { now: NOW });

    expect(model.confirm?.message).toBe('Apply this update?');
    expect(model.confirm?.confirmLabel).toContain('ffffffffffff');

    const choices = confirmChoices(model.confirm?.confirmLabel ?? '', model.confirm?.cancelLabel);
    expect(choices[CONFIRM_DEFAULT_INDEX]?.label).toBe('No, go back');
    expect(choices[CONFIRM_DEFAULT_INDEX]?.value).toBe(false);
  });

  it('says "1 commit", not "1 commits"', () => {
    const model = updateDiffModel(check({ commitsBehind: 1, commits: [] }), { now: NOW });

    expect(model.title).toBe('1 commit behind');
    expect(model.rows[2]?.value).toBe('1 commit');
  });

  it('answers zero-behind with one sentence and nothing to confirm', () => {
    const model = updateDiffModel(
      check({ commitsBehind: 0, latest: CURRENT, commits: [] }),
      { now: NOW },
    );

    expect(model.upToDate).toBe(true);
    expect(model.title).toBe('Already up to date at aaaaaaaaaaaa');
    expect(model.commits).toEqual([]);
    // A confirm here would be asking whether to do nothing.
    expect(model.confirm).toBeUndefined();
    // It still says WHEN that was established.
    expect(model.rows.at(-1)?.key).toBe('Checked');
  });

  it('uses the same up-to-date wording the terminal does', () => {
    const zero = check({ commitsBehind: 0, latest: CURRENT, commits: [] });

    expect(updateDiffModel(zero, { now: NOW }).title.toLowerCase()).toContain(
      renderUpdateCheck(zero)[0] ?? '',
    );
  });
});

describe('the flags on the confirm row', () => {
  it('defaults to re-seeding and to using the build cache', () => {
    expect(UPDATE_FLAG_DEFAULTS).toEqual({ skipSeed: false, noCache: false });
    expect(updateFlagRows(UPDATE_FLAG_DEFAULTS).map((row) => row.value)).toEqual(['on', 'on']);
  });

  it('names the flag it will pass, and what skipping the seed costs', () => {
    const rows = updateFlagRows({ skipSeed: true, noCache: true });

    expect(rows[0]?.value).toContain('--skip-seed');
    expect(rows[0]?.note).toContain('permissions');
    expect(rows[1]?.value).toContain('--no-cache');
  });
});

describe('updateDiffHints', () => {
  it('binds bare letters, because this screen has no text field', () => {
    const hints = updateDiffHints(false);

    expect(hints).toContain('s re-seed');
    expect(hints).toContain('c cache');
    // ctrl-s is XOFF on most terminals; it is not an option here.
    expect(hints.join(' ')).not.toContain('ctrl-s');
  });

  it('offers only Enter when there is nothing to apply', () => {
    expect(updateDiffHints(true)).toEqual(['enter return', 'esc back']);
  });
});

describe('the running view', () => {
  it('lists the real update pipeline, in its real order', () => {
    expect(UPDATE_PIPELINE_STEPS.map((step) => step.id)).toEqual(
      buildUpdateSteps().map((step) => step.id),
    );
  });

  it('is the eleven steps the issue names', () => {
    expect(UPDATE_PIPELINE_STEPS.map((step) => step.id)).toEqual([
      'preflight',
      'auth',
      'fetch',
      'environment-drift',
      'build',
      'migrate',
      'seed',
      'restart',
      'health',
      'publish',
      'verify',
    ]);
  });

  it('shows every step from the first frame, with a duration once one finishes', () => {
    const items = updateItems([
      { id: 'preflight', title: 'Check the essentials', outcome: 'ok', durationMs: 2_400 },
      { id: 'auth', title: 'Authenticate with GitHub', outcome: 'running' },
    ]);

    expect(items).toHaveLength(UPDATE_PIPELINE_STEPS.length);
    expect(items[0]?.status).toBe('pass');
    expect(items[0]?.detail).toBe('2s');
    expect(items[1]?.status).toBe('running');
    expect(items.at(-1)?.status).toBe('pending');
  });

  it('reports a skipped seed as skipped rather than as a failure', () => {
    const items = updateItems([
      { id: 'seed', title: 'Seed', outcome: 'skipped', detail: 'skipped with --skip-seed' },
    ]);

    expect(items.find((item) => item.id === 'seed')?.status).toBe('skip');
  });
});

describe('updateDoneModel', () => {
  it('shows the new revision and the one it replaced', () => {
    const model = updateDoneModel({
      changed: true,
      commitSha: LATEST,
      previousSha: CURRENT,
      journalPath: '/opt/infra/apps/demo/journal/update-1.log',
      durationMs: 90_000,
    });

    expect(model.title).toBe('Updated');
    expect(model.rows.map((row) => row.key)).toEqual([
      'Revision',
      'Previous revision',
      'Journal',
    ]);
    expect(model.rows[1]?.value).toBe('aaaaaaaaaaaa');
  });

  it('does not claim a change when the remote had not moved', () => {
    const model = updateDoneModel({
      changed: false,
      commitSha: CURRENT,
      journalPath: '/tmp/journal.log',
      durationMs: 1_000,
    });

    expect(model.title).toBe('Already up to date');
    expect(model.rows.some((row) => row.key === 'Previous revision')).toBe(false);
  });
});

describe('updateFailedModel', () => {
  it('carries the exact `--ref <previous> --force` line the command prints', () => {
    const model = updateFailedModel({
      message: 'Build images failed: exit 1',
      stepId: 'build',
      previousSha: CURRENT,
      journalPath: '/tmp/journal.log',
    });

    expect(model.rollbackCommand).toBe(
      `${CLI_NAME} deploy update --ref ${CURRENT} --force`,
    );
    // Built from CLI_NAME, never from the product name spelled out.
    expect(model.rollbackCommand).toContain(CLI_NAME);
    expect(model.rows[0]?.value).toBe('Build images');
    expect(model.rows[1]?.value).toBe(CURRENT);
  });

  it('is honest that there is no automatic rollback', () => {
    const model = updateFailedModel({ message: 'boom', previousSha: CURRENT });

    expect(model.detail.join(' ')).toContain('no automatic rollback');
  });

  it('offers no command when there is no previous revision to name', () => {
    expect(updateFailedModel({ message: 'boom' }).rollbackCommand).toBeUndefined();
    expect(updateFailedModel({ message: 'boom' }).rows[1]?.value).toBe('unknown');
  });

  it('names the raw step id for a step this build does not know', () => {
    expect(updateFailedModel({ message: 'boom', stepId: 'from-the-future' }).rows[0]?.value).toBe(
      'from-the-future',
    );
  });
});

describe('the abort prompt', () => {
  it('is a danger prompt whose default is not to stop', () => {
    expect(UPDATE_ABORT_DIALOG.danger).toBe(true);
    expect(
      confirmChoices(UPDATE_ABORT_DIALOG.confirmLabel, UPDATE_ABORT_DIALOG.cancelLabel)[
        CONFIRM_DEFAULT_INDEX
      ]?.value,
    ).toBe(false);
    // It does not promise a rollback it cannot perform.
    expect(UPDATE_ABORT_DIALOG.detail.join(' ')).toContain('Nothing is rolled back');
  });
});

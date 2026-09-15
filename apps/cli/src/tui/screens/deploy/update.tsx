import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { StepResult } from '../../../deploy/hooks.js';
import { DEFAULT_APPS_ROOT, locateInstalledApp } from '../../../deploy/layout.js';
import { readState, type DeployState } from '../../../deploy/state.js';
import { checkForUpdate, runUpdate, type UpdateCheck } from '../../../deploy/update.js';
import { formatError } from '../../../errors.js';
import { Checklist, ConfirmDialog, KeyValue, WizardFrame } from '../../components/index.js';
import { ErrorNotice, useIsMounted } from '../../layout.js';
import { ScrollBox } from '../../scroll-box.js';
import { withSignal } from './abort.js';
import { MAX_LOG_LINES, formatDuration, type PipelineProgress } from './install-model.js';
import {
  UPDATE_ABORTED_DETAIL,
  UPDATE_ABORT_DIALOG,
  UPDATE_FLAG_DEFAULTS,
  updateDiffHints,
  updateDiffModel,
  updateDoneModel,
  updateFailedModel,
  updateFlagRows,
  updateItems,
  type DiffFocus,
  type UpdateFlags,
} from './update-model.js';

// =============================================================================
// Update  (issue #132, epic #118)
// =============================================================================
//
// THREE PHASES, AND THE MIDDLE ONE IS THE POINT. The screen this replaces ran
// `deploy update` the moment it was chosen. Here:
//
//   1. Checking  — a real `update --check` run (#123). It fetches and resolves
//      WITHOUT moving the clone and writes nothing but deploy-info's `remote`,
//      so Esc during it loses nothing and leaves nothing half-done.
//   2. Diff      — what is about to be applied, then the question. `nothing to
//      apply` is its own view: a confirm dialog there would be asking whether
//      to do nothing.
//   3. Running   — the install wizard's running view over the update's own
//      eleven steps, then Done or Failed.
//
// THE ABORT REACHES THE CHILD PROCESS (`withSignal`), which is the whole
// difference between Esc stopping a `docker compose build` and Esc tearing
// down the UI over one that keeps running on a production server.
//
// KEYS: Enter/arrows belong to the confirm's list; `s` toggles --skip-seed and
// `c` toggles --no-cache. Bare letters, deliberately — #131 bound ctrl-r
// because its screen has TEXT FIELDS and ink delivers every keystroke to every
// mounted handler; this screen has none. `ctrl-s` would in any case have been
// the wrong modifier to reach for: on most terminals it is XOFF and freezes
// the session.
// =============================================================================

export interface UpdateScreenProps {
  onDone: () => void;
  appsRoot?: string | undefined;
}

type Phase = 'checking' | 'diff' | 'running' | 'done' | 'failed' | 'aborted';

interface Site {
  deployRoot: string;
  state: DeployState;
}

export function UpdateScreen({ onDone, appsRoot }: UpdateScreenProps): ReactNode {
  const isMounted = useIsMounted();
  const root = appsRoot ?? DEFAULT_APPS_ROOT;

  const [phase, setPhase] = useState<Phase>('checking');
  const [check, setCheck] = useState<UpdateCheck | undefined>(undefined);
  const [flags, setFlags] = useState<UpdateFlags>(UPDATE_FLAG_DEFAULTS);
  const [progress, setProgress] = useState<PipelineProgress[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<{
    done?: ReturnType<typeof updateDoneModel> | undefined;
    failed?: ReturnType<typeof updateFailedModel> | undefined;
  }>({});
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [diffFocus, setDiffFocus] = useState<DiffFocus>('confirm');
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const progressRef = useRef<PipelineProgress[]>([]);
  progressRef.current = progress;

  const site = useMemo(() => resolveSite(root), [root]);

  // Load-bearing: leaving the screen mid-run must SIGTERM the build, not
  // merely unmount the frame over it.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const append = useCallback(
    (line: string) => {
      if (!isMounted()) return;
      setLines((current) => [...current, line].slice(-MAX_LOG_LINES));
    },
    [isMounted],
  );

  // ---------------------------------------------------------------------------
  // Phase 1: the check
  // ---------------------------------------------------------------------------

  const runCheck = useCallback(() => {
    if ('error' in site) {
      setError(site.error);
      setPhase('failed');
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('checking');
    setError(undefined);

    void (async () => {
      try {
        const result = await checkForUpdate({
          deployRoot: site.deployRoot,
          state: site.state,
          runCommand: withSignal(controller.signal),
          fetchTimeoutMs: 60_000,
          // Never create a checkout to answer a question: the check phase is
          // read-only by construction, which is what makes Esc during it free.
          requireExisting: true,
        });
        if (!isMounted() || controller.signal.aborted) return;
        setCheck(result.check);
        setPhase('diff');
      } catch (caught) {
        if (!isMounted() || controller.signal.aborted) return;
        setError(formatError(caught));
        setPhase('failed');
      }
    })();
  }, [isMounted, site]);

  const checkStarted = useRef(false);
  useEffect(() => {
    if (checkStarted.current) return;
    checkStarted.current = true;
    runCheck();
  }, [runCheck]);

  // ---------------------------------------------------------------------------
  // Phase 3: the run
  // ---------------------------------------------------------------------------

  const start = useCallback(() => {
    if ('error' in site) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setProgress([]);
    setLines([]);
    setStartedAt(Date.now());

    void (async () => {
      try {
        const result = await runUpdate({
          deployRoot: site.deployRoot,
          skipSeed: flags.skipSeed,
          noCache: flags.noCache,
          // ink holds stdin in raw mode, so readline cannot ask anything.
          nonInteractive: true,
          runCommand: withSignal(controller.signal),
          hooks: {
            onStepStart: ({ id, title }) => {
              if (!isMounted()) return;
              setProgress((current) => [
                ...current.filter((entry) => entry.id !== id),
                { id, title, outcome: 'running' },
              ]);
            },
            onStepResult: (step: StepResult) => {
              if (!isMounted()) return;
              setProgress((current) =>
                current.map((entry) =>
                  entry.id === step.id
                    ? {
                        id: step.id,
                        title: step.title,
                        outcome: step.outcome,
                        durationMs: step.durationMs,
                        detail: step.detail,
                      }
                    : entry,
                ),
              );
            },
            onProgress: append,
            onLog: append,
          },
        });

        if (!isMounted()) return;
        setOutcome({
          done: updateDoneModel({
            changed: result.changed,
            commitSha: result.commitSha,
            ...(result.previousSha === undefined ? {} : { previousSha: result.previousSha }),
            journalPath: result.journalPath,
            durationMs: result.durationMs,
          }),
        });
        setPhase('done');
      } catch (caught) {
        if (!isMounted()) return;
        if (controller.signal.aborted) {
          setPhase('aborted');
          return;
        }
        const message = formatError(caught);
        setOutcome({
          failed: updateFailedModel({
            message,
            ...(currentStepId(progressRef.current) === undefined
              ? {}
              : { stepId: currentStepId(progressRef.current) }),
            // The state's `commitSha` IS the previous revision while the
            // update is in flight: it is stamped only once every step ran.
            previousSha: site.state.commitSha,
            ...(journalPathIn(message) === undefined
              ? {}
              : { journalPath: journalPathIn(message) }),
          }),
        });
        setPhase('failed');
      }
    })();
  }, [append, flags, isMounted, site]);

  useEffect(() => {
    if (phase !== 'running' || startedAt === undefined) return;
    const timer = setInterval(() => {
      if (isMounted()) setElapsed(Date.now() - startedAt);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [phase, startedAt, isMounted]);

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  const diff = useMemo(
    () => (check === undefined ? undefined : updateDiffModel(check)),
    [check],
  );

  useInput(
    (_input, key) => {
      if (key.escape) onDone();
    },
    { isActive: phase === 'checking' },
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onDone();
        return;
      }
      if (diff?.upToDate === true) {
        if (key.return) onDone();
        return;
      }
      // Tab hands the arrows to one of the two children; see
      // `updateDiffHints`'s comment for why it has to be arbitrated at all.
      if (key.tab) {
        setDiffFocus((current) => (current === 'confirm' ? 'commits' : 'confirm'));
        return;
      }
      if (diffFocus !== 'confirm') return;
      const letter = input.toLowerCase();
      if (letter === 's') setFlags((current) => ({ ...current, skipSeed: !current.skipSeed }));
      if (letter === 'c') setFlags((current) => ({ ...current, noCache: !current.noCache }));
    },
    { isActive: phase === 'diff' },
  );

  useInput(
    (_input, key) => {
      if (key.escape) setConfirmingAbort(true);
    },
    { isActive: phase === 'running' && !confirmingAbort },
  );

  useInput(
    (_input, key) => {
      if (key.return || key.escape) onDone();
    },
    { isActive: phase === 'done' || phase === 'failed' || phase === 'aborted' },
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const railStep = { id: 'update', title: 'Update' };

  if (phase === 'checking') {
    return (
      <WizardFrame title="Update" steps={[railStep]} current={0} hints={['esc back']}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Looking for a new revision…</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Nothing is checked out or built by this step. Esc leaves it as it was.
          </Text>
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'running') {
    return (
      <WizardFrame
        title={`Update — running (${formatDuration(elapsed)})`}
        steps={[railStep]}
        current={0}
        hints={confirmingAbort ? ['enter select'] : ['esc stop', '↑↓ scroll the log']}
      >
        {confirmingAbort ? (
          <ConfirmDialog
            message={UPDATE_ABORT_DIALOG.message}
            detail={UPDATE_ABORT_DIALOG.detail}
            danger
            confirmLabel={UPDATE_ABORT_DIALOG.confirmLabel}
            cancelLabel={UPDATE_ABORT_DIALOG.cancelLabel}
            onResult={(confirmed) => {
              setConfirmingAbort(false);
              if (!confirmed) return;
              abortRef.current?.abort();
              setPhase('aborted');
            }}
          />
        ) : (
          <Checklist items={updateItems(progress)} />
        )}
        <Box marginTop={1} flexDirection="column">
          <ScrollBox
            lines={lines}
            reservedRows={22}
            title="Build log"
            busy={!confirmingAbort}
            followTail
            isActive={!confirmingAbort}
          />
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'done' && outcome.done !== undefined) {
    return (
      <WizardFrame
        title="Update — done"
        steps={[railStep]}
        current={0}
        hints={['enter return to the menu']}
      >
        <Text color="green" bold>
          {outcome.done.title}
        </Text>
        <Box marginTop={1}>
          <KeyValue rows={outcome.done.rows} />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Enter to return.</Text>
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'aborted') {
    return (
      <WizardFrame
        title="Update — stopped"
        steps={[railStep]}
        current={0}
        hints={['enter return to the menu']}
      >
        <Text color="yellow" bold>
          Stopped.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {UPDATE_ABORTED_DETAIL.map((line) => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'failed') {
    const failed = outcome.failed;
    return (
      <WizardFrame
        title="Update — failed"
        steps={[railStep]}
        current={0}
        hints={['enter return to the menu']}
      >
        {/* The TUI always exits 0, so the frame has to carry the failure. */}
        <ErrorNotice message={failed?.message ?? error ?? 'The update could not be checked.'} />
        {failed === undefined ? null : (
          <>
            <Box marginTop={1}>
              <KeyValue rows={failed.rows} />
            </Box>
            <Box marginTop={1} flexDirection="column">
              {failed.detail.map((line) => (
                <Text key={line} dimColor>
                  {line}
                </Text>
              ))}
            </Box>
            {failed.rollbackCommand === undefined ? null : (
              <Box marginTop={1} flexDirection="column">
                <Text dimColor>To go back to the previous revision:</Text>
                <Text bold>{`  ${failed.rollbackCommand}`}</Text>
              </Box>
            )}
          </>
        )}
      </WizardFrame>
    );
  }

  if (diff === undefined) {
    return (
      <WizardFrame title="Update" steps={[railStep]} current={0} hints={['esc back']}>
        <Text>Nothing was found to compare.</Text>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      title="Update"
      steps={[railStep]}
      current={0}
      hints={updateDiffHints(diff.upToDate, diffFocus)}
    >
      {diff.upToDate ? (
        <Text bold color="green">
          {diff.title}
        </Text>
      ) : (
        <Text bold>{diff.title}</Text>
      )}
      <Box marginTop={1}>
        <KeyValue rows={diff.rows} />
      </Box>

      {diff.upToDate || diff.confirm === undefined ? (
        <Box marginTop={1}>
          <Text dimColor>Press Enter to return.</Text>
        </Box>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            <ScrollBox
              lines={diff.commits}
              reservedRows={20}
              title="What is new"
              isActive={diffFocus === 'commits'}
            />
          </Box>
          <Box marginTop={1}>
            <KeyValue rows={updateFlagRows(flags)} />
          </Box>
          <Box marginTop={1}>
            <ConfirmDialog
              message={diff.confirm.message}
              detail={diff.confirm.detail}
              confirmLabel={diff.confirm.confirmLabel}
              cancelLabel={diff.confirm.cancelLabel}
              isActive={diffFocus === 'confirm'}
              onResult={(confirmed) => {
                if (confirmed) start();
                else onDone();
              }}
            />
          </Box>
        </>
      )}
    </WizardFrame>
  );
}

type SiteOrError = Site | { error: string };

/** The one deployment this screen acts on, or why there isn't one. */
function resolveSite(appsRoot: string): SiteOrError {
  try {
    const layout = locateInstalledApp({ appsRoot });
    const state = readState(layout.deployRoot);
    if (state === undefined) {
      return { error: `No deployment found at ${layout.deployRoot}.` };
    }
    return { deployRoot: layout.deployRoot, state };
  } catch (caught) {
    return { error: formatError(caught) };
  }
}

/** The step that was running when the pipeline stopped. */
function currentStepId(progress: readonly PipelineProgress[]): string | undefined {
  return (
    progress.find((entry) => entry.outcome === 'failed')?.id ??
    progress.find((entry) => entry.outcome === 'running')?.id
  );
}

/** `runUpdate`'s failure message names the journal; pull it back out. */
function journalPathIn(message: string): string | undefined {
  return /The full log is at (\S+)/.exec(message)?.[1];
}

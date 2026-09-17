import { Box, Text, useInput } from 'ink';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import {
  ALL_CHECKS,
  probeTcp,
  runChecks,
  type CheckContext,
  type CompletedCheck,
} from '../../../deploy/checks/index.js';
import { metadataFor, type Suggestion } from '../../../deploy/env-metadata.js';
import { parseEnvExample, type EnvVarSpec } from '../../../deploy/env-spec.js';
import { runCommand as defaultRunCommand } from '../../../deploy/executor.js';
import type { StepResult } from '../../../deploy/hooks.js';
import { runInstall } from '../../../deploy/install.js';
import {
  DEFAULT_APPS_ROOT,
  DEFAULT_BIND_PORT,
  DEFAULT_PROXY_ROOT,
  FALLBACK_APP_NAME,
  appNameFor,
  appRootFor,
  siblingBindPorts,
} from '../../../deploy/layout.js';
import { DEFAULT_PROXY_CONTAINER } from '../../../deploy/checks/index.js';
import { displayRepoUrl, resolveRepoTarget } from '../../../deploy/repo.js';
import {
  describeRemoteTemplateFailure,
  fetchRemoteTemplate,
  type RemoteTemplateResult,
  type TemplateSource,
} from '../../../deploy/remote-template.js';
import { bundledTemplateFor } from '../../../deploy/bundled-template.js';
import {
  createDatabase,
  creatableDatabase,
  type DatabaseCreationTarget,
} from '../../../deploy/database-create.js';
import { collectServerFacts, unknownServerFacts, type ServerFacts } from '../../../deploy/server-facts.js';
import { DOMAIN_FIELD } from '../../../deploy/wizard/steps.js';
import { formatError } from '../../../errors.js';
import {
  Checklist,
  ConfirmDialog,
  Form,
  KeyValue,
  WizardFrame,
  useWizard,
  type FormFieldSpec,
} from '../../components/index.js';
import { ErrorNotice, useIsMounted } from '../../layout.js';
import { ScrollBox } from '../../scroll-box.js';
import {
  ABORTED_DETAIL,
  ABORT_DIALOG,
  ALL_FIELD,
  GROUPS_FIELD,
  OPTION_MODE_PREFIX,
  INSTALL_CRON_FIELD,
  INTERNAL_DEFAULTS,
  MAX_LOG_LINES,
  NAME_FIELD,
  PUBLIC_IP_FIELD,
  REF_FIELD,
  REPO_FIELD,
  REVIEW_STEP_ID,
  SECRET_MODE_PREFIX,
  STAGING_FIELD,
  WELCOME_STEP_ID,
  answerOf,
  applyOptionMode,
  applySecretMode,
  checkItems,
  checksAllowLeaving,
  doneModel,
  prepareStep,
  envAnswers,
  failedField,
  failedModel,
  formFieldsFor,
  formatDuration,
  groupsOf,
  installSteps,
  isTrue,
  pipelineItems,
  railSteps,
  cursorSteps,
  railIndexFor,
  requiredFailures,
  stepCheckItems,
  reviewRows,
  stepContextFor,
  welcomeChecks,
  withAnswer,
  type InstallAnswers,
  type InstallStep,
  type OptionMode,
  type PipelineProgress,
  type SecretMode,
} from './install-model.js';

// =============================================================================
// The install wizard  (issue #131, epic #118)
// =============================================================================
//
// ELEVEN SCREENS OVER ONE ROUTE. `routes.ts` is closed and has no history
// stack, so the steps are an index inside this component (`useWizard`) rather
// than eleven routes that would each return to the TOP menu. Every question
// comes from `deploy/wizard/steps.ts` through `install-model.ts`; this file
// renders them and owns the three things a renderer owns — the keyboard, the
// AbortController, and when the network is touched.
//
// NOTHING IS WRITTEN TO DISK BEFORE THE REVIEW IS CONFIRMED. The wizard reads
// (the doctor's probes, DNS, the database, the server's own facts) but the
// first write is `runInstall`'s `environment` step, which cannot run until
// Review's `ConfirmDialog` returns true. Leaving the wizard at step 9
// therefore discards nothing, because nothing existed to discard.
//
// TWO HAZARDS, BOTH LEARNED FROM THE SCREEN THIS REPLACES
//
//   1. THE ABORT CONTROLLER MUST ACTUALLY REACH THE CHILD PROCESS. The old
//      screen created one and never passed it anywhere, so Esc "cancelled" a
//      `docker compose build` that went on running on a production server.
//      Here it is threaded through a wrapped `runCommand` into `executor.ts`,
//      which kills with SIGTERM. Esc while running opens the danger
//      confirmation docs/specs/vps-deploy.md §14 asks for rather than being
//      refused outright.
//   2. THE EXIT CODE INVERTS HERE. A normal TUI exit is 0 even after a failed
//      install (tui/index.tsx), so the failure has to be UNMISTAKABLE in the
//      frame — the exit code will not carry it.
//
// WHY Ctrl-R AND NOT `r` FOR "RE-RUN THE CHECKS". Welcome shows the doctor
// checklist BESIDE editable text fields (the app name, the repository, the
// ref). ink delivers every keystroke to every mounted handler, so a bare `r`
// would re-run the doctor in the middle of typing an app name containing one.
// A modifier is the only binding that can coexist with a focused text field.
// =============================================================================

export interface InstallWizardProps {
  /** Leave the wizard: back from Welcome, or Enter on Done/Failed. */
  onDone: () => void;
  appsRoot?: string | undefined;
  proxyRoot?: string | undefined;
}

type Phase = 'wizard' | 'running' | 'done' | 'failed' | 'aborted';

interface CheckRun {
  results: CompletedCheck[];
  running: boolean;
}

const IDLE: CheckRun = { results: [], running: false };

interface RunOutcome {
  done?: ReturnType<typeof doneModel> | undefined;
  failed?: ReturnType<typeof failedModel> | undefined;
}

export function InstallWizard({ onDone, appsRoot, proxyRoot }: InstallWizardProps): ReactNode {
  const isMounted = useIsMounted();
  const roots = useMemo(
    () => ({ apps: appsRoot ?? DEFAULT_APPS_ROOT, proxy: proxyRoot ?? DEFAULT_PROXY_ROOT }),
    [appsRoot, proxyRoot],
  );

  const [answers, setAnswers] = useState<InstallAnswers>(INTERNAL_DEFAULTS);
  const [phase, setPhase] = useState<Phase>('wizard');
  const [facts, setFacts] = useState<ServerFacts>(() => unknownServerFacts());
  const [suggestions, setSuggestions] = useState<Readonly<Record<string, Suggestion>>>({});
  const [welcome, setWelcome] = useState<CheckRun>(IDLE);
  const [stepChecks, setStepChecks] = useState<CheckRun>(IDLE);
  /**
   * The database this step could create, once `database-exists` has failed
   * because it is absent (#238). Set only after the READ-ONLY check has
   * reported — the operator sees the failure first and decides second.
   */
  const [creatable, setCreatable] = useState<DatabaseCreationTarget | undefined>(undefined);
  const [creating, setCreating] = useState<string | undefined>(undefined);
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);
  const [outcome, setOutcome] = useState<RunOutcome>({});
  /** The repository has been resolved (or given up on): the name is settled. */
  const [ready, setReady] = useState(false);

  const abortRef = useRef<AbortController | undefined>(undefined);

  const name = answerOf(answers, NAME_FIELD) || FALLBACK_APP_NAME;
  const deployRoot = appRootFor(roots.apps, name);

  // Read here rather than beside the fetch below: three of the four template
  // sources are keyed on the repository, so it has to be in scope before any
  // of them.
  const repoAnswer = answerOf(answers, REPO_FIELD);
  const refAnswer = answerOf(answers, REF_FIELD);

  // The questions come from the template of THE APP BEING INSTALLED, keyed on
  // its name (#229). This memo used to depend on the apps root alone, which
  // meant two things at once: it could never re-read when the operator typed a
  // name, and `loadTemplateSpecs` was free to answer with whatever sibling
  // deployment `readdirSync` happened to list first. On a host with more than
  // one app that is not a near miss — it is a different product's variable
  // list, so the wizard asks another application's questions and silently
  // drops the steps this one needs.
  const localSpecs = useMemo(() => loadTemplateSpecs(roots.apps, name), [roots.apps, name]);

  // The repository's OWN template, fetched from the remote at the resolved ref
  // (#230). This is what makes the questions right on a FIRST install, where
  // there is no clone on this server yet and the local fallback can only offer
  // the checkout the CLI happens to be running from — which need not be the
  // repository being deployed at all.
  const [remoteSpecs, setRemoteSpecs] = useState<EnvVarSpec[] | undefined>(undefined);
  /** Why the remote read did not answer, for the operator rather than a log. */
  const [remoteFailure, setRemoteFailure] = useState<
    Extract<RemoteTemplateResult, { ok: false }> | undefined
  >(undefined);

  // The copy the installer saved beside this CLI (#236), gated on the
  // repository it was taken from. Last in the chain, and the one source that
  // needs neither the network nor a credential — which is the whole point:
  // `gh` is authenticated PER USER, the installer supports running as root,
  // and a root shell whose `gh` is logged out left the wizard with no
  // questions at all and no way to say why.
  const bundledSpecs = useMemo(() => {
    const contents = bundledTemplateFor(repoAnswer);
    if (contents === undefined) return [];
    try {
      return parseEnvExample(contents);
    } catch {
      return [];
    }
  }, [repoAnswer]);

  // Precedence, most authoritative first: the repository's own file at the
  // ref being deployed; a clone of it on this server or a checkout we are
  // standing in; the copy this CLI was installed with. Each later source is
  // a weaker claim about the same file, and none of them is a sibling
  // application's template — see `loadTemplateSpecs` for why that matters.
  const specs =
    remoteSpecs ?? (localSpecs.length > 0 ? localSpecs : bundledSpecs);
  const templateSource: TemplateSource =
    remoteSpecs !== undefined
      ? 'remote'
      : localSpecs.length > 0
        ? 'local'
        : bundledSpecs.length > 0
          ? 'bundled'
          : 'none';

  // Memoised on the two answers that can CHANGE the step list, never on the
  // whole `answers` object. A step list rebuilt on every keystroke hands every
  // effect keyed on `step` a new object identity each render — which would
  // clear the focus a failed check had just set, on the very next frame.
  const groupsKey = answerOf(answers, GROUPS_FIELD);
  const reviewAll = isTrue(answers, ALL_FIELD);
  const groups = useMemo(() => groupsOf({ [GROUPS_FIELD]: groupsKey }), [groupsKey]);
  const steps = useMemo(
    () => installSteps(specs, { groups, all: reviewAll }),
    [specs, groups, reviewAll],
  );

  // cursorSteps, NOT railSteps: the rail collapses the catch-all pages into
  // one entry, and a cursor built from it cannot reach past that count (#243).
  const wizard = useWizard(cursorSteps(steps), {
    onFinish: () => {
      /* Review's ConfirmDialog starts the run; `next()` is never called there. */
    },
    onCancel: onDone,
    isActive:
      phase === 'wizard' && !confirming && !stepChecks.running && creatable === undefined,
  });

  const step = steps[wizard.index] ?? steps[0];

  // ---------------------------------------------------------------------------
  // Facts, suggestions and the repository, read once
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const collected = await collectServerFacts({
        runCommand: defaultRunCommand,
        root: roots.apps,
      }).catch(() => unknownServerFacts());
      if (!cancelled && isMounted()) setFacts(collected);

      const target = await resolveRepoTarget({
        cwd: process.cwd(),
        runCommand: defaultRunCommand,
      }).catch(() => undefined);
      if (cancelled || !isMounted()) return;
      // Whether or not a remote was found, the app name is now as settled as
      // it is going to get — and the doctor probes paths derived from it.
      setReady(true);
      if (target === undefined) return;
      setAnswers((current) => {
        // Never overwrite something already typed: the operator's answer is
        // the more recent statement of intent.
        let next = current;
        if ((next[REPO_FIELD] ?? '') === '') next = withAnswer(next, REPO_FIELD, target.url);
        if ((next[REF_FIELD] ?? '') === '') next = withAnswer(next, REF_FIELD, target.ref);
        if ((next[NAME_FIELD] ?? '') === '') next = withAnswer(next, NAME_FIELD, appNameFor(target.url));
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [isMounted, roots.apps]);

  // ---------------------------------------------------------------------------
  // The repository's own environment template (#230)
  // ---------------------------------------------------------------------------
  //
  // Keyed on the repo/ref the operator can still edit on Welcome, so changing
  // either re-fetches. Deliberately NOT gated on `ready`: the doctor waits for
  // the name to settle because its checks probe paths derived from it, while
  // this needs only the repository, and the questions are wanted sooner.
  //
  // A failure is silent by design — `fetchRemoteTemplate` answers `undefined`
  // for a non-GitHub remote, a logged-out gh, a private repo the token cannot
  // see or a timeout, and `specs` falls back to the local template. An install
  // must not be blocked by a file that is an optimisation of correctness.
  useEffect(() => {
    // Only the REPOSITORY is required. An empty ref means the default branch
    // (#234) — the Review screen literally renders it as "(default branch)" —
    // so gating the fetch on it turned the most common first install, where
    // nobody pins a ref, into the one case that never read the template.
    if (repoAnswer === '') return;
    let cancelled = false;

    void (async () => {
      const result = await fetchRemoteTemplate({ repoUrl: repoAnswer, ref: refAnswer });
      if (cancelled || !isMounted()) return;
      if (!result.ok) {
        setRemoteFailure(result);
        return;
      }
      try {
        const parsed = parseEnvExample(result.contents);
        if (parsed.length > 0) {
          setRemoteFailure(undefined);
          setRemoteSpecs(parsed);
          return;
        }
        setRemoteFailure({ ok: false, reason: 'empty' });
      } catch {
        /* Unparseable: keep whatever a local template offered, and say so. */
        setRemoteFailure({ ok: false, reason: 'empty' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [repoAnswer, refAnswer, isMounted]);

  // ---------------------------------------------------------------------------
  // The doctor, live on Welcome
  // ---------------------------------------------------------------------------

  const checkBase = useCallback(
    (): Omit<CheckContext, 'domain' | 'env'> => ({
      runCommand: defaultRunCommand,
      deployRoot,
      name,
      bindPort: Number(answers['APP_BIND_PORT'] ?? DEFAULT_BIND_PORT) || DEFAULT_BIND_PORT,
      proxyRoot: roots.proxy,
      // The whole point of running the doctor while somebody watches: the
      // proxy checks are the ones a fresh server fails, so they are NOT
      // skipped here.
      skipProxy: false,
      ...(answerOf(answers, PUBLIC_IP_FIELD) === ''
        ? {}
        : { publicIp: answerOf(answers, PUBLIC_IP_FIELD) }),
    }),
    [answers, deployRoot, name, roots.proxy],
  );

  const doctorChecks = useMemo(() => welcomeChecks(), []);

  const startDoctor = useCallback(() => {
    setWelcome({ results: [], running: true });
    const base = checkBase();
    void (async () => {
      const results = await runChecks(doctorChecks, base, (result) => {
        if (!isMounted()) return;
        setWelcome((current) => ({ ...current, results: [...current.results, result] }));
      }).catch(() => [] as CompletedCheck[]);
      if (isMounted()) setWelcome({ results, running: false });
    })();
  }, [checkBase, doctorChecks, isMounted]);

  // Held until `ready`: the checks read `deployRoot`, which is
  // `<apps root>/<name>`, and the name arrives from the repository a moment
  // after mount. Probing `/opt/infra/apps/app` first would report on a
  // directory this install is not going to use.
  const doctorStarted = useRef(false);
  useEffect(() => {
    if (!ready || doctorStarted.current) return;
    doctorStarted.current = true;
    startDoctor();
  }, [ready, startDoctor]);

  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'r' && !welcome.running) startDoctor();
    },
    { isActive: phase === 'wizard' && step?.id === WELCOME_STEP_ID && !confirming },
  );

  // ---------------------------------------------------------------------------
  // Per-step arrival: generate secrets, compute suggestions
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (step === undefined) return;
    setStepChecks(IDLE);
    setCreatable(undefined);
    setCreating(undefined);
    setFocusKey(undefined);
    setAnswers((current) => prepareStep(current, step, specs));
  }, [step, specs]);

  useEffect(() => {
    if (step === undefined) return;
    const pending = step.fields.filter(
      (ref) => metadataFor(ref).suggest !== undefined && suggestions[ref] === undefined,
    );
    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      const found: Record<string, Suggestion> = {};
      for (const key of pending) {
        const suggest = metadataFor(key).suggest;
        if (suggest === undefined) continue;
        const suggestion = await suggest({
          domain: answerOf(answers, DOMAIN_FIELD),
          answers: envAnswers(answers),
          facts,
          siblingPorts: siblingBindPorts(roots.apps, deployRoot),
        }).catch(() => undefined);
        if (suggestion !== undefined) found[key] = suggestion;
      }
      if (cancelled || !isMounted() || Object.keys(found).length === 0) return;
      setSuggestions((current) => ({ ...found, ...current }));
    })();
    return () => {
      cancelled = true;
    };
    // `answers` is deliberately not a dependency: a suggestion is computed
    // once per step, from what was known when it opened, and is never
    // recomputed under a field the operator is typing into.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, facts, deployRoot, roots.apps, isMounted]);

  // ---------------------------------------------------------------------------
  // Leaving a step: its checks run first
  // ---------------------------------------------------------------------------

  const leaveStep = useCallback(() => {
    if (step === undefined) return;

    if (step.id === WELCOME_STEP_ID) {
      if (welcome.running || requiredFailures(welcome.results).length > 0) return;
      wizard.next();
      return;
    }

    const onLeave = step.data?.onLeave;
    if (onLeave === undefined) {
      wizard.next();
      return;
    }

    setFocusKey(undefined);
    setStepChecks({ results: [], running: true });
    const base = checkBase();
    void (async () => {
      const results = await onLeave({
        ...stepContextFor(answers, facts),
        checks: ALL_CHECKS,
        runChecks,
        probeTcp,
        base,
      }).catch((error: unknown) => [
        {
          id: `${step.id}-checks`,
          title: `${step.title} checks`,
          severity: 'required' as const,
          status: 'fail' as const,
          detail: formatError(error),
          remedy: 'The check itself failed; the values above can still be corrected.',
          durationMs: 0,
        },
      ]);
      if (!isMounted()) return;
      setStepChecks({ results, running: false });
      if (checksAllowLeaving(results)) {
        wizard.next();
        return;
      }
      // Everything needed to create it is already on screen and already
      // authenticated, so offer rather than send the operator to another
      // terminal. `creatableDatabase` answers only for a database that is
      // genuinely absent — never for some other reason the check failed.
      const target = creatableDatabase(results, envAnswers(answers));
      if (target !== undefined) {
        setCreatable(target);
        return;
      }
      setFocusKey(failedField(results, step));
    })();
  }, [answers, checkBase, facts, isMounted, step, welcome, wizard]);

  /**
   * Creates the offered database, then re-runs the step's checks.
   *
   * Re-running rather than assuming success is the point: `database-privileges`
   * REQUIRES `database-exists`, so until the checks run again it stays skipped
   * and the operator still has no answer to "will the migrations work" — which
   * is the question this step exists to settle.
   */
  const acceptCreate = useCallback(() => {
    if (creatable === undefined || step === undefined) return;
    const target = creatable;
    setCreating(`Creating ${target.settings.database} …`);
    void (async () => {
      const outcome = await createDatabase(
        { ...checkBase(), env: envAnswers(answers) },
        target.settings,
      ).catch((error: unknown) => ({
        ok: false as const,
        detail: formatError(error),
        remedy: 'Create it yourself, then continue.',
      }));
      if (!isMounted()) return;
      setCreatable(undefined);
      if (outcome.ok) {
        setCreating(undefined);
        leaveStep();
        return;
      }
      // Kept on screen beside the failed check rather than replacing it: the
      // operator now knows both that the database is missing AND that this
      // account cannot create it, which is a different problem than either.
      setCreating(`${outcome.detail} — ${outcome.remedy}`);
      setFocusKey(failedField(stepChecks.results, step));
    })();
  }, [answers, checkBase, creatable, isMounted, leaveStep, step, stepChecks.results]);

  // ---------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------

  const append = useCallback(
    (line: string) => {
      if (!isMounted()) return;
      // Oldest-first: the end of a build log is the part that matters.
      setLines((current) => [...current, line].slice(-MAX_LOG_LINES));
    },
    [isMounted],
  );

  const start = useCallback(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setProgress([]);
    setLines([]);
    setStartedAt(Date.now());

    // The ONE place the abort reaches the work: every child process this
    // install spawns is started through here, so SIGTERM arrives wherever the
    // pipeline happens to be.
    const runCommand: typeof defaultRunCommand = (argv, options) =>
      defaultRunCommand(argv, { ...options, signal: controller.signal });

    void (async () => {
      try {
        const result = await runInstall({
          appsRoot: roots.apps,
          name,
          bindPort:
            Number(answers['APP_BIND_PORT'] ?? DEFAULT_BIND_PORT) || DEFAULT_BIND_PORT,
          proxyRoot: roots.proxy,
          ...(answerOf(answers, DOMAIN_FIELD) === ''
            ? {}
            : { domain: answerOf(answers, DOMAIN_FIELD) }),
          answers: envAnswers(answers),
          groups,
          all: isTrue(answers, ALL_FIELD),
          staging: isTrue(answers, STAGING_FIELD),
          installCron: isTrue(answers, INSTALL_CRON_FIELD),
          ...(answerOf(answers, REPO_FIELD) === '' ? {} : { repo: answerOf(answers, REPO_FIELD) }),
          ...(answerOf(answers, REF_FIELD) === '' ? {} : { ref: answerOf(answers, REF_FIELD) }),
          // Every question was asked above; readline cannot ask another while
          // ink holds stdin in raw mode, so the wizard runs with nothing left.
          nonInteractive: true,
          runCommand,
          hooks: {
            onStepStart: ({ id, title }) => {
              if (!isMounted()) return;
              setProgress((current) => [
                ...current.filter((entry) => entry.id !== id),
                { id, title, outcome: 'running' },
              ]);
            },
            onStepResult: (result: StepResult) => {
              if (!isMounted()) return;
              setProgress((current) =>
                current.map((entry) =>
                  entry.id === result.id
                    ? {
                        id: result.id,
                        title: result.title,
                        outcome: result.outcome,
                        durationMs: result.durationMs,
                        detail: result.detail,
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
          done: doneModel({
            ...(result.domain === undefined ? {} : { domain: result.domain }),
            commitSha: result.commitSha,
            journalPath: result.journalPath,
            deployRoot: result.deployRoot,
            name: result.name,
            nextStep: result.nextStep,
          }),
        });
        setPhase('done');
      } catch (error) {
        if (!isMounted()) return;
        if (controller.signal.aborted) {
          setPhase('aborted');
          return;
        }
        const message = formatError(error);
        setOutcome({
          failed: failedModel({
            message,
            ...(currentStepId(progressRef.current) === undefined
              ? {}
              : { stepId: currentStepId(progressRef.current) }),
            ...(journalPathIn(message) === undefined
              ? {}
              : { journalPath: journalPathIn(message) }),
            domain: answerOf(answers, DOMAIN_FIELD),
          }),
        });
        setPhase('failed');
      }
    })();
  }, [answers, append, groups, isMounted, name, roots.apps, roots.proxy]);

  // `progress` read from inside the async closure above without making the
  // whole run depend on it.
  const progressRef = useRef<PipelineProgress[]>([]);
  progressRef.current = progress;

  useEffect(() => {
    if (phase !== 'running' || startedAt === undefined) return;
    const timer = setInterval(() => {
      if (isMounted()) setElapsed(Date.now() - startedAt);
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [phase, startedAt, isMounted]);

  // Load-bearing: without it, leaving the screen tears down the UI and leaves
  // a `docker compose build` running on a production server.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useInput(
    (_input, key) => {
      if (key.escape) setConfirming(true);
    },
    { isActive: phase === 'running' && !confirming },
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

  if (phase === 'running') {
    return (
      <WizardFrame
        title={`Install — running (${formatDuration(elapsed)})`}
        steps={railSteps(steps)}
        current={railSteps(steps).length - 1}
        hints={confirming ? ['enter select'] : ['esc stop', '↑↓ scroll the log']}
      >
        {confirming ? (
          <ConfirmDialog
            message={ABORT_DIALOG.message}
            detail={ABORT_DIALOG.detail}
            danger
            confirmLabel={ABORT_DIALOG.confirmLabel}
            cancelLabel={ABORT_DIALOG.cancelLabel}
            onResult={(confirmed) => {
              setConfirming(false);
              if (!confirmed) return;
              abortRef.current?.abort();
              setPhase('aborted');
            }}
          />
        ) : (
          <Checklist items={pipelineItems(progress)} />
        )}
        <Box marginTop={1} flexDirection="column">
          <ScrollBox
            lines={lines}
            reservedRows={22}
            title="Build log"
            busy={!confirming}
            followTail
            isActive={!confirming}
          />
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'done' && outcome.done !== undefined) {
    return (
      <WizardFrame
        title="Install — done"
        steps={railSteps(steps)}
        current={railSteps(steps).length - 1}
        hints={['enter return to the menu']}
      >
        <Text color="green" bold>
          {outcome.done.title}
        </Text>
        <Box marginTop={1}>
          <KeyValue rows={outcome.done.rows} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold>{outcome.done.nextStep}</Text>
          <Text dimColor>Press Enter to return.</Text>
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'failed' && outcome.failed !== undefined) {
    return (
      <WizardFrame
        title="Install — failed"
        steps={railSteps(steps)}
        current={railSteps(steps).length - 1}
        hints={['enter return to the menu']}
      >
        <ErrorNotice
          message={outcome.failed.message}
          // The exit code will be 0 whatever happened here, so the frame has
          // to carry the failure on its own.
          hint={`${outcome.failed.actionLabel} — \`${CLI_NAME} deploy install --resume\`.`}
        />
        <Box marginTop={1}>
          <KeyValue rows={outcome.failed.rows} />
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'aborted') {
    return (
      <WizardFrame
        title="Install — stopped"
        steps={railSteps(steps)}
        current={railSteps(steps).length - 1}
        hints={['enter return to the menu']}
      >
        <Text color="yellow" bold>
          Stopped.
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {ABORTED_DETAIL.map((line) => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      </WizardFrame>
    );
  }

  if (step === undefined) {
    return (
      <WizardFrame title="Install" steps={[]} current={0} hints={['esc back']}>
        <Text>Nothing to ask.</Text>
      </WizardFrame>
    );
  }

  // One rendered sentence, shared by the Welcome provenance line and the
  // Review refusal — so the operator is told the same thing in both places.
  const remoteProblem =
    remoteFailure === undefined ? undefined : describeRemoteTemplateFailure(remoteFailure);

  const context = stepContextFor(answers, facts);
  const intro =
    step.data?.intro(context) ??
    welcomeIntro({
      deployRoot,
      name,
      repoUrl: repoAnswer,
      ref: refAnswer,
      templateSource,
      remoteProblem,
    });
  const fields = formFieldsFor(step, { specs, answers, suggestions });
  const reviewing = step.id === REVIEW_STEP_ID;

  return (
    <WizardFrame
      title="Install"
      steps={railSteps(steps)}
      current={railIndexFor(steps, wizard.index)}
      hints={hintsFor(step, reviewing)}
    >
      <Box flexDirection="column">
        {step.page === undefined ? null : (
          <Text color="cyan">
            {step.page.section === '' ? 'Other variables' : step.page.section}
            {` — page ${String(step.page.index)} of ${String(step.page.total)}`}
          </Text>
        )}
        {intro.map((line, index) => (
          <Text key={`${index}:${line}`} dimColor>
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </Box>

      {step.id === WELCOME_STEP_ID ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Prerequisites</Text>
          <Checklist items={checkItems(doctorChecks, welcome.results, welcome.running)} />
          {!welcome.running && requiredFailures(welcome.results).length > 0 ? (
            <Box marginTop={1}>
              <ErrorNotice
                message={`${requiredFailures(welcome.results).length} required check(s) failed. The install cannot start until they pass.`}
                hint="Fix them on the server, then press ctrl-r to run them again."
              />
            </Box>
          ) : null}
        </Box>
      ) : null}

      {reviewing ? (
        <Box marginTop={1} flexDirection="column">
          <KeyValue
            rows={reviewRows({
              specs,
              answers,
              suggestions,
              facts,
              name,
              deployRoot,
              repoUrl: answerOf(answers, REPO_FIELD) || '(this checkout)',
              ref: answerOf(answers, REF_FIELD) || '(default branch)',
              proxyContainer: DEFAULT_PROXY_CONTAINER,
            })}
          />
          <Box marginTop={1}>
            {templateSource === 'none' ? (
              // REFUSE, rather than offer an install nobody was asked about
              // (#234). With no template the wizard has no Database, Secrets,
              // OAuth or Administrator step to show — `installSteps` drops a
              // step whose fields do not resolve — so the summary above is
              // confident about a domain and silent about everything the
              // deployment actually needs. Installing here would take every
              // essential value from a template default: POSTGRES_HOST
              // localhost, placeholder secrets, an OAuth client that is not
              // yours. A wizard that could not read its own question list has
              // to say so, not present an install-ready screen.
              <ErrorNotice
                message="The environment template could not be read, so no configuration questions were asked."
                hint={`Nothing was collected for the database, secrets, Google OAuth or the administrator, and installing now would take all of them from template defaults. The remote (${displayRepoUrl(repoAnswer) || 'no repository resolved'}) ${remoteProblem === undefined ? 'was not reached' : `did not answer: ${remoteProblem}`}; no checkout on this server carried one either, and this CLI was installed without a copy. Fix the reason above, or run this from inside a checkout of the repository being deployed, then start again.`}
              />
            ) : (
              <ConfirmDialog
                message="Install with these values?"
                detail={['Nothing has been written yet. This is the first change to the server.']}
                confirmLabel="Yes, install now"
                onResult={(confirmed) => {
                  if (confirmed) start();
                  else wizard.back();
                }}
              />
            )}
          </Box>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Form
            fields={fields}
            values={answers}
            isActive={!stepChecks.running && !confirming && creatable === undefined}
            {...(focusKey === undefined ? {} : { focusKey })}
            onChange={(key, value) => {
              setAnswers((current) => applyChange(current, key, value, fields, specs));
            }}
            onSubmit={leaveStep}
          />
          {stepChecks.running || stepChecks.results.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              <Checklist items={stepCheckItems(step, stepChecks.results, stepChecks.running)} />
            </Box>
          ) : null}
          {creating !== undefined ? (
            <Box marginTop={1}>
              <Text color="yellow">{creating}</Text>
            </Box>
          ) : null}
          {creatable !== undefined ? (
            <Box marginTop={1}>
              <ConfirmDialog
                message={`Create the database ${creatable.settings.database} now?`}
                detail={[
                  `${creatable.description} — the credentials above already authenticated against this server.`,
                  'Only CREATE DATABASE is run. Nothing else on the server is changed, and the migrations still create every table.',
                ]}
                confirmLabel="Yes, create it"
                cancelLabel="No, I will create it myself"
                onResult={(confirmed) => {
                  if (confirmed) {
                    acceptCreate();
                    return;
                  }
                  setCreatable(undefined);
                  setFocusKey(failedField(stepChecks.results, step));
                }}
              />
            </Box>
          ) : null}
        </Box>
      )}
    </WizardFrame>
  );
}

/**
 * One change from the form.
 *
 * The only non-trivial case is a generated secret's mode: choosing "paste"
 * clears the value that was minted for the operator, and choosing "generate"
 * mints a fresh one — so the masked field always shows what will be written.
 * Typing into the value of a generate-mode secret switches the mode itself,
 * because otherwise the next visit to the step would overwrite what was typed.
 */
function applyChange(
  answers: InstallAnswers,
  key: string,
  value: string,
  fields: readonly FormFieldSpec[],
  specs: readonly EnvVarSpec[],
): InstallAnswers {
  if (key.startsWith(SECRET_MODE_PREFIX)) {
    if (answers[key] === value) return answers;
    return applySecretMode(answers, key.slice(SECRET_MODE_PREFIX.length), value as SecretMode);
  }

  if (key.startsWith(OPTION_MODE_PREFIX)) {
    if (answers[key] === value) return answers;
    const target = key.slice(OPTION_MODE_PREFIX.length);
    return applyOptionMode(
      answers,
      target,
      value as OptionMode,
      specs.find((spec) => spec.key === target),
    );
  }

  // Typing into the value of a key whose mode says otherwise switches the
  // mode: without it the next visit to the step would overwrite what was
  // typed with a freshly generated secret, or with the template's default.
  for (const [prefix, typed] of [
    [SECRET_MODE_PREFIX, 'paste'],
    [OPTION_MODE_PREFIX, 'edit'],
  ] as const) {
    const modeKey = `${prefix}${key}`;
    if (!fields.some((field) => field.key === modeKey)) continue;
    if (answers[modeKey] === typed) break;
    return withAnswer(withAnswer(answers, modeKey, typed), key, value);
  }

  return withAnswer(answers, key, value);
}

function hintsFor(step: InstallStep, reviewing: boolean): string[] {
  if (reviewing) return ['enter select', 'esc back'];
  const base = ['tab next field', 'enter continue', 'esc back'];
  if (step.id === WELCOME_STEP_ID) return [...base, 'ctrl-r re-run checks'];
  if (step.optional === true) return [...base, 'blank to skip'];
  return base;
}

/**
 * What Welcome tells the operator about WHERE this is going (#232).
 *
 * The deploy root is not cosmetic: `<name>` is also the docker compose PROJECT
 * name, so it is what keeps two apps on one host from replacing each other's
 * containers. Printing a path the install will not actually use is therefore
 * worse than printing none — which is what happened while the name was still
 * `FALLBACK_APP_NAME`, because a repository had not resolved yet and there was
 * nothing on screen saying so.
 */
function welcomeIntro(input: {
  deployRoot: string;
  name: string;
  repoUrl: string;
  ref: string;
  templateSource: TemplateSource;
  remoteProblem?: string | undefined;
}): string[] {
  const resolved = input.name !== FALLBACK_APP_NAME || input.repoUrl !== '';

  const location = resolved
    ? [
        'This installs the application on THIS server, under',
        '',
        `    ${input.deployRoot}`,
        '',
        `That folder name is also the docker compose project (${input.name}-api-1, …),`,
        'which is what keeps two apps on one host apart.',
      ]
    : [
        'This installs the application on THIS server.',
        '',
        '    The repository has not resolved yet, so the target folder is not',
        '    settled. Fill in Repository below, or run this from inside a',
        `    checkout — until then ${input.deployRoot} is a placeholder, not`,
        '    the answer.',
      ];

  // A fallback SAYS WHY (#236). "the remote could not be read" on its own is
  // the message that made a logged-out `gh`, an uninstalled `gh`, a private
  // repository and a timeout look identical to everyone involved.
  const because = input.remoteProblem === undefined ? '' : ` — ${input.remoteProblem}`;
  const provenance =
    input.templateSource === 'remote'
      ? [`Questions read from ${displayRepoUrl(input.repoUrl)} at ${input.ref}.`]
      : input.templateSource === 'local'
        ? [`Questions read from a local checkout; the remote was not used${because}.`]
        : input.templateSource === 'bundled'
          ? [
              'Questions read from the template saved when this CLI was installed;',
              `the remote was not used${because}.`,
            ]
          : [];

  return [
    ...location,
    '',
    ...provenance,
    ...(provenance.length > 0 ? [''] : []),
    'The prerequisites are being checked below as you read. Nothing is written',
    'to this server until the review at the end is confirmed.',
  ];
}

/** The step that was running when the pipeline stopped. */
function currentStepId(progress: readonly PipelineProgress[]): string | undefined {
  return (
    progress.find((entry) => entry.outcome === 'failed')?.id ??
    progress.find((entry) => entry.outcome === 'running')?.id
  );
}

/** `runInstall`'s failure message names the journal; pull it back out for the table. */
function journalPathIn(message: string): string | undefined {
  return /The full log is at (\S+)/.exec(message)?.[1];
}

/**
 * The template the questions come from.
 *
 * Two places, in order: THIS deployment's own clone (a reinstall or a resume),
 * then the checkout this CLI is being run from (the first install, where
 * nothing has been cloned onto the server yet — `bootstrap-vps.sh` leaves the
 * operator in exactly such a checkout). Before either exists the domain
 * question alone is still enough to get started, which is why this returns an
 * empty list rather than throwing.
 *
 * ⚠ NEVER A SIBLING DEPLOYMENT'S TEMPLATE (#229). Until this took a `name`
 * it enumerated every directory under the apps root and answered with the
 * first `.env.example` that existed, in `readdirSync` order. On a host running
 * one app that is invisible; on a host running two it hands the wizard another
 * product's variable list, and the steps whose keys that list lacks are dropped
 * rather than shown empty (`installSteps`). The reported symptom was an install
 * asking for a neighbouring app's SQLite `DATABASE_URL` and never asking for
 * PostgreSQL at all. A sibling's template is not a degraded answer that beats
 * nothing — it is a wrong answer, and returning `[]` is strictly better, so
 * there is deliberately no fallback to one.
 */
export function loadTemplateSpecs(appsRoot: string, name?: string): EnvVarSpec[] {
  for (const path of templateCandidates(appsRoot, name)) {
    try {
      if (!existsSync(path)) continue;
      return parseEnvExample(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
  }
  return [];
}

function templateCandidates(appsRoot: string, name?: string): string[] {
  const relative = join('infra', 'compose', '.env.example');
  const candidates: string[] = [];

  // This app's own clone, and only this app's. No enumeration of the apps root.
  if (name !== undefined && name !== '') {
    candidates.push(join(appsRoot, name, 'repo', relative));
  }

  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(directory, relative));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return candidates;
}

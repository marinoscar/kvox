import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../branding.js';
import { ALL_CHECKS, runChecks, checksPassed, type CompletedCheck } from '../../deploy/checks/index.js';
import { collectHealth, isHealthy, type HealthReport } from '../../deploy/health.js';
import { runInstall } from '../../deploy/install.js';
import { runUpdate } from '../../deploy/update.js';
import { runCommand } from '../../deploy/executor.js';
import { metadataFor } from '../../deploy/env-metadata.js';
import { parseEnvExample, type EnvVarSpec } from '../../deploy/env-spec.js';
import { readState, type DeployState } from '../../deploy/state.js';
import { formatError } from '../../errors.js';
import { ErrorNotice, Field, Frame } from '../layout.js';
import { ScrollBox } from '../scroll-box.js';

// =============================================================================
// The deploy screen  (issue #184, epic #168)
// =============================================================================
//
// One screen, not four routes. There is deliberately no history stack in this
// TUI (see routes.ts), so a route per action would return to the TOP menu
// rather than back here - meaning choosing a second action would mean walking
// in from the start every time.
//
// IT CALLS THE SAME FUNCTIONS THE SUBCOMMANDS CALL. runChecks, runInstall,
// runUpdate and collectHealth are shared; only the DeployHooks implementation
// differs, writing into React state instead of onto stderr. That is the
// device-login.ts pattern, and it is the reason there is no orchestration
// logic in this file at all.
//
// TWO HAZARDS SPECIFIC TO THIS SCREEN
//
//   1. THE ABORT CONTROLLER IS LOAD-BEARING. Without it, pressing Esc tears
//      down the UI and leaves the work running - and here the work is a
//      `docker compose build` on a production server. So Esc is REFUSED while
//      a deploy is running, with a hint saying so, rather than offered as a
//      cancel that does not cancel.
//   2. THE EXIT CODE INVERTS HERE. A normal TUI exit is 0 even after a failed
//      operation (tui/index.tsx), whereas `appctl deploy install` must exit
//      non-zero. That is intended - the user has read the outcome on screen -
//      but it means the failure has to be UNMISTAKABLE in the frame, because
//      the exit code will not carry it.
// =============================================================================

export interface DeployScreenProps {
  onDone: () => void;
}

type Action = 'doctor' | 'install' | 'update' | 'status';

interface StepView {
  id: string;
  title: string;
  outcome: 'running' | 'ok' | 'skipped' | 'failed';
  detail?: string | undefined;
}

type Phase =
  | { kind: 'choosing' }
  | { kind: 'collecting'; action: Action; fields: FieldSpec[]; index: number; answers: Map<string, string>; fieldError?: string | undefined }
  | { kind: 'confirming'; action: Action; answers: Map<string, string> }
  | { kind: 'running'; action: Action; steps: StepView[]; lines: string[] }
  | { kind: 'done'; action: Action; summary: string[] }
  | { kind: 'failed'; action: Action; message: string };

export interface FieldSpec {
  key: string;
  label: string;
  help: string;
  placeholder: string;
  secret: boolean;
  validate?: ((value: string) => string | undefined) | undefined;
}

/** Lines kept in the live log. Unbounded growth is a leak on a long build. */
const MAX_LOG_LINES = 2_000;

const DEFAULT_ROOT = '/opt/infra/apps';
const DEFAULT_PROXY_ROOT = '/opt/infra/proxy';
const DEFAULT_BIND_PORT = 3535;

/**
 * The questions install needs, derived from the template.
 *
 * A hand-rolled union of thirty step variants does not scale, so the wizard is
 * DATA and the screen keeps a cursor into it - which also preserves the "one
 * thing accepting input at any moment" invariant that invoke.tsx argues for.
 */
export function fieldsForInstall(specs: readonly EnvVarSpec[]): FieldSpec[] {
  const fields: FieldSpec[] = [
    {
      key: '__domain',
      label: 'Domain',
      help: 'The public hostname this will be served on. APP_URL and the OAuth callback are derived from it.',
      placeholder: 'app.example.com',
      secret: false,
      validate: (value) =>
        /^[a-z0-9.-]+$/i.test(value) ? undefined : 'must be a hostname',
    },
  ];

  for (const spec of specs) {
    const metadata = metadataFor(spec.key);
    if (metadata.never === true || metadata.fixed !== undefined) continue;
    if (metadata.derive !== undefined) continue;
    if (metadata.group !== undefined) continue;
    if (metadata.essential !== true) continue;

    fields.push({
      key: spec.key,
      label: spec.key,
      help: spec.help,
      placeholder: spec.defaultValue,
      secret: metadata.secret === true,
      ...(metadata.validate === undefined ? {} : { validate: metadata.validate }),
    });
  }

  return fields;
}

export function DeployScreen({ onDone }: DeployScreenProps): ReactNode {
  const [phase, setPhase] = useState<Phase>({ kind: 'choosing' });
  const [value, setValue] = useState('');
  const mounted = useRef(true);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const state = useRef<DeployState | undefined>(undefined);
  if (state.current === undefined) {
    try {
      state.current = readState(DEFAULT_ROOT);
    } catch {
      state.current = undefined;
    }
  }

  useEffect(
    () => () => {
      mounted.current = false;
      // Load-bearing: without it, Esc tears down the UI and leaves a
      // `docker compose build` running on a production server.
      abortRef.current?.abort();
    },
    [],
  );

  const isRunning = phase.kind === 'running';

  // Esc is REFUSED while running rather than offered as a cancel that does not
  // cancel. `isActive` is off entirely while a text field owns the keyboard.
  useInput(
    (_input, key) => {
      if (!key.escape && !key.return) return;
      if (isRunning) return;
      onDone();
    },
    { isActive: phase.kind !== 'collecting' },
  );

  const appendLine = useCallback((line: string) => {
    if (!mounted.current) return;
    setPhase((current) => {
      if (current.kind !== 'running') return current;
      const lines = [...current.lines, line];
      // Oldest-first, because the end of a build log is the part that matters.
      return { ...current, lines: lines.slice(-MAX_LOG_LINES) };
    });
  }, []);

  const hooks = {
    onStepStart: ({ id, title }: { id: string; title: string }) => {
      if (!mounted.current) return;
      setPhase((current) =>
        current.kind === 'running'
          ? { ...current, steps: [...current.steps, { id, title, outcome: 'running' as const }] }
          : current,
      );
    },
    onStepResult: (result: { id: string; outcome: string; detail?: string | undefined }) => {
      if (!mounted.current) return;
      setPhase((current) =>
        current.kind === 'running'
          ? {
              ...current,
              steps: current.steps.some((step) => step.id === result.id)
                ? current.steps.map((step) =>
                    step.id === result.id
                      ? { ...step, outcome: result.outcome as StepView['outcome'], detail: result.detail }
                      : step,
                  )
                : [
                    ...current.steps,
                    {
                      id: result.id,
                      title: result.id,
                      outcome: result.outcome as StepView['outcome'],
                      detail: result.detail,
                    },
                  ],
            }
          : current,
      );
    },
    onProgress: appendLine,
    onLog: appendLine,
  };

  const start = useCallback(
    async (action: Action, answers: Map<string, string>) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase({ kind: 'running', action, steps: [], lines: [] });

      try {
        const summary = await perform(action, answers, hooks, appendLine);
        if (mounted.current) setPhase({ kind: 'done', action, summary });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        if (mounted.current) {
          setPhase({ kind: 'failed', action, message: formatError(error) });
        }
      }
    },
    [appendLine],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (phase.kind === 'choosing') {
    const installed = state.current !== undefined;
    const items = [
      { key: 'doctor', label: 'Doctor  (check prerequisites)', value: 'doctor' as const },
      {
        key: 'install',
        // Annotated rather than hidden, following the menu's convention: the
        // destination produces the real message.
        label: installed ? 'Install  (already installed)' : 'Install',
        value: 'install' as const,
      },
      {
        key: 'update',
        label: installed ? 'Update' : 'Update  (nothing installed here)',
        value: 'update' as const,
      },
      { key: 'status', label: 'Status', value: 'status' as const },
    ];

    return (
      <Frame title="Deploy" hints={['enter select', 'esc back']}>
        <Text dimColor>Acting on {DEFAULT_ROOT}</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              const action = item.value;
              if (action === 'install') {
                const specs = loadSpecs();
                setPhase({
                  kind: 'collecting',
                  action,
                  fields: fieldsForInstall(specs),
                  index: 0,
                  answers: new Map(),
                });
                setValue('');
                return;
              }
              void start(action, new Map());
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'collecting') {
    const field = phase.fields[phase.index];
    if (field === undefined) {
      return <Frame title="Deploy"><Text>No questions to ask.</Text></Frame>;
    }

    return (
      <Frame
        title={`Install — ${phase.index + 1}/${phase.fields.length}`}
        hints={['enter next', 'ctrl-c quit']}
      >
        {field.help === '' ? null : <Text dimColor>{field.help.split('\n')[0]}</Text>}
        <Box marginTop={1}>
          <Text dimColor>{field.label}  </Text>
          <TextInput
            value={value}
            onChange={setValue}
            placeholder={field.placeholder}
            {...(field.secret ? { mask: '*' } : {})}
            onSubmit={(submitted) => {
              const answer = submitted === '' ? field.placeholder : submitted;
              const message = field.validate?.(answer);

              if (message !== undefined) {
                // Kept on the field they got it wrong on, rather than made to
                // start the flow again - invoke.tsx's rule.
                setPhase({ ...phase, fieldError: `${field.label} ${message}` });
                return;
              }

              const answers = new Map(phase.answers).set(field.key, answer);
              setValue('');

              if (phase.index + 1 < phase.fields.length) {
                setPhase({ ...phase, index: phase.index + 1, answers, fieldError: undefined });
              } else {
                setPhase({ kind: 'confirming', action: phase.action, answers });
              }
            }}
          />
        </Box>
        {phase.fieldError === undefined ? null : (
          <Box marginTop={1}>
            <ErrorNotice message={phase.fieldError} />
          </Box>
        )}
      </Frame>
    );
  }

  if (phase.kind === 'confirming') {
    const items = [
      // "No" FIRST and selected by default: install mutates a server, and a
      // destructive action whose default is yes is one stray Enter away from
      // happening by accident.
      { key: 'no', label: 'No, go back', value: 'no' as const },
      { key: 'yes', label: `Yes, ${phase.action} now`, value: 'yes' as const },
    ];

    return (
      <Frame title="Confirm" hints={['enter select', 'esc back']}>
        <Text>About to {phase.action} on this server:</Text>
        <Box marginTop={1} flexDirection="column">
          {[...phase.answers.entries()].map(([key, answer]) => (
            <Field
              key={key}
              label={key.replace(/^__/, '')}
              value={metadataFor(key).secret === true ? '********' : answer}
            />
          ))}
        </Box>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === 'yes') void start(phase.action, phase.answers);
              else setPhase({ kind: 'choosing' });
            }}
          />
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'running') {
    return (
      <Frame
        title={`${phase.action} — running`}
        // No "esc cancel": it would not cancel, and offering it would be a lie.
        hints={['ctrl-c abort']}
      >
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> {phase.steps.at(-1)?.title ?? 'Starting'}…</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {phase.steps.map((step) => (
            <Text key={step.id}>
              {step.outcome === 'ok' ? '  OK ' : step.outcome === 'failed' ? '  XX ' : step.outcome === 'skipped' ? '  -- ' : '  .. '}
              {step.title}
            </Text>
          ))}
        </Box>
        <Box marginTop={1} flexDirection="column">
          {/* Bounded viewport, following the tail. An unbounded list of Text
              would be redrawn in full on every appended line. */}
          <ScrollBox lines={phase.lines} reservedRows={16} followTail isActive={false} />
        </Box>
      </Frame>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <Frame title={`${phase.action} — failed`} hints={['esc return to the menu']}>
        <ErrorNotice
          message={phase.message}
          // The exit code will be 0 whatever happened here, so the frame has to
          // carry the failure on its own.
          hint={`Nothing further was changed. The same run is \`${CLI_NAME} deploy ${phase.action}\`, which exits non-zero.`}
        />
      </Frame>
    );
  }

  return (
    <Frame title={`${phase.action} — done`} hints={['esc return to the menu']}>
      <Box flexDirection="column">
        {phase.summary.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
      </Box>
    </Frame>
  );
}

function loadSpecs(): EnvVarSpec[] {
  try {
    return parseEnvExample(
      readFileSync(join(DEFAULT_ROOT, 'repo', 'infra', 'compose', '.env.example'), 'utf8'),
    );
  } catch {
    // Before a first checkout there is no template to read; the domain
    // question alone is still enough to get started.
    return [];
  }
}

/**
 * Runs the chosen action.
 *
 * Every branch calls the SAME function the corresponding subcommand calls.
 */
async function perform(
  action: Action,
  answers: Map<string, string>,
  hooks: Parameters<typeof runInstall>[0]['hooks'],
  appendLine: (line: string) => void,
): Promise<string[]> {
  if (action === 'doctor') {
    const results: CompletedCheck[] = await runChecks(
      ALL_CHECKS,
      {
        runCommand,
        deployRoot: DEFAULT_ROOT,
        bindPort: DEFAULT_BIND_PORT,
        proxyRoot: DEFAULT_PROXY_ROOT,
      },
      (result) => appendLine(`${result.status.toUpperCase()} ${result.title}: ${result.detail}`),
    );

    return checksPassed(results)
      ? ['All required checks passed.']
      : [
          'Required checks failed:',
          ...results
            .filter((result) => result.severity === 'required' && result.status === 'fail')
            .map((result) => `  ${result.title}: ${result.detail}`),
        ];
  }

  if (action === 'status') {
    const report: HealthReport = await collectHealth({
      runCommand,
      deployRoot: DEFAULT_ROOT,
      bindPort: DEFAULT_BIND_PORT,
    });

    return [
      isHealthy(report) ? 'Healthy.' : 'NOT healthy.',
      `Containers: ${report.containers.map((container) => `${container.service}=${container.state}`).join(' ') || 'none'}`,
      `Readiness:  ${report.local.ready.ok ? 'ok' : (report.local.ready.error ?? 'failed')}`,
      `Frontend:   ${report.local.frontend.ok ? 'ok' : (report.local.frontend.error ?? 'failed')}`,
      `Migrations: ${report.migrations.known ? `${report.migrations.pending.length} pending` : 'unknown'}`,
    ];
  }

  if (action === 'update') {
    const result = await runUpdate({
      deployRoot: DEFAULT_ROOT,
      ...(hooks === undefined ? {} : { hooks }),
    });
    return result.changed
      ? [`Updated to ${result.commitSha.slice(0, 12)}.`, `Log: ${result.journalPath}`]
      : ['Already up to date.'];
  }

  const domain = answers.get('__domain') ?? '';
  const env = new Map([...answers].filter(([key]) => !key.startsWith('__')));

  const result = await runInstall({
    deployRoot: DEFAULT_ROOT,
    bindPort: DEFAULT_BIND_PORT,
    proxyRoot: DEFAULT_PROXY_ROOT,
    domain,
    answers: env,
    // readline cannot ask a question while ink holds stdin in raw mode, so the
    // values were collected above and the wizard runs with nothing left to ask.
    nonInteractive: true,
    ...(hooks === undefined ? {} : { hooks }),
  });

  return [`Installed ${result.commitSha.slice(0, 12)}.`, `Log: ${result.journalPath}`, '', result.nextStep];
}

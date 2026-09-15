import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { runChecks, type CheckContext, type CompletedCheck } from '../../../deploy/checks/index.js';
import { readEnvFile } from '../../../deploy/env-file.js';
import {
  DEFAULT_APPS_ROOT,
  DEFAULT_BIND_PORT,
  DEFAULT_PROXY_ROOT,
  locateApp,
} from '../../../deploy/layout.js';
import { readState } from '../../../deploy/state.js';
import { DOMAIN_FIELD } from '../../../deploy/wizard/steps.js';
import { Checklist, Form, WizardFrame } from '../../components/index.js';
import { useIsMounted } from '../../layout.js';
import { withSignal } from './abort.js';
import {
  DOCTOR_DEFAULTS,
  doctorChecks,
  doctorFields,
  doctorHints,
  doctorItems,
  doctorProgress,
  doctorScope,
  doctorSummary,
  type DoctorOptions,
} from './doctor-model.js';

// =============================================================================
// Doctor  (issue #132, epic #118)
// =============================================================================
//
// One step, one list, and the two knobs `deploy doctor` takes. The checks
// STREAM: `runChecks`'s `onResult` fires as each completes, so a run that
// spends forty seconds in subprocesses shows a list filling in rather than a
// frame that looks hung.
//
// KEYS (and why these): ctrl-r re-runs, ctrl-d opens the domain field, ctrl-p
// toggles `--skip-proxy`. All three are modified because this screen has an
// EDITABLE FIELD and ink delivers every keystroke to every mounted handler
// (#131's header) — a bare `d` would open the editor from inside itself, and
// a bare `p` would toggle the proxy flag while somebody typed `app.example.com`.
//
// THE EXIT CODE IS NOT THIS SCREEN'S TO SET. `deploy doctor` exits
// EXIT.PRECONDITION on a failed required check; the TUI always exits 0
// (tui/index.tsx), so the verdict lives in the summary line and the colour,
// and the frame names the subcommand for the scripted case.
// =============================================================================

export interface DoctorScreenProps {
  onDone: () => void;
  appsRoot?: string | undefined;
  proxyRoot?: string | undefined;
}

interface Run {
  results: CompletedCheck[];
  running: boolean;
}

const IDLE: Run = { results: [], running: false };

export function DoctorScreen({ onDone, appsRoot, proxyRoot }: DoctorScreenProps): ReactNode {
  const isMounted = useIsMounted();
  const roots = useMemo(
    () => ({ apps: appsRoot ?? DEFAULT_APPS_ROOT, proxy: proxyRoot ?? DEFAULT_PROXY_ROOT }),
    [appsRoot, proxyRoot],
  );

  const checks = useMemo(() => doctorChecks(), []);
  const [options, setOptions] = useState<DoctorOptions>(DOCTOR_DEFAULTS);
  const [draftDomain, setDraftDomain] = useState('');
  const [run, setRun] = useState<Run>(IDLE);

  const abortRef = useRef<AbortController | undefined>(undefined);

  // Read once per mount: both touch the filesystem, and this component
  // re-renders on every keystroke into the domain field.
  const site = useMemo(() => resolveSite(roots.apps), [roots.apps]);

  // Load-bearing: without it, leaving the screen mid-run leaves a `docker`,
  // an `openssl` and a `dig` running with nowhere to report.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const start = useCallback(
    (current: DoctorOptions) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setRun({ results: [], running: true });

      const context: CheckContext = {
        runCommand: withSignal(controller.signal),
        deployRoot: site.deployRoot,
        bindPort: site.bindPort,
        proxyRoot: roots.proxy,
        skipProxy: current.skipProxy,
        ...(site.name === undefined ? {} : { name: site.name }),
        ...(site.env === undefined ? {} : { env: site.env }),
        ...(site.repoUrl === undefined ? {} : { repoUrl: site.repoUrl }),
        ...(current.domain === '' ? {} : { domain: current.domain }),
      };

      void (async () => {
        const results = await runChecks(checks, context, (result) => {
          if (!isMounted() || controller.signal.aborted) return;
          setRun((state) => ({ ...state, results: [...state.results, result] }));
        }).catch(() => [] as CompletedCheck[]);
        if (!isMounted() || controller.signal.aborted) return;
        setRun({ results, running: false });
      })();
    },
    [checks, isMounted, roots.proxy, site],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start(DOCTOR_DEFAULTS);
  }, [start]);

  // Esc from the domain editor closes it without applying; Esc anywhere else
  // is the one meaning it has everywhere (routes.ts): back.
  useInput(
    (input, key) => {
      if (key.escape) {
        if (options.editingDomain) setOptions((current) => ({ ...current, editingDomain: false }));
        else onDone();
        return;
      }
      if (options.editingDomain || !key.ctrl) return;

      const letter = input.toLowerCase();
      if (letter === 'r' && !run.running) {
        start(options);
        return;
      }
      if (letter === 'd') {
        setDraftDomain(options.domain);
        setOptions((current) => ({ ...current, editingDomain: true }));
        return;
      }
      if (letter === 'p') {
        // A toggle that did not re-run would leave the list contradicting the
        // flag on the hint line until somebody pressed ctrl-r.
        setOptions((current) => {
          const next = { ...current, skipProxy: !current.skipProxy };
          start(next);
          return next;
        });
      }
    },
    { isActive: true },
  );

  const summary = doctorSummary(run.results);
  const items = doctorItems(checks, run.results, run.running);

  return (
    <WizardFrame
      title="Doctor"
      steps={[{ id: 'doctor', title: 'Prerequisites' }]}
      current={0}
      hints={doctorHints(options, run.running)}
    >
      <Box flexDirection="column">
        <Text dimColor>{doctorScope(options)}</Text>
        {run.running ? (
          <Text dimColor>{doctorProgress(run.results.length, checks.length)}</Text>
        ) : (
          <Text bold color={summary.ok ? (summary.attention ? 'yellow' : 'green') : 'red'}>
            {summary.headline}
          </Text>
        )}
      </Box>

      {options.editingDomain ? (
        <Box marginTop={1} flexDirection="column">
          <Form
            fields={doctorFields(options)}
            values={{ [DOMAIN_FIELD]: draftDomain }}
            isActive
            onChange={(_key, value) => {
              setDraftDomain(value);
            }}
            onSubmit={() => {
              setOptions((current) => {
                const next = { ...current, domain: draftDomain.trim(), editingDomain: false };
                start(next);
                return next;
              });
            }}
          />
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Checklist items={items} />
      </Box>

      {!run.running && !summary.ok ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" bold>
            {`${summary.failed} check(s) failed. The remedies are under each one.`}
          </Text>
          <Text dimColor>
            {/* The TUI always exits 0, so a script needs the subcommand. */}
            {`For a non-zero exit code in a script: ${CLI_NAME} deploy doctor`}
          </Text>
        </Box>
      ) : null}
    </WizardFrame>
  );
}

interface Site {
  deployRoot: string;
  bindPort: number;
  name?: string | undefined;
  env?: ReadonlyMap<string, string> | undefined;
  repoUrl?: string | undefined;
}

/**
 * What the checks need to know about this box, best-effort.
 *
 * Doctor must run on a server with NOTHING installed — that is its main use —
 * so every lookup here degrades to "not known" and the checks that depend on
 * it report `skip` rather than the screen refusing to open.
 */
function resolveSite(appsRoot: string): Site {
  const nothing: Site = { deployRoot: `${appsRoot}/app`, bindPort: DEFAULT_BIND_PORT };
  try {
    const layout = locateApp({ appsRoot });
    if (layout === undefined) return nothing;

    const state = safeState(layout.deployRoot);
    const env = safeEnv(layout.deployRoot);
    return {
      deployRoot: layout.deployRoot,
      bindPort: state?.bindPort ?? DEFAULT_BIND_PORT,
      name: layout.name,
      ...(env === undefined ? {} : { env }),
      ...(state?.repoUrl === undefined ? {} : { repoUrl: state.repoUrl }),
    };
  } catch {
    // Several apps installed and none named: `locateApp` refuses rather than
    // guessing. The host checks still mean something without one.
    return nothing;
  }
}

function safeState(deployRoot: string): ReturnType<typeof readState> {
  try {
    return readState(deployRoot);
  } catch {
    return undefined;
  }
}

function safeEnv(deployRoot: string): Map<string, string> | undefined {
  try {
    return readEnvFile(deployRoot);
  } catch {
    return undefined;
  }
}

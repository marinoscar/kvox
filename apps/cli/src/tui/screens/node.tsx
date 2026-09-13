import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../branding.js';
import { formatError } from '../../errors.js';
import { runDoctor, type DoctorReport } from '../../node/doctor.js';
import { registerNode, enrollNode } from '../../node/enrollment.js';
import { spawnDetachedDaemon } from '../../node/lifecycle.js';
import { formatLogRecord } from '../../node/logger.js';
import { HttpNodeApi } from '../../node/node-api.js';
import { resolveNodeConfig, type ResolvedNodeConfig } from '../../node/node-config.js';
import {
  NodeDashboardSource,
  describeEvent,
  elapsedMs,
  formatDuration,
  type DashboardState,
} from '../../node/node-dashboard-source.js';
import { nodeLogPath, nodePidPath, nodeSocketPath, nodeStateDir } from '../../node/paths.js';
import { ErrorNotice, Field, Frame } from '../layout.js';
import { ScrollBox } from '../scroll-box.js';

// =============================================================================
// The worker node screen  (issue #279, epic #254)
// =============================================================================
//
// ONE SCREEN, NOT FIVE ROUTES — the same reasoning as the deploy screen: this
// TUI has no history stack (see routes.ts), so a route per action would return
// to the TOP menu, and choosing a second action would mean walking in from the
// start every time.
//
// IT CALLS THE SAME FUNCTIONS THE SUBCOMMANDS CALL. `registerNode`,
// `enrollNode`, `runDoctor` and `NodeDashboardSource` are shared verbatim;
// only the rendering differs. There is no orchestration logic in this file at
// all, which is what "no duplicated logic" means here and is asserted
// structurally in `node-dashboard-source.test.ts`.
//
// -----------------------------------------------------------------------------
// ATTACHING IS READ-ONLY
// -----------------------------------------------------------------------------
//
// The dashboard renders a stream the daemon already pushes and sends nothing
// back, so an operator can inspect a systemd unit or a container running
// production work without perturbing it, and pressing Esc leaves it running
// untouched. A TUI that could stop a fleet member from a highlighted row is a
// liability; `set-concurrency` and `stop` stay one-line commands.
//
// -----------------------------------------------------------------------------
// WITH NO DAEMON RUNNING, IT SPAWNS A DETACHED ONE AND ATTACHES
// -----------------------------------------------------------------------------
//
// Rather than running the engine inside this process. That is deliberate: an
// interactive process CANNOT re-exec itself to raise its heap ceiling (#277)
// without destroying raw-mode input, so sustained work in-process would
// silently run at the low default limit — the least suitable configuration for
// exactly the long jobs a node exists to take. The detached daemon gets the
// tuning; the TUI gets a stream.
// =============================================================================

export interface NodeScreenProps {
  onDone: () => void;
}

type Action = 'dashboard' | 'register' | 'enroll' | 'doctor' | 'logs';

interface ActionItem {
  key: string;
  label: string;
  value: Action | 'back';
}

export function NodeScreen({ onDone }: NodeScreenProps): ReactNode {
  const [action, setAction] = useState<Action | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [dashboard, setDashboard] = useState<DashboardState | undefined>(undefined);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | undefined>(undefined);
  const sourceRef = useRef<NodeDashboardSource | undefined>(undefined);

  const config = useMemo<ResolvedNodeConfig | undefined>(() => {
    try {
      return resolveNodeConfig();
    } catch {
      // A machine that has never logged in still gets a usable screen: Enroll
      // is precisely what it needs, and refusing to render would hide it.
      return undefined;
    }
  }, []);

  // Esc always returns, and the dashboard is read-only, so unlike the deploy
  // screen there is nothing here that Esc must be refused during.
  useInput((_input, key) => {
    if (!key.escape) return;
    if (action === undefined) {
      onDone();
      return;
    }
    setAction(undefined);
    setError(undefined);
    setNotice(undefined);
  });

  // Detach on unmount. Without this the source's reconnect timer would outlive
  // the screen and keep the ink process alive, which looks exactly like a hang.
  useEffect(() => {
    return () => {
      sourceRef.current?.stop();
      sourceRef.current = undefined;
    };
  }, []);

  const startDashboard = useCallback(() => {
    const socketPath = nodeSocketPath();
    const source = new NodeDashboardSource({
      socketPath,
      onChange: (state) => setDashboard(state),
    });
    sourceRef.current = source;
    void source.start();
  }, []);

  const run = useCallback(
    async (chosen: Action) => {
      setAction(chosen);
      setError(undefined);
      setNotice(undefined);

      if (chosen === 'dashboard') {
        startDashboard();
        return;
      }

      if (chosen === 'logs') {
        return; // rendered straight from the file below
      }

      if (config === undefined) {
        setError(`No server or credential is configured. Choose Enroll, or run \`${CLI_NAME} node enroll\`.`);
        return;
      }

      setBusy(true);
      try {
        if (chosen === 'register') {
          const api = HttpNodeApi.create(config.serverUrl, config.token);
          const result = await registerNode({ api, node: config.node });
          setNotice(
            `${result.reattached ? 'Reattached to' : 'Registered'} "${result.node.name}" (${result.node.id}).`,
          );
        } else if (chosen === 'enroll') {
          const result = await enrollNode({
            serverUrl: config.serverUrl,
            hooks: {
              onCodeIssued: (grant) => {
                setNotice(`Open ${grant.verificationUriComplete} and confirm the code ${grant.userCode}`);
              },
            },
          });
          setNotice(`Enrolled. Credential "${result.credentialName}" stored in ${result.configPath}.`);
        } else {
          const report = await runDoctor({
            config,
            socketPath: nodeSocketPath(),
            pidPath: nodePidPath(),
            stateDir: nodeStateDir(),
            api: HttpNodeApi.create(config.serverUrl, config.token),
          });
          setDoctorReport(report);
        }
      } catch (caught) {
        setError(formatError(caught));
      } finally {
        setBusy(false);
      }
    },
    [config, startDashboard],
  );

  // ---------------------------------------------------------------------------
  // The action list
  // ---------------------------------------------------------------------------
  if (action === undefined) {
    const items: ActionItem[] = [
      { key: 'dashboard', label: 'Dashboard  (attach to the running worker)', value: 'dashboard' },
      { key: 'doctor', label: 'Doctor  (machine, server, worker)', value: 'doctor' },
      { key: 'logs', label: 'Logs', value: 'logs' },
      { key: 'register', label: 'Register this machine', value: 'register' },
      { key: 'enroll', label: 'Enroll  (login and mint a node credential)', value: 'enroll' },
      { key: 'back', label: 'Back', value: 'back' },
    ];

    return (
      <Frame title="Worker node" hints={['↑↓ move', 'enter select', 'esc back']}>
        <Box flexDirection="column" gap={1}>
          <Text dimColor>
            {config === undefined
              ? 'Not configured on this machine yet.'
              : `${config.node.name} · ${config.serverUrl} · concurrency ${config.node.concurrency}`}
          </Text>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === 'back') {
                onDone();
                return;
              }
              void run(item.value);
            }}
          />
        </Box>
      </Frame>
    );
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------
  if (action === 'dashboard') {
    return <DashboardView state={dashboard} onSpawn={startDashboard} />;
  }

  // ---------------------------------------------------------------------------
  // Logs
  // ---------------------------------------------------------------------------
  if (action === 'logs') {
    return <LogView />;
  }

  // ---------------------------------------------------------------------------
  // Doctor / register / enroll
  // ---------------------------------------------------------------------------
  return (
    <Frame title={`Worker node — ${action}`} hints={['esc back']}>
      <Box flexDirection="column" gap={1}>
        {busy ? (
          <Text>
            <Spinner type="dots" /> Working…
          </Text>
        ) : null}
        {notice !== undefined ? <Text color="green">{notice}</Text> : null}
        {error !== undefined ? <ErrorNotice message={error} /> : null}
        {doctorReport !== undefined
          ? doctorReport.checks.map((check) => (
              <Field
                key={check.id}
                label={check.label}
                value={check.detail}
                color={check.status === 'fail' ? 'red' : check.status === 'warn' ? 'yellow' : 'green'}
              />
            ))
          : null}
      </Box>
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// The dashboard view
// -----------------------------------------------------------------------------

function DashboardView({
  state,
  onSpawn,
}: {
  state: DashboardState | undefined;
  onSpawn: () => void;
}): ReactNode {
  const [spawning, setSpawning] = useState(false);
  const [spawnError, setSpawnError] = useState<string | undefined>(undefined);
  // A ticking clock so elapsed times advance between events, which on a worker
  // running one long job is most of the time.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useInput((input) => {
    if (input !== 's' || spawning) return;
    setSpawning(true);
    try {
      // The DETACHED, memory-tuned daemon — never the engine in this process.
      // See the file header for why.
      spawnDetachedDaemon({ logPath: nodeLogPath(), args: ['node', 'start'] });
      onSpawn();
    } catch (error) {
      setSpawnError(formatError(error));
    } finally {
      setSpawning(false);
    }
  });

  const snapshot = state?.snapshot;

  const lines = useMemo(() => (state?.events ?? []).map(describeEvent), [state?.events]);

  if (state === undefined || (!state.connected && !state.everConnected)) {
    return (
      <Frame title="Worker node — dashboard" hints={['s start a worker', 'esc back']}>
        <Box flexDirection="column" gap={1}>
          <Text>
            <Spinner type="dots" /> {state?.error ?? 'Looking for a running worker…'}
          </Text>
          <Text dimColor>
            Press <Text bold>s</Text> to start one in the background and attach to it.
          </Text>
          {spawnError !== undefined ? <ErrorNotice message={spawnError} /> : null}
        </Box>
      </Frame>
    );
  }

  return (
    <Frame title="Worker node — dashboard" hints={['↑↓ scroll', 'esc detach']}>
      <Box flexDirection="column" gap={1}>
        <Box gap={2}>
          <Text color={state.connected ? 'green' : 'yellow'}>
            {state.connected ? '● attached' : '○ reconnecting'}
          </Text>
          <Text dimColor>{snapshot?.nodeId ?? '(unknown node)'}</Text>
        </Box>

        {snapshot !== undefined ? (
          <Box flexDirection="column">
            <Field label="Status" value={snapshot.status} />
            <Field label="Concurrency" value={String(snapshot.concurrency)} />
            <Field label="Types" value={snapshot.eligibleTypes.join(', ') || '(none)'} />
            <Field
              label="Totals"
              value={
                `${snapshot.counters.succeeded} ok · ${snapshot.counters.failed} failed · ` +
                `${snapshot.counters.rateLimited} rate-limited of ${snapshot.counters.claimed} claimed`
              }
            />
            <Field
              label="Heartbeat"
              value={snapshot.heartbeatAgeMs === null ? 'never' : `${Math.round(snapshot.heartbeatAgeMs / 1000)}s ago`}
            />
          </Box>
        ) : null}

        {snapshot !== undefined && snapshot.activeJobs.length > 0 ? (
          <Box flexDirection="column">
            <Text bold>Active</Text>
            {snapshot.activeJobs.map((job) => (
              <Text key={job.jobId}>
                {'  '}
                {job.type} {job.jobId} — {formatDuration(elapsedMs(job.startedAt, now))}
              </Text>
            ))}
          </Box>
        ) : null}

        <Box flexDirection="column">
          <Text bold>Events</Text>
          <ScrollBox lines={lines} reservedRows={18} isActive followTail />
        </Box>
      </Box>
    </Frame>
  );
}

// -----------------------------------------------------------------------------
// The log view
// -----------------------------------------------------------------------------

function LogView(): ReactNode {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        // Dynamic, so the file read is not attempted at module load — this
        // screen is mounted only when chosen.
        const { readLogTail } = await import('../../node/logger.js');
        const records = readLogTail(nodeLogPath(), 200);
        if (!cancelled) setLines(records.map(formatLogRecord));
      } catch (caught) {
        if (!cancelled) setError(formatError(caught));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <Frame title="Worker node — logs" hints={['↑↓ scroll', 'esc back']}>
      {error !== undefined ? (
        <ErrorNotice message={error} />
      ) : lines.length === 0 ? (
        <Text dimColor>No log lines yet — {nodeLogPath()}</Text>
      ) : (
        <ScrollBox lines={lines} reservedRows={8} isActive followTail />
      )}
    </Frame>
  );
}

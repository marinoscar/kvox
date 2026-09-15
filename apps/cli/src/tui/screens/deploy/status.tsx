import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { updateDeployInfoRemote, type DeployRemote } from '../../../deploy/deploy-info.js';
import { collectHealth, type HealthReport } from '../../../deploy/health.js';
import { DEFAULT_APPS_ROOT, DEFAULT_BIND_PORT, locateInstalledApp } from '../../../deploy/layout.js';
import { readState, type DeployState } from '../../../deploy/state.js';
import { checkForUpdate, remoteFromCheck } from '../../../deploy/update.js';
import { formatError } from '../../../errors.js';
import { KeyValue, WizardFrame } from '../../components/index.js';
import { ErrorNotice, useIsMounted } from '../../layout.js';
import { withSignal } from './abort.js';
import { statusHints, statusModel } from './status-model.js';

// =============================================================================
// Status  (issue #132, epic #118)
// =============================================================================
//
// `collectHealth` IS CALLED WITH `state`, which the screen this replaces did
// not do — so the revision and last-deployed lines `deploy status` prints
// first were missing from the TUI entirely. See `status-model.ts`'s header.
//
// The remote check is a SEPARATE, non-blocking question, exactly as the
// subcommand treats it: "is it serving?" and "is it current?" have different
// answers and the second must never fail the first, so it lands in its own
// state and a failure becomes a row rather than an error screen.
//
// KEYS: `r` refreshes. Bare, because this screen has no editable field.
// =============================================================================

export interface StatusScreenProps {
  onDone: () => void;
  appsRoot?: string | undefined;
}

interface Site {
  deployRoot: string;
  name: string;
  state: DeployState;
}

type SiteOrError = Site | { error: string };

export function StatusScreen({ onDone, appsRoot }: StatusScreenProps): ReactNode {
  const isMounted = useIsMounted();
  const root = appsRoot ?? DEFAULT_APPS_ROOT;
  const site = useMemo(() => resolveSite(root), [root]);

  const [report, setReport] = useState<HealthReport | undefined>(undefined);
  const [remote, setRemote] = useState<DeployRemote | undefined>(undefined);
  const [remoteError, setRemoteError] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const refresh = useCallback(() => {
    if ('error' in site) {
      setError(site.error);
      setRefreshing(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRefreshing(true);
    setError(undefined);

    const runCommand = withSignal(controller.signal);
    const live = (): boolean => isMounted() && !controller.signal.aborted;

    void (async () => {
      try {
        const collected = await collectHealth({
          runCommand,
          deployRoot: site.deployRoot,
          name: site.name,
          bindPort: site.state.bindPort || DEFAULT_BIND_PORT,
          ...(site.state.domain === undefined ? {} : { domain: site.state.domain }),
          // THE FIX (#132): without this the report carries no `deployed`
          // block, and the revision and last-deployed lines vanish.
          state: site.state,
        });
        if (!live()) return;
        setReport(collected);
      } catch (caught) {
        if (!live()) return;
        setError(formatError(caught));
      } finally {
        if (live()) setRefreshing(false);
      }
    })();

    // Deliberately not awaited with the health collection: a slow or failing
    // fetch must not hold up the answer to "is it serving?".
    void (async () => {
      try {
        const { check } = await checkForUpdate({
          deployRoot: site.deployRoot,
          state: site.state,
          runCommand,
          fetchTimeoutMs: 10_000,
          requireExisting: true,
        });
        const found = remoteFromCheck(check);
        // Recorded on the way past, which is how the About page and the web
        // card learn it (epic #118 decision 7).
        updateDeployInfoRemote(site.deployRoot, found);
        if (!live()) return;
        setRemote(found);
        setRemoteError(undefined);
      } catch (caught) {
        if (!live()) return;
        setRemote(undefined);
        setRemoteError(firstLine(formatError(caught)));
      }
    })();
  }, [isMounted, site]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    refresh();
  }, [refresh]);

  useInput((input, key) => {
    if (key.escape) {
      onDone();
      return;
    }
    if (input.toLowerCase() === 'r' && !refreshing) refresh();
  });

  const rail = [{ id: 'status', title: 'Health' }];

  if (error !== undefined) {
    return (
      <WizardFrame title="Status" steps={rail} current={0} hints={statusHints(refreshing)}>
        <ErrorNotice message={error} hint={`The same check runs as \`${CLI_NAME} deploy status\`.`} />
      </WizardFrame>
    );
  }

  if (report === undefined) {
    return (
      <WizardFrame title="Status" steps={rail} current={0} hints={['esc back']}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Collecting containers, probes and schema state…</Text>
        </Box>
      </WizardFrame>
    );
  }

  const model = statusModel({
    report,
    ...(remote === undefined ? {} : { remote }),
    ...(remoteError === undefined ? {} : { remoteError }),
  });

  return (
    <WizardFrame title="Status" steps={rail} current={0} hints={statusHints(refreshing)}>
      {model.healthy ? (
        <Text bold color="green">
          healthy
        </Text>
      ) : (
        <Text bold color="red">
          NOT healthy
        </Text>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Deployment</Text>
        <KeyValue rows={model.deployment} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Containers</Text>
        <KeyValue rows={model.containers} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Probes and schema</Text>
        <KeyValue rows={model.probes} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          {/* The TUI always exits 0, so a monitor needs the subcommand. */}
          {`For an exit code a monitor can act on: ${CLI_NAME} deploy status`}
        </Text>
        <Text dimColor>{`For the full inventory: ${CLI_NAME} deploy about`}</Text>
      </Box>
    </WizardFrame>
  );
}

/** The one deployment this screen reports on, or why there isn't one. */
function resolveSite(appsRoot: string): SiteOrError {
  try {
    const layout = locateInstalledApp({ appsRoot });
    const state = readState(layout.deployRoot);
    if (state === undefined) {
      return { error: `No deployment found at ${layout.deployRoot}.` };
    }
    return { deployRoot: layout.deployRoot, name: layout.name, state };
  } catch (caught) {
    return { error: formatError(caught) };
  }
}

function firstLine(message: string): string {
  return message.split('\n')[0] ?? message;
}

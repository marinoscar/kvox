import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { collectAbout, type AboutReport } from '../../../deploy/about.js';
import { DEFAULT_APPS_ROOT } from '../../../deploy/layout.js';
import { formatError } from '../../../errors.js';
import { KeyValue, WizardFrame } from '../../components/index.js';
import { ErrorNotice, useIsMounted } from '../../layout.js';
import { withSignal } from './abort.js';
import { aboutHints, aboutModel } from './about-model.js';

// =============================================================================
// About  (issue #132, epic #118)
// =============================================================================
//
// `collectAbout` (#128) does the work; this renders its three blocks and binds
// two keys. Nothing here is derived from anything the report does not carry.
//
// IT MUST WORK WITH THE API DOWN, which is most of the point — About is the
// command an operator runs when something is wrong. `collectAbout` throws only
// when NOTHING IS INSTALLED; a stopped API, a missing deploy record, an
// unreachable remote and an unprobeable host are all rows naming why, so this
// screen has exactly one error state.
//
// `c` AND `r` ARE SEPARATE KEYS ON PURPOSE. `r` re-reads the files and asks
// the API, all of it local or loopback. `c` additionally runs #123's update
// check, which fetches from GitHub — and a refresh that could hang on a dead
// network would make the one screen an operator reaches for during an outage
// the one screen that does not answer.
// =============================================================================

export interface AboutScreenProps {
  onDone: () => void;
  appsRoot?: string | undefined;
}

export function AboutScreen({ onDone, appsRoot }: AboutScreenProps): ReactNode {
  const isMounted = useIsMounted();
  const root = appsRoot ?? DEFAULT_APPS_ROOT;

  const [report, setReport] = useState<AboutReport | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const load = useCallback(
    (check: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setBusy(true);
      setChecking(check);
      setError(undefined);

      const live = (): boolean => isMounted() && !controller.signal.aborted;

      void (async () => {
        try {
          const collected = await collectAbout({
            appsRoot: root,
            runCommand: withSignal(controller.signal),
            check,
          });
          if (!live()) return;
          setReport(collected);
        } catch (caught) {
          // The one error state: nothing is installed here.
          if (!live()) return;
          setError(formatError(caught));
        } finally {
          if (live()) {
            setBusy(false);
            setChecking(false);
          }
        }
      })();
    },
    [isMounted, root],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load(false);
  }, [load]);

  useInput((input, key) => {
    if (key.escape) {
      onDone();
      return;
    }
    if (busy) return;
    const letter = input.toLowerCase();
    if (letter === 'r') load(false);
    if (letter === 'c') load(true);
  });

  const rail = [{ id: 'about', title: 'About' }];
  const model = useMemo(
    () => (report === undefined ? undefined : aboutModel(report)),
    [report],
  );

  if (error !== undefined) {
    return (
      <WizardFrame title="About" steps={rail} current={0} hints={['esc back']}>
        <ErrorNotice
          message={error}
          hint={`The same report runs as \`${CLI_NAME} deploy about\`.`}
        />
      </WizardFrame>
    );
  }

  if (model === undefined) {
    return (
      <WizardFrame title="About" steps={rail} current={0} hints={['esc back']}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Reading the deployment record, the host and the API…</Text>
        </Box>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      title="About"
      steps={rail}
      current={0}
      hints={aboutHints(busy, checking)}
    >
      {model.updateAvailable === true ? (
        <Box marginBottom={1}>
          <Text bold color="yellow">
            An update is available.
          </Text>
        </Box>
      ) : null}

      <Box flexDirection="column">
        <Text bold>Application</Text>
        <KeyValue rows={model.application} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Deployment</Text>
        <KeyValue rows={model.deployment} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Server</Text>
        <KeyValue rows={model.server} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Every time above is UTC.</Text>
        {model.apiUnavailable ? (
          <Text dimColor>
            The API block needs a credential for THIS deployment; log in from the menu.
          </Text>
        ) : null}
      </Box>
    </WizardFrame>
  );
}

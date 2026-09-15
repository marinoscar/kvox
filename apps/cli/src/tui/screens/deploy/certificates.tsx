import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { DEFAULT_PROXY_CONTAINER, findRenewal } from '../../../deploy/checks/index.js';
import {
  DEFAULT_APPS_ROOT,
  DEFAULT_BIND_PORT,
  DEFAULT_PROXY_ROOT,
  locateApp,
} from '../../../deploy/layout.js';
import {
  certificateExpiry,
  defaultCliPath,
  installRenewalCron,
  listCertificates,
  renewCertificates,
  type CertificateExpiry,
} from '../../../deploy/proxy.js';
import { readState, type DeployState } from '../../../deploy/state.js';
import { formatError } from '../../../errors.js';
import { Checklist, ConfirmDialog, KeyValue, WizardFrame } from '../../components/index.js';
import { ErrorNotice, useIsMounted } from '../../layout.js';
import { ScrollBox } from '../../scroll-box.js';
import { withSignal } from './abort.js';
import { MAX_LOG_LINES } from './install-model.js';
import {
  certificateActionTitle,
  certificateActions,
  certificatesHints,
  certificatesModel,
  renewalOutcome,
  type CertificateAction,
} from './certificates-model.js';

// =============================================================================
// Certificates  (issue #132, epic #118)
// =============================================================================
//
// The proxy is shared, so its certificates are a HOST-level concern reachable
// through any one app's state (`commands/deploy.ts`'s certs header): the app
// knows the proxy root and container, and reading expiries never singles an
// app out. This screen therefore opens even when `locateApp` cannot pick one.
//
// THE DRY RUN IS OFFERED FIRST. Let's Encrypt rate-limits issuance, and
// `--dry-run` rehearses against staging without spending any of it. Each of
// the three actions goes through a `ConfirmDialog` and streams certbot's own
// output into a `ScrollBox`, because "it said something and exited" is not an
// answer when the thing that failed is TLS.
//
// THE RENEWAL IS RUN THROUGH `withSignal`: certbot is a `docker run` that can
// take minutes, and Esc has to reach it rather than merely unmount the frame.
//
// KEYS: Enter/arrows belong to the action list; `r` refreshes. Bare, because
// this screen has no editable field.
// =============================================================================

export interface CertificatesScreenProps {
  onDone: () => void;
  appsRoot?: string | undefined;
  proxyRoot?: string | undefined;
}

type Phase = 'loading' | 'menu' | 'confirming' | 'running' | 'finished';

interface Scope {
  proxyRoot: string;
  proxyContainer: string;
  /** The app the cron is written on behalf of; absent when none was resolved. */
  app?: { name: string; appsRoot: string } | undefined;
}

export function CertificatesScreen({
  onDone,
  appsRoot,
  proxyRoot,
}: CertificatesScreenProps): ReactNode {
  const isMounted = useIsMounted();
  const roots = useMemo(
    () => ({ apps: appsRoot ?? DEFAULT_APPS_ROOT, proxy: proxyRoot }),
    [appsRoot, proxyRoot],
  );
  const scope = useMemo(() => resolveScope(roots.apps, roots.proxy), [roots.apps, roots.proxy]);

  const [phase, setPhase] = useState<Phase>('loading');
  const [entries, setEntries] = useState<CertificateExpiry[]>([]);
  const [renewal, setRenewal] = useState<string | undefined>(undefined);
  const [action, setAction] = useState<CertificateAction | undefined>(undefined);
  const [lines, setLines] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const abortRef = useRef<AbortController | undefined>(undefined);

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
  // Reading: expiries, then whether anything is going to renew them
  // ---------------------------------------------------------------------------

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');
    setError(undefined);

    const runCommand = withSignal(controller.signal);
    const live = (): boolean => isMounted() && !controller.signal.aborted;

    void (async () => {
      try {
        const domains = listCertificates(scope.proxyRoot);
        const found: CertificateExpiry[] = [];
        for (const domain of domains) {
          found.push(
            await certificateExpiry(
              { domain, bindPort: DEFAULT_BIND_PORT, proxyRoot: scope.proxyRoot },
              runCommand,
            ),
          );
        }
        if (!live()) return;
        setEntries(found);

        const scheduled = await findRenewal({
          runCommand,
          deployRoot: scope.proxyRoot,
          bindPort: DEFAULT_BIND_PORT,
          proxyRoot: scope.proxyRoot,
        }).catch(() => undefined);
        if (!live()) return;
        setRenewal(scheduled);
        setPhase('menu');
      } catch (caught) {
        if (!live()) return;
        setError(formatError(caught));
        setPhase('menu');
      }
    })();
  }, [isMounted, scope.proxyRoot]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load();
  }, [load]);

  // ---------------------------------------------------------------------------
  // Running one action
  // ---------------------------------------------------------------------------

  const run = useCallback(
    (chosen: CertificateAction) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('running');
      setLines([]);
      setOutcome(undefined);
      setError(undefined);

      const runCommand = withSignal(controller.signal);
      const live = (): boolean => isMounted() && !controller.signal.aborted;

      void (async () => {
        try {
          if (chosen === 'install-cron') {
            if (scope.app === undefined) {
              throw new Error(
                'The renewal cron is written on behalf of one app (it names its apps root and name), and none could be resolved here.',
              );
            }
            const cron = installRenewalCron({
              name: scope.app.name,
              appsRoot: scope.app.appsRoot,
              kvoxPath: defaultCliPath(),
            });
            append(cron.contents.trimEnd());
            if (!live()) return;
            setOutcome(renewalOutcome({ action: chosen, renewed: [], reloaded: false, cron }));
          } else {
            const result = await renewCertificates({
              proxyRoot: scope.proxyRoot,
              proxyContainer: scope.proxyContainer,
              runCommand,
              dryRun: chosen === 'dry-run',
              hooks: { onProgress: append, onLog: append },
            });
            if (!live()) return;
            setOutcome(
              renewalOutcome({
                action: chosen,
                renewed: result.renewed,
                reloaded: result.reloaded,
              }),
            );
          }
          if (!live()) return;
          setPhase('finished');
        } catch (caught) {
          if (!live()) return;
          setError(formatError(caught));
          setPhase('finished');
        }
      })();
    },
    [append, isMounted, scope],
  );

  // ---------------------------------------------------------------------------
  // Keys
  // ---------------------------------------------------------------------------

  useInput(
    (input, key) => {
      if (key.escape) {
        onDone();
        return;
      }
      if (input.toLowerCase() === 'r') load();
    },
    { isActive: phase === 'menu' },
  );

  useInput(
    (_input, key) => {
      // Esc during a certbot run aborts it AND leaves the screen: unlike a
      // deploy there is nothing half-written to explain — certbot either
      // renewed a lineage or did not.
      if (key.escape) {
        abortRef.current?.abort();
        setPhase('menu');
      }
    },
    { isActive: phase === 'running' },
  );

  useInput(
    (_input, key) => {
      if (key.return || key.escape) {
        setAction(undefined);
        load();
      }
    },
    { isActive: phase === 'finished' },
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const rail = [{ id: 'certs', title: 'Certificates' }];
  const model = certificatesModel({
    entries,
    proxyRoot: scope.proxyRoot,
    ...(renewal === undefined ? {} : { renewal }),
  });
  const actions = certificateActions(model);
  const chosen = actions.find((entry) => entry.key === action);

  if (phase === 'loading') {
    return (
      <WizardFrame title="Certificates" steps={rail} current={0} hints={['esc back']}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Reading the certificates under {scope.proxyRoot}…</Text>
        </Box>
      </WizardFrame>
    );
  }

  if (phase === 'running' || phase === 'finished') {
    const title = certificateActionTitle(action ?? 'renew');
    return (
      <WizardFrame
        title={`Certificates — ${title}`}
        steps={rail}
        current={0}
        hints={
          phase === 'running'
            ? ['esc stop', '↑↓ scroll the output']
            : ['enter back to the list']
        }
      >
        {phase === 'running' ? (
          <Box>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> Running…</Text>
          </Box>
        ) : error !== undefined ? (
          <ErrorNotice message={error} />
        ) : (
          <Text bold color="green">
            {outcome ?? 'Done.'}
          </Text>
        )}
        <Box marginTop={1} flexDirection="column">
          <ScrollBox
            lines={lines}
            reservedRows={18}
            title="certbot"
            busy={phase === 'running'}
            followTail
            isActive
          />
        </Box>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      title="Certificates"
      steps={rail}
      current={0}
      hints={certificatesHints(phase === 'confirming')}
    >
      {error === undefined ? null : (
        <Box marginBottom={1}>
          <ErrorNotice message={error} />
        </Box>
      )}

      <KeyValue rows={model.facts} />

      <Box marginTop={1} flexDirection="column">
        {model.empty ? (
          <Text dimColor>
            {`No certificate under this proxy yet. \`${CLI_NAME} deploy install --domain <domain>\` issues the first one.`}
          </Text>
        ) : (
          <Checklist items={model.certificates} />
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        {phase === 'confirming' && chosen !== undefined ? (
          <ConfirmDialog
            message={chosen.confirm.message}
            detail={chosen.confirm.detail}
            danger={chosen.confirm.danger}
            confirmLabel={chosen.confirm.confirmLabel}
            cancelLabel={chosen.confirm.cancelLabel}
            onResult={(confirmed) => {
              if (confirmed) {
                run(chosen.key);
                return;
              }
              setAction(undefined);
              setPhase('menu');
            }}
          />
        ) : (
          <SelectInput
            items={actions.map((entry) => ({ key: entry.key, label: entry.label, value: entry.key }))}
            onSelect={(item) => {
              setAction(item.value);
              setPhase('confirming');
            }}
          />
        )}
      </Box>
    </WizardFrame>
  );
}

/**
 * Which proxy, and on whose behalf.
 *
 * The same order `resolveCertsScope` uses — the flag, then the app's recorded
 * state, then the defaults — with one difference: an unresolvable app is NOT
 * an error here, because reading expiries never singles one out. Only the cron
 * action needs a name, and it says so when it is chosen.
 */
function resolveScope(appsRoot: string, proxyRoot: string | undefined): Scope {
  let state: DeployState | undefined;
  let app: { name: string; appsRoot: string } | undefined;

  try {
    const layout = locateApp({ appsRoot });
    if (layout !== undefined) {
      state = safeState(layout.deployRoot);
      app = {
        name: state?.name ?? layout.name,
        appsRoot: state?.appsRoot ?? layout.appsRoot,
      };
    }
  } catch {
    /* Several installed and none named: still a host-level question. */
  }

  return {
    proxyRoot: proxyRoot ?? state?.proxyRoot ?? DEFAULT_PROXY_ROOT,
    proxyContainer: state?.proxyContainer ?? DEFAULT_PROXY_CONTAINER,
    ...(app === undefined ? {} : { app }),
  };
}

function safeState(deployRoot: string): DeployState | undefined {
  try {
    return readState(deployRoot);
  } catch {
    return undefined;
  }
}

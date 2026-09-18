import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { DEFAULT_APPS_ROOT, locateInstalledApp } from '../../../deploy/layout.js';
import { runUninstall, type UninstallResult } from '../../../deploy/uninstall.js';
import { formatError } from '../../../errors.js';
import { Checklist, KeyValue, TypedConfirm, WizardFrame } from '../../components/index.js';
import { ErrorNotice, useIsMounted } from '../../layout.js';
import { ScrollBox } from '../../scroll-box.js';
import { withSignal } from './abort.js';
import { MAX_LOG_LINES } from './install-model.js';
import {
  DEFAULT_UNINSTALL_CHOICES,
  bucketFrom,
  confirmSteps,
  databaseFrom,
  equivalentCommand,
  inventoryLines,
  keptRows,
  removedItems,
  uninstallHints,
  uninstallOptionRows,
  uninstallOutcome,
  type ConfirmStep,
  type UninstallChoices,
  type UninstallToggle,
} from './uninstall-model.js';

// =============================================================================
// Uninstall — the seventh destination  (issue #268)
// =============================================================================
//
// #261 deliberately kept `uninstall` OFF this menu, and said exactly why:
// "THE TUI HAS NO TYPED-CONFIRMATION COMPONENT TODAY … adding it there means
// adding that component first, and a y/N dialog standing in for a typed
// confirmation would quietly weaken the guarantee." `components/typed-
// confirm.tsx` is that component, so the reason has been removed rather than
// waived.
//
// FOUR PHASES, AND THE ORDER IS THE SAFETY ARGUMENT:
//
//   1. `options` — the three opt-in extras, all off, destructive rows last.
//   2. `review`  — A REAL `--dry-run` OF `runUninstall`, not a description of
//      one. This is where #268's requirement 2 is met: the object counts, the
//      bytes per prefix, the foreign entries, the database's size and its open
//      sessions all come back from the same code path the real run uses. A
//      screen that hand-wrote an inventory here would be a second description
//      that could drift from what actually happens.
//   3. `confirming` — one `TypedConfirm` per resource, in the order they run,
//      each carrying its own `expected`. A value typed at the bucket step is
//      written to `confirmBucket` and reaches no other field.
//   4. `running` — ONE call to the shared `runUninstall`. There is no second
//      teardown in this file and there must never be.
//
// `nonInteractive: true`, always. readline cannot prompt under ink's raw mode
// (install.tsx's rule), so the confirmations gathered in phase 3 are handed
// over as the values the flags would have carried — which means they go
// through the very same `requireConfirmation` / `requireResourceConfirmation`
// a scripted run does, rather than a second, weaker authorisation path.
//
// THE RUN IS THREADED THROUGH `withSignal`: `compose down -v` and a purge of
// a large bucket both take minutes, and Esc has to reach them rather than
// merely unmount the frame.
// =============================================================================

export interface UninstallScreenProps {
  onDone: () => void;
  appsRoot?: string | undefined;
}

type Phase = 'options' | 'reviewing' | 'review' | 'confirming' | 'running' | 'finished';

interface Site {
  deployRoot: string;
  name: string;
  appsRoot: string;
}

type SiteOrError = Site | { error: string };

const RAIL = [
  { id: 'options', title: 'What goes' },
  { id: 'review', title: 'Review' },
  { id: 'confirm', title: 'Confirm' },
  { id: 'run', title: 'Remove' },
];

function railIndex(phase: Phase): number {
  switch (phase) {
    case 'options':
      return 0;
    case 'reviewing':
    case 'review':
      return 1;
    case 'confirming':
      return 2;
    default:
      return 3;
  }
}

export function UninstallScreen({ onDone, appsRoot }: UninstallScreenProps): ReactNode {
  const isMounted = useIsMounted();
  const root = appsRoot ?? DEFAULT_APPS_ROOT;
  const site = useMemo(() => resolveSite(root), [root]);

  const [phase, setPhase] = useState<Phase>('options');
  const [choices, setChoices] = useState<UninstallChoices>(DEFAULT_UNINSTALL_CHOICES);
  const [preview, setPreview] = useState<UninstallResult | undefined>(undefined);
  const [steps, setSteps] = useState<ConfirmStep[]>([]);
  const [stepAt, setStepAt] = useState(0);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<UninstallResult | undefined>(undefined);
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
  // Phase 2: the real dry run
  // ---------------------------------------------------------------------------

  const review = useCallback(() => {
    if ('error' in site) {
      setError(site.error);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('reviewing');
    setError(undefined);
    setLines([]);

    const live = (): boolean => isMounted() && !controller.signal.aborted;

    void (async () => {
      try {
        // `dryRun: true` writes nothing and starts no subprocess that changes
        // state — #261 proves that with a recursive snapshot. It is therefore
        // safe to run before the operator has confirmed anything, which is
        // exactly what makes it usable as the inventory.
        const found = await runUninstall({
          appsRoot: site.appsRoot,
          name: site.name,
          dryRun: true,
          nonInteractive: true,
          runCommand: withSignal(controller.signal),
          ...(choices.certs ? { certs: true } : {}),
          ...(choices.dropDatabase ? { dropDatabase: true } : {}),
          ...(choices.purgeStorage ? { purgeStorage: true } : {}),
          hooks: { onProgress: append, onLog: append },
        });
        if (!live()) return;
        setPreview(found);
        setSteps(
          confirmSteps({
            name: site.name,
            deployRoot: site.deployRoot,
            choices,
            ...(bucketFrom(found) === undefined ? {} : { bucket: bucketFrom(found) }),
            ...(found.storage?.inventory === undefined
              ? {}
              : { bucketDetail: inventoryLines(found).slice(0, 12) }),
            ...(databaseFrom(found) === undefined ? {} : { database: databaseFrom(found) }),
            ...(found.database?.facts === undefined
              ? {}
              : { databaseDetail: [`It is ${found.database.facts.size ?? 'of unknown size'}.`] }),
          }),
        );
        setStepAt(0);
        setTyped({});
        setPhase('review');
      } catch (caught) {
        if (!live()) return;
        setError(formatError(caught));
        setPhase('options');
      }
    })();
  }, [append, choices, isMounted, site]);

  // ---------------------------------------------------------------------------
  // Phase 4: the one real run
  // ---------------------------------------------------------------------------

  const remove = useCallback(
    (answers: Record<string, string>) => {
      if ('error' in site) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase('running');
      setLines([]);
      setError(undefined);

      const live = (): boolean => isMounted() && !controller.signal.aborted;

      void (async () => {
        try {
          const done = await runUninstall({
            appsRoot: site.appsRoot,
            name: site.name,
            // The SAME guard a scripted run passes through. See the header.
            nonInteractive: true,
            confirmation: answers['app'] ?? '',
            runCommand: withSignal(controller.signal),
            ...(choices.certs ? { certs: true } : {}),
            ...(choices.purgeStorage
              ? { purgeStorage: true, confirmBucket: answers['bucket'] ?? '' }
              : {}),
            ...(choices.dropDatabase
              ? { dropDatabase: true, confirmDatabase: answers['database'] ?? '' }
              : {}),
            hooks: {
              onStepStart: ({ title, index, total }) => append(`[${index + 1}/${total}] ${title}`),
              onProgress: append,
              onLog: append,
            },
          });
          if (!live()) return;
          setResult(done);
          setPhase('finished');
        } catch (caught) {
          if (!live()) return;
          setError(formatError(caught));
          setPhase('finished');
        }
      })();
    },
    [append, choices, isMounted, site],
  );

  // ---------------------------------------------------------------------------
  // Keys. Esc belongs to the screen at every phase; `TypedConfirm` binds none.
  // ---------------------------------------------------------------------------

  useInput(
    (input, key) => {
      if (key.escape) {
        if (phase === 'confirming' || phase === 'review') {
          // Back to the option list rather than out: an operator who has just
          // read the inventory and changed their mind about one toggle should
          // not have to walk in from the menu again.
          setPhase('options');
          return;
        }
        abortRef.current?.abort();
        onDone();
        return;
      }
      if (phase === 'options' && input.toLowerCase() === 'r') review();
    },
    // The option list and the confirm field own Enter and the arrows at their
    // own phases; this handler only ever reads Esc and `r`.
    { isActive: true },
  );

  const hints = uninstallHints(
    phase === 'reviewing' || phase === 'running'
      ? 'running'
      : phase === 'confirming'
        ? 'confirming'
        : phase === 'finished'
          ? 'finished'
          : 'options',
  );

  const frame = (children: ReactNode): ReactNode => (
    <WizardFrame title="Uninstall" steps={RAIL} current={railIndex(phase)} hints={hints}>
      {children}
    </WizardFrame>
  );

  if ('error' in site) {
    return frame(
      <ErrorNotice
        message={site.error}
        hint={`Nothing is installed under ${root}, so there is nothing to remove.`}
      />,
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 1
  // ---------------------------------------------------------------------------

  if (phase === 'options') {
    const rows = uninstallOptionRows(choices);
    return frame(
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{`Remove ${site.name} from this server`}</Text>
          <Text dimColor>{site.deployRoot}</Text>
        </Box>

        {error === undefined ? null : <ErrorNotice message={error} />}

        <Box flexDirection="column">
          <Text dimColor>
            Everything below is OFF. Toggle with Enter, then press r to see exactly what goes.
          </Text>
          <SelectInput
            items={rows.map((row) => ({
              key: row.key,
              label: `[${row.enabled ? 'x' : ' '}] ${row.label}`,
              value: row.key,
            }))}
            onSelect={(item) => {
              const toggle = item.value as UninstallToggle;
              setChoices((current) => ({ ...current, [toggle]: !current[toggle] }));
            }}
          />
        </Box>

        <Box flexDirection="column">
          {rows.map((row) => (
            row.enabled ? (
              <Text key={row.key} color="yellow">
                {`${row.label}: ${row.note}`}
              </Text>
            ) : (
              <Text key={row.key} dimColor>
                {`${row.label}: ${row.note}`}
              </Text>
            )
          ))}
        </Box>

        <Text dimColor>{equivalentCommand(site.name, choices)}</Text>
      </Box>,
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 2, while it runs
  // ---------------------------------------------------------------------------

  if (phase === 'reviewing') {
    return frame(
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> Reading what is here. Nothing is being changed…</Text>
        </Box>
        <ScrollBox lines={lines} />
      </Box>,
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 2, the inventory
  // ---------------------------------------------------------------------------

  if (phase === 'review' && preview !== undefined) {
    const extras = inventoryLines(preview);
    return frame(
      <Box flexDirection="column" gap={1}>
        <Text bold>This is what would be removed. Nothing has changed yet.</Text>

        <ScrollBox
          lines={[
            ...preview.removed.map((item) => `  ${item.target}${item.existed ? '' : '   (already gone)'}`),
            ...(extras.length === 0 ? [] : ['', ...extras]),
            'NOT removed:',
            ...preview.kept.map((item) => `  ${item.target} — ${item.reason}`),
          ]}
        />

        {preview.warnings.length === 0 ? null : (
          <Box flexDirection="column">
            <Text bold color="yellow">
              Action required:
            </Text>
            {preview.warnings.map((warning, index) => (
              <Text key={`${index}:${warning.slice(0, 16)}`} color="yellow">
                {warning}
              </Text>
            ))}
          </Box>
        )}

        <SelectInput
          items={[
            { key: 'back', label: 'No, go back', value: false },
            {
              key: 'go',
              label: `Yes — type ${steps.length} name(s) to authorise it`,
              value: true,
            },
          ]}
          initialIndex={0}
          onSelect={(item) => {
            if (item.value) setPhase('confirming');
            else setPhase('options');
          }}
        />
      </Box>,
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 3: one typed name per resource
  // ---------------------------------------------------------------------------

  if (phase === 'confirming') {
    const step = steps[stepAt];
    if (step === undefined) return frame(<Text>Nothing left to confirm.</Text>);

    return frame(
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{`Confirmation ${stepAt + 1} of ${steps.length}`}</Text>
        <TypedConfirm
          message={step.message}
          detail={step.detail}
          expected={step.expected}
          noun={step.noun}
          onResult={(outcome) => {
            if (outcome === 'cancelled') {
              setPhase('options');
              return;
            }
            const answers = { ...typed, [step.key]: step.expected };
            setTyped(answers);
            if (stepAt + 1 < steps.length) {
              setStepAt(stepAt + 1);
              return;
            }
            remove(answers);
          }}
        />
      </Box>,
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 4
  // ---------------------------------------------------------------------------

  if (phase === 'running') {
    return frame(
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text>{` Removing ${site.name}…`}</Text>
        </Box>
        <ScrollBox lines={lines} />
      </Box>,
    );
  }

  if (error !== undefined) {
    return frame(
      <Box flexDirection="column" gap={1}>
        <ErrorNotice
          message={error}
          hint={`Re-run to continue; every step reports what was already gone. (\`${CLI_NAME} deploy uninstall\`)`}
        />
        <ScrollBox lines={lines} />
      </Box>,
    );
  }

  if (result === undefined) return frame(<Text>Nothing to show.</Text>);

  return frame(
    <Box flexDirection="column" gap={1}>
      <Text bold color="green">
        {uninstallOutcome(result)}
      </Text>

      {result.warnings.length === 0 ? null : (
        <Box flexDirection="column">
          <Text bold color="yellow">
            Action required:
          </Text>
          {result.warnings.map((warning, index) => (
            <Text key={`${index}:${warning.slice(0, 16)}`} color="yellow">
              {warning}
            </Text>
          ))}
        </Box>
      )}

      <Checklist items={removedItems(result)} />

      <Box flexDirection="column">
        <Text bold>NOT removed</Text>
        <KeyValue rows={keptRows(result)} />
      </Box>

      {result.envBackupPath === undefined ? null : (
        <Text dimColor>{`.env backed up to ${result.envBackupPath}`}</Text>
      )}
    </Box>,
  );
}

/** The one installed app, or why there is not exactly one. */
function resolveSite(appsRoot: string): SiteOrError {
  try {
    const layout = locateInstalledApp({ appsRoot });
    return { deployRoot: layout.deployRoot, name: layout.name, appsRoot: layout.appsRoot };
  } catch (caught) {
    return { error: formatError(caught) };
  }
}

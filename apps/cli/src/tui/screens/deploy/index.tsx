import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { useMemo, useState, type ReactNode } from 'react';

import { CLI_NAME } from '../../../branding.js';
import { describeConfig } from '../../../config.js';
import { DEFAULT_APPS_ROOT, listInstalledApps } from '../../../deploy/layout.js';
import { Frame } from '../../layout.js';
import { CertificatesScreen } from './certificates.js';
import { DoctorScreen } from './doctor.js';
import { InstallWizard } from './install.js';
import { StatusScreen } from './status.js';
import { UpdateScreen } from './update.js';

// =============================================================================
// The deploy screen  (issue #131, epic #118; replacing #184's single screen)
// =============================================================================
//
// ONE ROUTE, SEVERAL PHASES. `routes.ts` is closed and has no history stack
// (see its header), so an action per route would return to the TOP menu rather
// than back here — choosing a second action would mean walking in from the
// start every time. The install wizard's own eleven steps are a second level
// of the same idea, kept inside `install.tsx` through `useWizard`.
//
// ROWS ARE ANNOTATED, NEVER HIDDEN. That is the menu's convention
// (screens/menu.tsx): a greyed "(already installed)" answers the question on
// the spot, whereas an entry that appears and disappears teaches nothing.
// Selecting an annotated row still navigates — the destination produces the
// real, specific message.
// =============================================================================

export interface DeployScreenProps {
  onDone: () => void;
}

export type Phase = 'choose' | 'install' | 'update' | 'doctor' | 'status' | 'certs' | 'about';

export interface DeployMenuState {
  /** At least one app is installed under the apps root. */
  installed: boolean;
  /** A credential is stored, so the About card's API block can be read. */
  loggedIn: boolean;
}

export interface DeployMenuItem {
  key: string;
  label: string;
  value: Exclude<Phase, 'choose'>;
}

/**
 * The menu rows for a given state — the pure half of this screen, so the
 * annotations are asserted as data rather than by rendering a frame
 * (`tui/screens/*.test.ts`'s rule: `ink-testing-library` is not a dependency).
 */
export function deployMenuItems(state: DeployMenuState): DeployMenuItem[] {
  return [
    { key: 'doctor', label: 'Doctor  (check prerequisites)', value: 'doctor' },
    {
      key: 'install',
      label: state.installed ? 'Install  (already installed)' : 'Install',
      value: 'install',
    },
    {
      key: 'update',
      label: state.installed ? 'Update' : 'Update  (nothing installed here)',
      value: 'update',
    },
    { key: 'status', label: state.installed ? 'Status' : 'Status  (nothing installed here)', value: 'status' },
    {
      key: 'certs',
      label: state.installed ? 'Certificates' : 'Certificates  (nothing installed here)',
      value: 'certs',
    },
    {
      key: 'about',
      // About reads the deployment's own `/api/admin/about` as well as the
      // local deploy-info file, so it needs a credential — and says so here
      // rather than failing with a 401 two screens later.
      label: state.loggedIn ? 'About  (what is deployed here)' : 'About  (not logged in)',
      value: 'about',
    },
  ];
}

/** What a phase that is not built yet tells the operator to run instead. */
export const PLACEHOLDER_COMMANDS: Readonly<Record<string, string>> = {
  about: 'api GET /api/admin/about',
};

export function DeployScreen({ onDone }: DeployScreenProps): ReactNode {
  const [phase, setPhase] = useState<Phase>('choose');

  // Read ONCE per mount: both hit the filesystem and the menu re-renders on
  // every arrow keypress (screens/menu.tsx's reasoning).
  const state = useMemo<DeployMenuState>(
    () => ({ installed: safeInstalled(), loggedIn: safeLoggedIn() }),
    [],
  );

  // Esc means one thing everywhere (routes.ts): back. From a placeholder that
  // is this menu; from the menu itself it is the TUI's own menu, because this
  // screen is where the route ends.
  useInput(
    (_input, key) => {
      if (!key.escape) return;
      if (phase === 'choose') onDone();
      else setPhase('choose');
    },
    // The menu itself, plus any phase still rendered as a placeholder here.
    // A phase with a real screen owns its own Esc, and two handlers for one
    // key is exactly what `app.tsx`'s conditional mounting exists to avoid.
    { isActive: phase === 'choose' || PLACEHOLDER_COMMANDS[phase] !== undefined },
  );

  if (phase === 'doctor') {
    return (
      <DoctorScreen
        onDone={() => {
          setPhase('choose');
        }}
      />
    );
  }

  if (phase === 'update') {
    return (
      <UpdateScreen
        onDone={() => {
          setPhase('choose');
        }}
      />
    );
  }

  if (phase === 'status') {
    return (
      <StatusScreen
        onDone={() => {
          setPhase('choose');
        }}
      />
    );
  }

  if (phase === 'certs') {
    return (
      <CertificatesScreen
        onDone={() => {
          setPhase('choose');
        }}
      />
    );
  }

  if (phase === 'install') {
    return (
      <InstallWizard
        onDone={() => {
          setPhase('choose');
        }}
      />
    );
  }

  if (phase !== 'choose') {
    const command = PLACEHOLDER_COMMANDS[phase] ?? '';
    return (
      <Frame title={`Deploy — ${phase}`} hints={['esc back']}>
        <Text>This screen is not part of the wizard yet.</Text>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>The same work runs today as</Text>
          <Text bold>{`  ${CLI_NAME} ${command}`}</Text>
        </Box>
      </Frame>
    );
  }

  return (
    <Frame title="Deploy" hints={['enter select', 'esc back']}>
      <Text dimColor>Acting on {DEFAULT_APPS_ROOT}</Text>
      <Box marginTop={1}>
        <SelectInput
          items={deployMenuItems(state)}
          onSelect={(item) => {
            setPhase(item.value);
          }}
        />
      </Box>
    </Frame>
  );
}

function safeInstalled(): boolean {
  try {
    return listInstalledApps(DEFAULT_APPS_ROOT).length > 0;
  } catch {
    return false;
  }
}

function safeLoggedIn(): boolean {
  try {
    return describeConfig().tokenSource !== undefined;
  } catch {
    return false;
  }
}

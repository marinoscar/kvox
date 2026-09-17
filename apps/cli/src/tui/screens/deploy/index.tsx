import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { useMemo, useState, type ReactNode } from 'react';

import { describeConfig } from '../../../config.js';
import { DEFAULT_APPS_ROOT, listInstalledApps } from '../../../deploy/layout.js';
import { Frame } from '../../layout.js';
import { AboutScreen } from './about.js';
import { CertificatesScreen } from './certificates.js';
import { DoctorScreen } from './doctor.js';
import { InstallWizard } from './install.js';
import { StatusScreen } from './status.js';
import { UninstallScreen } from './uninstall.js';
import { UpdateScreen } from './update.js';

// =============================================================================
// The deploy screen  (issue #131, epic #118; replacing #184's single screen)
// =============================================================================
//
// SEVEN DESTINATIONS, ONE ROUTE (#132 completed the first six: Doctor,
// Install, Update, Status, Certificates, About are all real screens — no phase
// falls through to a frame naming the subcommand instead of doing the work.
// #268 adds Uninstall as the seventh).
//
// UNINSTALL IS LAST, AND NOT BY ACCIDENT. It is the one destination that
// destroys rather than builds, and `confirm-dialog.tsx`'s argument applies to
// a menu as much as to two choices: the row somebody lands on first should not
// be the one that removes a deployment. It also arrives only now because #261
// refused to put it here until a TYPED-confirmation component existed — a y/N
// dialog standing in for a typed resource name weakens the guarantee while
// looking like it satisfies it. `components/typed-confirm.tsx` is that
// component, so the objection is answered rather than waived.
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

export type Phase =
  | 'choose'
  | 'install'
  | 'update'
  | 'doctor'
  | 'status'
  | 'certs'
  | 'about'
  | 'uninstall';

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
    {
      key: 'uninstall',
      // Annotated, never hidden — the menu's own convention, and here it has
      // a second job: an operator scanning for "how do I get rid of this?"
      // learns from the annotation that nothing is installed under this apps
      // root, which is a different answer from the row simply not existing.
      label: state.installed
        ? 'Uninstall  (remove this deployment)'
        : 'Uninstall  (nothing installed here)',
      value: 'uninstall',
    },
  ];
}

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
      if (key.escape) onDone();
    },
    // THE MENU ONLY. Every phase below is a screen that binds its own Esc and
    // returns here through `onDone`; a second handler mounted over it would
    // fire on the same keystroke, which is exactly what `app.tsx`'s
    // conditional mounting exists to prevent.
    { isActive: phase === 'choose' },
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

  if (phase === 'about') {
    return (
      <AboutScreen
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

  if (phase === 'uninstall') {
    return (
      <UninstallScreen
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

// =============================================================================
// The first-run journey of Home, as data
// =============================================================================
//
// What a person with nothing yet is invited to do. A host does not write a
// second Home for its first run: it hands the packaged page the steps that only
// it can offer (`extraSteps`: KVox web's "Record or upload audio", KVox Desktop's
// "Import a document") and, if it must, replaces the ones the slices ship
// (`journeySteps`). Which steps a viewer sees is decided here, from the same two
// answers the rest of the app gates on: the permission strings the API enforces
// and the deployment's `graph` switch.
//
// No React component and no MUI here: a host with another design system draws
// the steps itself from {@link resolveJourneySteps}.
// =============================================================================

import type { ReactNode } from 'react';

/**
 * The call to action of a {@link KvoxJourneyStep}.
 *
 * @remarks
 * Give it `to` (an in-app path, drawn as a link) or `onClick` (drawn as a
 * button). A step whose action has neither is drawn without a control.
 *
 * @stability experimental
 */
export interface KvoxJourneyStepAction {
  /** The button's text. */
  label: string;
  /** An in-app path the router serves. */
  to?: string;
  /** Called on click, for a host that opens a native dialog or navigates itself. */
  onClick?: () => void;
  /** Draws the control disabled (a capability the deployment does not have). */
  disabled?: boolean;
  /** An icon drawn before the label. */
  icon?: ReactNode;
  /**
   * The id of an element in {@link KvoxJourneyStep.body} that explains why the
   * control is disabled, wired as `aria-describedby`.
   */
  describedBy?: string;
}

/**
 * One thing the journey invites a person to do.
 *
 * @stability experimental
 */
export interface KvoxJourneyStep {
  /** A stable key, unique within the page. */
  key: string;
  /** The step's name. It labels the step for assistive technology. */
  title: string;
  /**
   * What the step says under its control: a sentence, or the reason the action is
   * unavailable together with a link to fix it.
   */
  body: ReactNode;
  /** The person has already done this. A done step draws no control. */
  done: boolean;
  /** The control that starts the step. */
  action: KvoxJourneyStepAction;
  /**
   * The exact permission string the API enforces for the step's action. The step is
   * not drawn for a viewer who does not hold it.
   */
  permission?: string;
  /**
   * The deployment switch the step needs. `'graph'` is connected knowledge: the step
   * is not drawn while the host's `features().graphEnabled` is not `true`.
   */
  feature?: 'graph';
}

/**
 * What decides whether a step is drawn.
 *
 * @stability experimental
 */
export interface KvoxJourneyContext {
  /** Whether the viewer holds a permission. */
  hasPermission: (permission: string) => boolean;
  /** Whether connected knowledge is on. */
  graphEnabled: boolean;
}

/**
 * What the default steps need to know about the person's progress.
 *
 * @stability experimental
 */
export interface KvoxJourneyProgress {
  /** How many notes the person has. */
  notes: number;
}

/**
 * The steps the slices ship: write a note, and look at the knowledge the notes
 * build.
 *
 * @remarks
 * Only steps that belong to a slice the host mounts survive the permission and
 * feature filter, so a host without connected knowledge never sees the second one.
 * The paths are the ones `kvoxNotesRoutes` and `kvoxGraphRoutes` serve.
 *
 * @param progress - what the person has done so far.
 * @returns the default steps, unfiltered.
 *
 * @stability experimental
 */
export function defaultJourneySteps(progress: KvoxJourneyProgress): KvoxJourneyStep[] {
  return [
    {
      key: 'write-note',
      title: 'Write a note',
      body: 'Capture a decision, a meeting or an idea while it is fresh.',
      done: progress.notes > 0,
      action: { label: 'New note', to: '/notes/new' },
      permission: 'notes:write',
    },
    {
      key: 'explore-knowledge',
      title: 'Explore your knowledge',
      body: 'See the people and organizations your notes mention, and how they connect.',
      done: false,
      action: { label: 'Open knowledge', to: '/graph' },
      permission: 'graph:read',
      feature: 'graph',
    },
  ];
}

/**
 * Whether a step is drawn for a viewer.
 *
 * @param step - the step.
 * @param context - the viewer's permissions and the deployment switch.
 * @returns `false` when the step needs a permission the viewer lacks or a feature that is off.
 *
 * @stability experimental
 */
export function isJourneyStepVisible(step: KvoxJourneyStep, context: KvoxJourneyContext): boolean {
  if (step.permission !== undefined && !context.hasPermission(step.permission)) return false;
  if (step.feature === 'graph' && !context.graphEnabled) return false;
  return true;
}

/**
 * Options of {@link resolveJourneySteps}.
 *
 * @stability experimental
 */
export interface ResolveJourneyStepsOptions {
  /** Replaces the steps the slices ship. Default: {@link defaultJourneySteps}. */
  journeySteps?: readonly KvoxJourneyStep[];
  /** The host's own steps, drawn after the others in the order given. */
  extraSteps?: readonly KvoxJourneyStep[];
  /** What the default steps need. */
  progress: KvoxJourneyProgress;
  /** What decides visibility. */
  context: KvoxJourneyContext;
}

/**
 * The steps to draw: the slices' (or the host's replacement), then the host's
 * extras, minus the ones the viewer's permissions or the deployment hide.
 *
 * @param options - see {@link ResolveJourneyStepsOptions}.
 * @returns the visible steps, in order.
 *
 * @stability experimental
 */
export function resolveJourneySteps(options: ResolveJourneyStepsOptions): KvoxJourneyStep[] {
  const base = options.journeySteps ?? defaultJourneySteps(options.progress);
  return [...base, ...(options.extraSteps ?? [])].filter((step) =>
    isJourneyStepVisible(step, options.context),
  );
}

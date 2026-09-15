import {
  ALL_CHECKS,
  summarise,
  type Check,
  type CheckSummary,
  type CompletedCheck,
} from '../../../deploy/checks/index.js';
import { DOMAIN_FIELD, validateDomain } from '../../../deploy/wizard/steps.js';
import type { ChecklistItem, FormFieldSpec } from '../../components/index.js';
import { checkItems } from './install-model.js';

// =============================================================================
// The doctor screen, as data  (issue #132, epic #118)
// =============================================================================
//
// Pure, with no React and no ink import, for the reason every
// `tui/screens/*.test.ts` in this package states: `ink-testing-library` is not
// a dependency, so a screen is tested through the DATA it derives.
//
// THIS SCREEN RUNS THE WHOLE REGISTRY, NOT THE REQUIRED SUBSET. The install
// wizard's Welcome step runs `welcomeChecks()` because it is a gate — it has
// to decide whether the install may proceed, and a recommendation must not
// block one. Doctor is not a gate; it is the answer to "is this server
// ready?", and the recommendations are most of what an operator acts on
// (`checks/types.ts` rule 3: both are shown, only `required` decides the exit
// code — which in the TUI is always 0, so the summary line has to carry the
// verdict on its own).
//
// THE SUMMARY IS A SENTENCE, NOT A TABLE. `12 passed · 2 warnings · 1 failed`
// is the one line an operator reads before deciding whether to read the list,
// so a zero is omitted rather than printed: "0 failed" invites a scan for the
// failure that is not there.
// =============================================================================

/** Every check in the registry, in registry order. */
export function doctorChecks(checks: readonly Check[] = ALL_CHECKS): Check[] {
  return [...checks];
}

export interface DoctorSummary extends CheckSummary {
  /** `12 passed · 2 warnings · 1 failed`; zero counts omitted. */
  headline: string;
  /** No REQUIRED check failed — the subcommand's exit-code rule. */
  ok: boolean;
  /** Something failed or warned: the frame says so in colour. */
  attention: boolean;
  total: number;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The header line over the checklist.
 *
 * `ok` follows `checksPassed`'s rule rather than "nothing failed": a failed
 * RECOMMENDED check is advice, and a doctor that declared the server broken
 * over advice is how people learn to stop reading it.
 */
export function doctorSummary(results: readonly CompletedCheck[]): DoctorSummary {
  const counts = summarise(results);
  const parts = [plural(counts.passed, 'passed', 'passed')];
  if (counts.warned > 0) parts.push(plural(counts.warned, 'warning', 'warnings'));
  if (counts.failed > 0) parts.push(plural(counts.failed, 'failed', 'failed'));
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);

  const requiredFailed = results.some(
    (result) => result.severity === 'required' && result.status === 'fail',
  );

  return {
    ...counts,
    total: results.length,
    headline: parts.join(' · '),
    ok: !requiredFailed,
    attention: counts.failed > 0 || counts.warned > 0,
  };
}

/** `Running… 4 of 17` while the run is in flight. */
export function doctorProgress(done: number, total: number): string {
  return `Running… ${done} of ${total}`;
}

/** The checklist, every check listed from the first frame. Reuses #131's builder. */
export function doctorItems(
  checks: readonly Check[],
  results: readonly CompletedCheck[],
  running: boolean,
): ChecklistItem[] {
  return checkItems(checks, results, running);
}

// -----------------------------------------------------------------------------
// The two things this screen can be told
// -----------------------------------------------------------------------------

export interface DoctorOptions {
  /** The hostname the DNS and TLS checks are asked about; '' means none. */
  domain: string;
  /** `--skip-proxy`: the proxy, certificate, port and DNS checks report `skip`. */
  skipProxy: boolean;
  /** Whether the domain field is on screen and owns the keyboard. */
  editingDomain: boolean;
}

export const DOCTOR_DEFAULTS: DoctorOptions = {
  domain: '',
  skipProxy: false,
  editingDomain: false,
};

/**
 * The domain field, when it is open.
 *
 * It is the SAME field the install wizard asks (`deploy/wizard/steps.ts`), so
 * it validates identically — epic #118 decision 10: a TUI-only question is
 * one that drifts from `--non-interactive` the first time somebody edits one
 * and not the other.
 */
export function doctorFields(options: DoctorOptions): FormFieldSpec[] {
  if (!options.editingDomain) return [];
  return [
    {
      kind: 'text',
      key: DOMAIN_FIELD,
      label: 'Domain',
      help: 'The public hostname. Blank runs without the DNS and TLS checks.',
      placeholder: 'app.example.com',
      validate: (value) => (value === '' ? undefined : validateDomain(value)),
    },
  ];
}

/**
 * The key hints, which must match what is actually bound.
 *
 * CONTROL KEYS, NOT BARE LETTERS, and for #131's reason stated in its header:
 * ink delivers every keystroke to every mounted handler, so a bare `d` would
 * open the domain editor in the middle of typing a domain containing one. A
 * modifier is the only binding that can coexist with a focused text field, and
 * this screen has one.
 */
export function doctorHints(options: DoctorOptions, running: boolean): string[] {
  if (options.editingDomain) return ['enter apply', 'esc cancel'];
  return [
    running ? 'running…' : 'ctrl-r re-run',
    'ctrl-d domain',
    options.skipProxy ? 'ctrl-p include the proxy' : 'ctrl-p skip the proxy',
    'esc back',
  ];
}

/** The line under the title: what this run was asked about. */
export function doctorScope(options: DoctorOptions): string {
  const domain = options.domain === '' ? 'no domain (DNS and TLS checks skipped)' : options.domain;
  return options.skipProxy ? `${domain} · --skip-proxy` : domain;
}

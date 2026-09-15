import { describe, expect, it } from 'vitest';

import { ALL_CHECKS, type CompletedCheck } from '../../../deploy/checks/index.js';
import { DOMAIN_FIELD } from '../../../deploy/wizard/steps.js';
import {
  DOCTOR_DEFAULTS,
  doctorChecks,
  doctorFields,
  doctorHints,
  doctorItems,
  doctorProgress,
  doctorScope,
  doctorSummary,
} from './doctor-model.js';

// =============================================================================
// The doctor screen  (issue #132, epic #118)
// =============================================================================
//
// `ink-testing-library` is not a dependency of this package (see
// status.test.ts for why one was not added), so the screen is asserted through
// the data it derives — which is where everything this issue is about lives:
// that the whole registry is run rather than the required subset, that the
// summary omits zeroes, that a failed RECOMMENDATION is not a broken server,
// and that the keys the hint line advertises are the modified ones a screen
// with a text field is allowed to bind.
// =============================================================================

function result(
  id: string,
  status: CompletedCheck['status'],
  severity: CompletedCheck['severity'] = 'required',
): CompletedCheck {
  return { id, title: id, status, severity, detail: 'detail', durationMs: 1 };
}

describe('doctorChecks', () => {
  it('runs the whole registry, recommendations included', () => {
    const checks = doctorChecks();

    expect(checks.map((check) => check.id)).toEqual(ALL_CHECKS.map((check) => check.id));
    expect(checks.some((check) => check.severity === 'recommended')).toBe(true);
  });
});

describe('doctorSummary', () => {
  it('reads as the sentence the issue asks for', () => {
    const results = [
      ...Array.from({ length: 12 }, (_, index) => result(`pass-${index}`, 'pass')),
      result('warn-1', 'warn', 'recommended'),
      result('warn-2', 'warn', 'recommended'),
      result('fail-1', 'fail'),
    ];

    expect(doctorSummary(results).headline).toBe('12 passed · 2 warnings · 1 failed');
  });

  it('omits the counts that are zero rather than printing "0 failed"', () => {
    const summary = doctorSummary([result('a', 'pass'), result('b', 'pass')]);

    expect(summary.headline).toBe('2 passed');
    expect(summary.attention).toBe(false);
    expect(summary.ok).toBe(true);
  });

  it('says "1 warning", not "1 warnings"', () => {
    expect(doctorSummary([result('a', 'warn', 'recommended')]).headline).toBe(
      '0 passed · 1 warning',
    );
  });

  it('counts skips, so a wall of them explains itself', () => {
    expect(doctorSummary([result('a', 'pass'), result('b', 'skip')]).headline).toBe(
      '1 passed · 1 skipped',
    );
  });

  it('does not call the server broken over a failed RECOMMENDATION', () => {
    const summary = doctorSummary([result('advice', 'fail', 'recommended')]);

    // The rule `checksPassed` states: only a required failure is a verdict.
    expect(summary.ok).toBe(true);
    // It is still worth looking at.
    expect(summary.attention).toBe(true);
  });

  it('calls the server not ready when a REQUIRED check failed', () => {
    expect(doctorSummary([result('docker-installed', 'fail')]).ok).toBe(false);
  });
});

describe('doctorItems', () => {
  it('lists every check from the first frame, the first unfinished one running', () => {
    const checks = doctorChecks().slice(0, 3);
    const items = doctorItems(checks, [result(checks[0]?.id ?? '', 'pass')], true);

    expect(items).toHaveLength(3);
    expect(items[0]?.status).toBe('pass');
    expect(items[1]?.status).toBe('running');
    expect(items[2]?.status).toBe('pending');
  });

  it('carries the remedy through, so it can be shown under the failure', () => {
    const checks = doctorChecks().slice(0, 1);
    const id = checks[0]?.id ?? '';
    const items = doctorItems(
      checks,
      [{ ...result(id, 'fail'), remedy: 'apt-get install docker.io' }],
      false,
    );

    expect(items[0]?.remedy).toBe('apt-get install docker.io');
  });
});

describe('the two knobs', () => {
  it('shows no field until the domain editor is opened', () => {
    expect(doctorFields(DOCTOR_DEFAULTS)).toEqual([]);
    expect(doctorFields({ ...DOCTOR_DEFAULTS, editingDomain: true })).toHaveLength(1);
  });

  it('asks the domain with the install wizard\'s own field key and validation', () => {
    const [field] = doctorFields({ ...DOCTOR_DEFAULTS, editingDomain: true });

    expect(field?.key).toBe(DOMAIN_FIELD);
    expect(field?.kind).toBe('text');
    if (field?.kind !== 'text') throw new Error('expected a text field');
    // Blank is allowed here (it means "no domain"), a malformed one is not.
    expect(field.validate?.('')).toBeUndefined();
    expect(field.validate?.('app.example.com')).toBeUndefined();
    expect(field.validate?.('https://app.example.com/x')).toBeDefined();
  });

  it('says in the scope line when there is no domain to ask DNS about', () => {
    expect(doctorScope(DOCTOR_DEFAULTS)).toContain('no domain');
    expect(doctorScope({ ...DOCTOR_DEFAULTS, domain: 'app.example.com' })).toBe('app.example.com');
    expect(doctorScope({ ...DOCTOR_DEFAULTS, domain: 'app.example.com', skipProxy: true })).toBe(
      'app.example.com · --skip-proxy',
    );
  });
});

describe('doctorHints', () => {
  it('binds only MODIFIED keys, because this screen has a text field', () => {
    const hints = doctorHints(DOCTOR_DEFAULTS, false).join(' ');

    expect(hints).toContain('ctrl-r');
    expect(hints).toContain('ctrl-d');
    expect(hints).toContain('ctrl-p');
    // A bare letter would fire from inside the domain editor (#131's header).
    expect(hints).not.toMatch(/(^| )[rdp] /);
  });

  it('offers to put the proxy checks back once they were skipped', () => {
    expect(doctorHints({ ...DOCTOR_DEFAULTS, skipProxy: true }, false).join(' ')).toContain(
      'include the proxy',
    );
  });

  it('hands the keyboard to the field while the domain is being edited', () => {
    expect(doctorHints({ ...DOCTOR_DEFAULTS, editingDomain: true }, false)).toEqual([
      'enter apply',
      'esc cancel',
    ]);
  });

  it('does not offer a re-run while one is in flight', () => {
    expect(doctorHints(DOCTOR_DEFAULTS, true)[0]).toBe('running…');
  });
});

describe('doctorProgress', () => {
  it('counts the run so it does not look hung through a dozen subprocesses', () => {
    expect(doctorProgress(4, 17)).toBe('Running… 4 of 17');
  });
});

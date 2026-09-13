import { APP_SLUG } from '@app/shared';

import { resolveServiceName } from './service-name';

// =============================================================================
// resolveServiceName() (issue #343, epic #341)
// =============================================================================
//
// Both branches, plus the one property that makes this worth testing at all:
// the function reads process.env.OTEL_SERVICE_NAME on EVERY call rather than
// caching it in a module-level constant, specifically so a test that sets the
// variable is not defeated by whichever module happened to import this one
// first (see the function's own doc comment). The final test below proves
// that per-call behaviour directly rather than trusting the comment.
// =============================================================================

describe('resolveServiceName', () => {
  const ORIGINAL = process.env.OTEL_SERVICE_NAME;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.OTEL_SERVICE_NAME;
    } else {
      process.env.OTEL_SERVICE_NAME = ORIGINAL;
    }
  });

  it('returns OTEL_SERVICE_NAME verbatim when set', () => {
    process.env.OTEL_SERVICE_NAME = 'custom-service-name';

    expect(resolveServiceName()).toBe('custom-service-name');
  });

  it('falls back to `${APP_SLUG}-api` when unset', () => {
    delete process.env.OTEL_SERVICE_NAME;

    expect(resolveServiceName()).toBe(`${APP_SLUG}-api`);
  });

  it('falls back to `${APP_SLUG}-api` when set to an empty string', () => {
    process.env.OTEL_SERVICE_NAME = '';

    expect(resolveServiceName()).toBe(`${APP_SLUG}-api`);
  });

  it('resolves per call rather than caching, so a change between calls is observed', () => {
    delete process.env.OTEL_SERVICE_NAME;
    expect(resolveServiceName()).toBe(`${APP_SLUG}-api`);

    process.env.OTEL_SERVICE_NAME = 'second-value';
    expect(resolveServiceName()).toBe('second-value');
  });
});

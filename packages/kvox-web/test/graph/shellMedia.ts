/**
 * Test helper of the Insight Canvas shell suites: answer chosen media queries
 * (`(pointer: coarse)`, `(hover: none)`, `(prefers-reduced-motion: reduce)`)
 * on top of the width-aware `matchMedia` the setup file installs. The setup's
 * `afterEach` reinstalls the plain one, so an override never leaks.
 */

export function mockMedia(answers: Record<string, boolean>): void {
  const original = window.matchMedia.bind(window);
  const normalise = (query: string) => query.replace(/\s+/g, '').toLowerCase();
  const table = new Map(Object.entries(answers).map(([query, value]) => [normalise(query), value]));
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      const answer = table.get(normalise(query));
      if (answer === undefined) return original(query);
      return {
        matches: answer,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

/** A touch phone or tablet: a coarse pointer that cannot hover. */
export function mockTouchInput(): void {
  mockMedia({ '(pointer: coarse)': true, '(hover: none)': true });
}

export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

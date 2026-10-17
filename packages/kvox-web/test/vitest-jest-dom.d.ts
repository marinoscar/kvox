// Testing Library's jest-dom matchers on Vitest 4's `expect`. The package's own
// augmentation targets an interface Vitest no longer exposes under that name.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Matchers<T = any> extends TestingLibraryMatchers<any, T> {}
}

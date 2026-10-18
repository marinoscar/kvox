// The real-data slice's public surface (re-exported by the package root).
export {
  assertOutsideRepo,
  canonicalPath,
  isInside,
  nextRealFixtureId,
  REAL_DATA_REFUSAL,
  RealDataPathError,
  repositoryRoots,
} from './real-data.js';
export type { AssertOutsideRepoOptions } from './real-data.js';

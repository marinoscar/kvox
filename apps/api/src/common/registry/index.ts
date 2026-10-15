// The framework-free registry primitive (issue #459).
//
// `RegistryFreezeService` is deliberately NOT re-exported: this barrel must stay
// importable where no Nest container exists (the seed, scripts, DTOs evaluated
// at module load). Import the service from './registry-freeze.service'. The
// test kit lives in './testing' and is likewise not re-exported.

export {
  DEFAULT_REGISTRY_ID_PATTERN,
  REGISTRY_ID_MAX_LENGTH,
  Registry,
  RegistryError,
  defineRegistry,
  freezeAllRegistries,
  listDefinedRegistries,
} from './define-registry';
export type { RegistryErrorCode, RegistryOptions, RegistrySnapshot } from './define-registry';

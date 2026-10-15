import { createZodDto } from 'nestjs-zod';

import type { TypedObjectSchema } from '../../common/schemas/settings.schema';
import {
  composePatchSystemSettingsSchema,
  composeUpdateSystemSettingsSchema,
  markSystemSettingsRequestBodiesComposed,
  type SystemSettingsNamespaces,
} from '../registry';

// =============================================================================
// System settings request bodies (issue #459)
// =============================================================================
//
// The PUT and PATCH bodies are COMPOSED from the system settings namespace
// registry (`settings/registry/`), not written out here. Each namespace
// declares its own PUT branch, PATCH branch and whether a PUT must carry it
// (`SystemSettingsNamespace.putSchema` / `wirePatchSchema` / `requiredOnPut`),
// beside the module that owns it; `kvox.manifest.ts` registers them.
//
// THIS FILE IS STILL THE TRAP THE PARITY GUARD EXISTS FOR, only moved. The
// global `ZodValidationPipe` parses a body against the schemas below first and
// strips every key they do not declare, so a namespace that reached the stored
// schema but not these would not fail validation — it would be silently
// stripped, the service handed a body with the caller's change already deleted
// and cheerfully writing the unchanged value back. Composing both from one
// registry entry is what closes that; `common/schemas/settings-parity.spec.ts`
// iterates the registry to prove it.
//
// ⚠ COMPOSED AT IMPORT TIME. `createZodDto` needs the schema when this module is
// evaluated, so `apps/api/src/kvox.manifest.ts` must have run first (every entry
// point imports it before anything else; the composers throw if the registry is
// empty). `markSystemSettingsRequestBodiesComposed()` then makes a namespace
// registered later a loud error rather than a silent no-op on every write.
//
// WHY `notifications` IS REQUIRED IN THE PUT BODY AND THE OTHERS ARE NOT
// (`requiredOnPut`). A PUT that omits a modelled block must not silently reset
// it. `notifications` (#225) shipped together with the admin UI that sends it,
// so requiring it broke nothing and caught real omissions: the value it would
// reset is an operator's decision to turn a delivery channel off for everyone.
// The operations, transcription and AI namespaces shipped AHEAD of every
// consumer, so requiring them would have 400ed every PUT from every client that
// existed. `SystemSettingsService.replaceSettings` carries an omitted block
// forward from the stored value instead (derived from this schema's optional
// keys, not from a second list). When a UI for one of them lands and every
// client is sending it, promoting it is a one-field change on its declaration.
// =============================================================================

type SystemNamespaces = SystemSettingsNamespaces;

/**
 * Deep-partial for the PATCH body. Arrays and keyed maps (a type whose every key
 * is already optional, such as `ai.taskModels`) are REPLACED wholesale by a
 * PATCH rather than merged, so they are left whole here.
 */
type PatchOf<T> = T extends readonly unknown[]
  ? T
  : Record<never, never> extends T
    ? T
    : T extends object
      ? { [K in keyof T]?: PatchOf<T[K]> }
      : T;

/**
 * The PUT body: `notifications` required, every other registered namespace
 * optional ("omitted means keep what is stored").
 */
export type UpdateSystemSettingsBody = Pick<SystemNamespaces, 'notifications'> &
  Partial<Omit<SystemNamespaces, 'notifications'>>;

/** The PATCH body: every registered namespace, deep-partial. */
export type PatchSystemSettingsBody = {
  [K in keyof SystemNamespaces]?: PatchOf<SystemNamespaces[K]>;
};

// Full replacement (PUT)
export const updateSystemSettingsSchema =
  composeUpdateSystemSettingsSchema() as unknown as TypedObjectSchema<UpdateSystemSettingsBody>;

// Partial update (PATCH)
export const patchSystemSettingsSchema =
  composePatchSystemSettingsSchema() as unknown as TypedObjectSchema<PatchSystemSettingsBody>;

markSystemSettingsRequestBodiesComposed();

export class UpdateSystemSettingsDto extends createZodDto(
  updateSystemSettingsSchema,
) {}

export class PatchSystemSettingsDto extends createZodDto(
  patchSystemSettingsSchema,
) {}

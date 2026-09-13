import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { systemMaintenanceSchema } from '../../schemas/settings.schema';

// =============================================================================
// Wire bodies for /api/admin/maintenance (#257, epic #254)
// =============================================================================
//
// EVERY FIELD BOUND IS TAKEN FROM `systemMaintenanceSchema`, never restated.
// These endpoints write into the same `maintenance` namespace the system
// settings PUT/PATCH write into, and a hand-copied `.max(1000)` here would be a
// second declaration of the same limit, free to drift from the first — with the
// failure landing on whichever of the two paths was not updated. Only the
// OPTIONALITY differs, which is a property of this request and not of the
// stored value.
//
// `startedAt` and `startedById` are ABSENT from this body on purpose. They are
// provenance, not policy: the service stamps them when it opens a window and
// clears them when it closes one (see `MaintenanceModeService.setMaintenance`).
// Accepting them from a client would let a caller claim a window was opened by
// somebody else, at a time it was not — an audit trail that can be dictated by
// the thing being audited is not one.
// =============================================================================

export const updateMaintenanceSchema = z.object({
  /** The only required field: this endpoint exists to answer on-or-off. */
  enabled: systemMaintenanceSchema.shape.enabled,
  /**
   * Optional: omitting it keeps whatever message is stored, so an operator can
   * re-open a window without retyping the copy they already agreed on.
   */
  message: systemMaintenanceSchema.shape.message.optional(),
  /**
   * Optional, and the field to be careful with. `false` locks administrators
   * out too — a legitimate choice for a window in which no human should touch
   * the application, and the one configuration that needs the environment
   * break-glass to undo. See docs/runbooks/maintenance-mode.md.
   */
  allowAdmins: systemMaintenanceSchema.shape.allowAdmins.optional(),
});

export class UpdateMaintenanceDto extends createZodDto(
  updateMaintenanceSchema,
) {}

/**
 * The response both routes return: the EFFECTIVE state, plus each contributing
 * layer separately.
 *
 * The `layers` block is the reason this is not simply the stored namespace. An
 * operator debugging "I turned it off and it is still on" has to be able to see
 * that `MAINTENANCE_MODE=true` is still in the environment and outranks the row
 * they just wrote; a response that published only the effective answer would
 * make that invisible from the API and send them to the logs, or to a shell on
 * the container, to find out.
 *
 * Restated here rather than derived from `MaintenanceStatus` because this is
 * the OpenAPI-visible contract — the same reason `system-settings-response.dto`
 * restates the settings shape — and `maintenance-controller.spec.ts` parses a
 * real response through this schema so the two cannot drift unnoticed.
 */
export const maintenanceStatusSchema = z.object({
  enabled: z.boolean(),
  message: z.string(),
  allowAdmins: z.boolean(),
  startedAt: z.string().nullable(),
  startedById: z.string().nullable(),
  source: z.enum(['env', 'memory', 'persisted']),
  layers: z.object({
    env: z.object({
      present: z.boolean(),
      enabled: z.boolean().nullable(),
    }),
    memory: z.object({
      present: z.boolean(),
      override: z
        .object({
          enabled: z.boolean(),
          message: z.string().optional(),
          allowAdmins: z.boolean().optional(),
        })
        .nullable(),
    }),
    persisted: z.object({
      readable: z.boolean(),
      value: systemMaintenanceSchema,
    }),
  }),
});

export class MaintenanceStatusDto extends createZodDto(
  maintenanceStatusSchema,
) {}

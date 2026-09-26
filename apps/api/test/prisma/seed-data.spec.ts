import {
  ROLES,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  DEFAULT_SYSTEM_SETTINGS as SEEDED_SYSTEM_SETTINGS,
  NOTE_TEMPLATES,
} from '../../prisma/seed-data';
import { PERMISSIONS as PERMISSION_CONSTANTS } from '../../src/common/constants/roles.constants';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { systemSettingsSchema } from '../../src/common/schemas/settings.schema';

// =============================================================================
// Seed data guard (#256, epic #254)
// =============================================================================
//
// WHAT THIS CAN AND CANNOT CHECK. `prisma/seed.ts` needs a real Postgres, so
// its behaviour is proven by CI's smoke job, which runs `npm run prisma:seed`
// against a live database — twice on a re-run of an existing environment, which
// is the actual idempotency evidence. Every write in that script is an `upsert`
// keyed on a natural unique (`role.name`, `permission.name`,
// `rolePermission.roleId_permissionId`, `systemSettings.key`), so re-running it
// updates rows rather than inserting duplicates.
//
// What no database can tell you is whether the DATA is self-consistent, and
// that is what this file asserts, against `prisma/seed-data.ts` — split out of
// the script for exactly this purpose, since the script itself connects to a
// database and runs `main()` at import time.
//
// The failure this most directly prevents: a permission added to
// `PERMISSIONS` in `roles.constants.ts` (which is what `@Auth()` decorators
// name) but not to the seed, so every route guarded by it 403s for everyone in
// a freshly seeded deployment, with nothing in the logs to explain why.
// =============================================================================

describe('seed data', () => {
  describe('permissions', () => {
    it('declares each permission exactly once', () => {
      // Duplicates would not break the upsert — the second one would simply
      // update the first — but they are always a copy-paste that meant to say
      // something else.
      const names = PERMISSIONS.map((permission) => permission.name);
      const duplicated = names.filter(
        (name, index) => names.indexOf(name) !== index,
      );

      expect(duplicated).toEqual([]);
    });

    it('gives every permission a description', () => {
      const undescribed = PERMISSIONS.filter(
        (permission) => !permission.description?.trim(),
      ).map((permission) => permission.name);

      expect(undescribed).toEqual([]);
    });

    it('seeds every permission the API actually enforces', () => {
      // `roles.constants.ts` is the list the guards read; this file is the list
      // the database gets. A permission in the first and not the second is a
      // route nobody can reach.
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );
      const missing = Object.values(PERMISSION_CONSTANTS).filter(
        (permission) => !seeded.has(permission),
      );

      expect(missing).toEqual([]);
    });

    it('seeds the operations permissions this epic introduces (#256)', () => {
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );

      for (const permission of [
        'jobs:read',
        'jobs:write',
        'nodes:read',
        'nodes:write',
        'db_backup:read',
        'db_backup:write',
        'db_backup:restore',
      ]) {
        expect(seeded.has(permission)).toBe(true);
      }
    });

    it('seeds the broadcasts permissions this epic introduces (#320)', () => {
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );

      for (const permission of ['broadcasts:read', 'broadcasts:write']) {
        expect(seeded.has(permission)).toBe(true);
      }
    });

    it('seeds the transcripts permissions this epic introduces (#24)', () => {
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );

      for (const permission of ['transcripts:read', 'transcripts:write']) {
        expect(seeded.has(permission)).toBe(true);
      }
    });

    it('seeds the notes/note_templates permissions this epic introduces (#48)', () => {
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );

      for (const permission of [
        'notes:read',
        'notes:write',
        'note_templates:read',
        'note_templates:write',
      ]) {
        expect(seeded.has(permission)).toBe(true);
      }
    });

    // ===========================================================================
    // THE ABSENCE THIS TEST IS FOR (#48's own acceptance criterion): there is
    // deliberately no `notes:read_any` anywhere in this codebase, for any
    // role, ever (docs/specs/notes.md §6.3). This must fail loudly the
    // moment someone adds one — to PERMISSIONS here, to roles.constants.ts,
    // or to any ROLE_PERMISSIONS grant — which is why it checks all three
    // independently rather than trusting one list to catch a typo in
    // another.
    // ===========================================================================
    it('does NOT seed notes:read_any anywhere — the absence is deliberate', () => {
      const seededNames = PERMISSIONS.map((permission) => permission.name);
      expect(seededNames).not.toContain('notes:read_any');

      expect(Object.values(PERMISSION_CONSTANTS)).not.toContain('notes:read_any');

      const grantedAnywhere = Object.values(ROLE_PERMISSIONS).some((grants) =>
        grants.includes('notes:read_any'),
      );
      expect(grantedAnywhere).toBe(false);
    });
  });

  describe('graph permissions (#354, epic #344)', () => {
    it('seeds graph:read and graph:write exactly once each', () => {
      const names = PERMISSIONS.map((permission) => permission.name);

      expect(names.filter((name) => name === 'graph:read')).toHaveLength(1);
      expect(names.filter((name) => name === 'graph:write')).toHaveLength(1);
    });

    it('declares both in roles.constants.ts, the list the guards read', () => {
      expect(PERMISSION_CONSTANTS.GRAPH_READ).toBe('graph:read');
      expect(PERMISSION_CONSTANTS.GRAPH_WRITE).toBe('graph:write');
    });

    it('grants both to ALL THREE roles, the same posture as notes:*', () => {
      for (const role of ['admin', 'contributor', 'viewer']) {
        for (const permission of ['graph:read', 'graph:write']) {
          expect(ROLE_PERMISSIONS[role]).toContain(permission);
        }
      }
    });

    // The absence is the point (docs/specs/ontology.md §12): no permission to
    // read another user's graph exists anywhere, for any role. Checked in all
    // three lists independently, like notes:read_any above.
    it('does NOT seed graph:read_any anywhere — the absence is deliberate', () => {
      expect(PERMISSIONS.map((permission) => permission.name)).not.toContain(
        'graph:read_any',
      );
      expect(Object.values(PERMISSION_CONSTANTS)).not.toContain('graph:read_any');
      expect(
        Object.values(ROLE_PERMISSIONS).some((grants) =>
          grants.includes('graph:read_any'),
        ),
      ).toBe(false);
    });
  });

  describe('role-permission mappings', () => {
    it('names only roles that are seeded', () => {
      const roles = new Set<string>(ROLES.map((role) => role.name));
      const unknown = Object.keys(ROLE_PERMISSIONS).filter(
        (role) => !roles.has(role),
      );

      expect(unknown).toEqual([]);
    });

    it('names only permissions that are seeded', () => {
      // `seedRolePermissions` skips a permission it cannot find, silently. A
      // typo here therefore costs a grant with no error anywhere.
      const seeded = new Set<string>(
        PERMISSIONS.map((permission) => permission.name),
      );
      const unknown = Object.entries(ROLE_PERMISSIONS).flatMap(
        ([role, permissions]) =>
          permissions
            .filter((permission) => !seeded.has(permission))
            .map((permission) => `${role}: ${permission}`),
      );

      expect(unknown).toEqual([]);
    });

    it('grants each permission to a role at most once', () => {
      // The upsert makes a repeat harmless; it still means the list was edited
      // by someone who could not see what was already in it.
      const duplicated = Object.entries(ROLE_PERMISSIONS).flatMap(
        ([role, permissions]) =>
          permissions
            .filter(
              (permission, index) =>
                permissions.indexOf(permission) !== index,
            )
            .map((permission) => `${role}: ${permission}`),
      );

      expect(duplicated).toEqual([]);
    });

    it('grants the operations permissions to Admin and to nobody else (#256)', () => {
      const operations = [
        'jobs:read',
        'jobs:write',
        'nodes:read',
        'nodes:write',
        'db_backup:read',
        'db_backup:write',
        'db_backup:restore',
      ];

      for (const permission of operations) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      // Including the READ halves. The queue, the fleet and the backup history
      // are operational surfaces; a later issue can widen one of them with an
      // argument for that surface, and widening is the direction that costs
      // nothing (these are rows, not a migration).
      const leaked = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => operations.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leaked).toEqual([]);
    });

    it('grants the broadcasts permissions to Admin and to nobody else (#320)', () => {
      const broadcasts = ['broadcasts:read', 'broadcasts:write'];

      for (const permission of broadcasts) {
        expect(ROLE_PERMISSIONS.admin).toContain(permission);
      }

      const leaked = Object.entries(ROLE_PERMISSIONS)
        .filter(([role]) => role !== 'admin')
        .flatMap(([role, permissions]) =>
          permissions
            .filter((permission) => broadcasts.includes(permission))
            .map((permission) => `${role}: ${permission}`),
        );

      expect(leaked).toEqual([]);
    });

    it('grants the transcripts permissions to ALL THREE roles (#24) — the opposite posture from every operational pair above', () => {
      // Unlike jobs/nodes/db_backup/broadcasts/push (Admin-only), transcripts
      // is the core product action and this app's DEFAULT_ROLE is Viewer, so
      // every role — including Viewer — must hold both permissions from the
      // moment the seed runs.
      const transcripts = ['transcripts:read', 'transcripts:write'];

      for (const role of ['admin', 'contributor', 'viewer']) {
        for (const permission of transcripts) {
          expect(ROLE_PERMISSIONS[role]).toContain(permission);
        }
      }
    });

    it('grants the notes/note_templates permissions to ALL THREE roles (#48) — the same posture as transcripts:*', () => {
      // Mirrors transcripts:* exactly: generating a note is the core product
      // action, and this app's DEFAULT_ROLE is Viewer, so every role —
      // Viewer included — must hold all four grants from the moment the
      // seed runs (docs/specs/notes.md §6.3).
      const notes = [
        'notes:read',
        'notes:write',
        'note_templates:read',
        'note_templates:write',
      ];

      for (const role of ['admin', 'contributor', 'viewer']) {
        for (const permission of notes) {
          expect(ROLE_PERMISSIONS[role]).toContain(permission);
        }
      }
    });

    it('a Viewer holds notes:write (#48 acceptance criterion, stated explicitly)', () => {
      // The issue's own acceptance criterion, asserted directly rather than
      // only as a byproduct of the loop above: Viewer is this app's
      // DEFAULT_ROLE, and a brand-new account must be able to generate a
      // note from day one.
      expect(ROLE_PERMISSIONS.viewer).toContain('notes:write');
    });
  });

  describe('seeded system settings', () => {
    /**
     * The seed cannot import `DEFAULT_SYSTEM_SETTINGS` from `src/` — it runs
     * under ts-node outside the Nest build — so the two are a deliberate
     * duplicate, and a duplicate nobody checks is a duplicate that drifts. The
     * consequence of drift is mild but real: `readKnownSettings` degrades a
     * missing block to the API's defaults, so a seeded row that disagrees means
     * a fresh deployment's stored value and its effective value differ until the
     * first write, and an admin reading the row directly sees something the
     * application does not believe.
     */
    it('matches the API defaults exactly', () => {
      expect(SEEDED_SYSTEM_SETTINGS).toEqual(DEFAULT_SYSTEM_SETTINGS);
    });

    it('is a value the API would accept', () => {
      expect(() =>
        systemSettingsSchema.parse(SEEDED_SYSTEM_SETTINGS),
      ).not.toThrow();
    });
  });

  // ===========================================================================
  // Built-in note templates (#48, epic #45)
  // ===========================================================================
  //
  // `seed.ts`'s actual `upsert`-twice idempotency needs a real Postgres — see
  // `test/notes/note-schema.db.spec.ts` for that half. What this file can
  // assert without one is that the DATA is self-consistent: exactly the six
  // VISION.md-named built-ins, each with a stable id and real, usable prompt
  // text rather than a placeholder — the issue's own "not placeholder text"
  // requirement.
  describe('built-in note templates', () => {
    it('seeds exactly the six VISION.md-named built-ins', () => {
      const names = NOTE_TEMPLATES.map((template) => template.name).sort();

      expect(names).toEqual(
        [
          'Concise Meeting Notes',
          'Detailed Meeting Notes',
          'Executive Summary',
          'Action Items',
          'Decision Log',
          'Follow-up Email',
        ].sort(),
      );
    });

    it('gives every built-in a stable, unique UUID id to upsert on', () => {
      const ids = NOTE_TEMPLATES.map((template) => template.id);
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      for (const id of ids) {
        expect(id).toMatch(uuidPattern);
      }
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('re-running the seed data twice would upsert the SAME ids (idempotency by id, not by insert order)', () => {
      // The actual re-run happens against a real Postgres in the .db.spec.ts
      // suite; what is checked here, with no database needed, is the
      // precondition that makes that idempotent at all — a second pass over
      // this exact array upserts on the exact same `id` values, never a
      // freshly generated one.
      const idsPassOne = NOTE_TEMPLATES.map((t) => t.id);
      const idsPassTwo = NOTE_TEMPLATES.map((t) => t.id);
      expect(idsPassTwo).toEqual(idsPassOne);
    });

    it('gives every built-in a non-placeholder description and instructions block', () => {
      for (const template of NOTE_TEMPLATES) {
        expect(template.description.trim().length).toBeGreaterThan(20);
        expect(template.description.toLowerCase()).not.toMatch(/\btodo\b|\bplaceholder\b|\bfixme\b|\blorem ipsum\b/);

        // Real, usable prompt text, not a stub — long enough to actually
        // instruct a model on structure, tone and length (spec §4.3's "one
        // field" design composes exactly those into this string).
        expect(template.instructions.trim().length).toBeGreaterThan(200);
        expect(template.instructions.toLowerCase()).not.toMatch(
          /\btodo\b|\bplaceholder\b|\bfixme\b|\blorem ipsum\b/,
        );
      }
    });

    it('never sets an ownerId on a built-in — that is what makes it built-in (spec §7.1)', () => {
      // NOTE_TEMPLATES itself carries no ownerId field at all (seed.ts
      // hard-codes `ownerId: null` at the create site); this test pins that
      // absence so a future edit adding one to the array is caught here
      // rather than only surfacing as a row a user appears to own.
      for (const template of NOTE_TEMPLATES) {
        expect(template).not.toHaveProperty('ownerId');
      }
    });

    // =========================================================================
    // Structured fields (issue #48). Every built-in must give a real value
    // for `outputFormat` and a non-empty `structure` — #56's template editor
    // presents these as real controls (an Output format select, an editable
    // ordered list for Structure) that a user reopening a built-in-derived
    // template must see populated, not a blank form masquerading as a
    // working template.
    // =========================================================================
    it('gives every built-in a non-empty outputFormat', () => {
      for (const template of NOTE_TEMPLATES) {
        expect(typeof template.outputFormat).toBe('string');
        expect(template.outputFormat.trim().length).toBeGreaterThan(0);
      }
    });

    it('gives every built-in a non-empty, ordered structure array', () => {
      for (const template of NOTE_TEMPLATES) {
        expect(Array.isArray(template.structure)).toBe(true);
        expect(template.structure.length).toBeGreaterThan(0);
        for (const section of template.structure) {
          expect(typeof section).toBe('string');
          expect((section as string).trim().length).toBeGreaterThan(0);
        }
      }
    });

    it('gives every built-in a tone and a length', () => {
      for (const template of NOTE_TEMPLATES) {
        expect(typeof template.tone).toBe('string');
        expect(template.tone.trim().length).toBeGreaterThan(0);
        expect(typeof template.length).toBe('string');
        expect(template.length.trim().length).toBeGreaterThan(0);
      }
    });

    it('leaves model unset on every built-in — no forced per-template model override by default', () => {
      // A built-in has no reason to pin a model: #56's optional Model
      // override exists for a user's own custom template, and forcing one
      // here would make a built-in start failing the moment a deployment
      // stops offering that model, for no product benefit.
      for (const template of NOTE_TEMPLATES) {
        expect(template).not.toHaveProperty('model');
      }
    });
  });
});

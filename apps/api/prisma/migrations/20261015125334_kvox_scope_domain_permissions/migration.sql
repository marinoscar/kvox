-- Scope KVox's domain permissions to organizations (issue #465, epic #462).
--
-- Platform migration 0024_split_system_org_roles split roles and permissions
-- into system and org scope: `contributor` and `viewer` are org roles held
-- through memberships.role_id, and the system role `admin` reaches org
-- permissions through its `org_admin` membership. It scoped only the platform's
-- own permissions, so the eight KVox domain permissions are still 'system' and
-- still granted to `admin` directly. This migration finishes the job for them,
-- the same way 0024 did for the platform's:
--
--   1. mark the eight permissions 'org';
--   2. give `org_admin` every grant `admin` holds on them (same rows 0024 moved
--      for the platform permissions; ON CONFLICT keeps a re-run harmless);
--   3. remove `admin`'s direct grants on them.
--
-- The `contributor` and `viewer` grants stay as they are. `prisma:seed`
-- (seedPlatform with the KVox permission catalog) re-asserts all of this from
-- prisma/catalog/permissions.json, so a database migrated here and one seeded
-- from scratch end in the same state. On an empty database the permission rows
-- do not exist yet, so every statement below matches nothing.

UPDATE "permissions" SET "scope" = 'org'
 WHERE "name" IN (
   'transcripts:read', 'transcripts:write',
   'notes:read', 'notes:write',
   'note_templates:read', 'note_templates:write',
   'graph:read', 'graph:write'
 );

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT oa."id", rp."permission_id"
  FROM "role_permissions" rp
  JOIN "roles" a ON a."id" = rp."role_id" AND a."name" = 'admin'
  JOIN "permissions" p ON p."id" = rp."permission_id"
 CROSS JOIN "roles" oa
 WHERE oa."name" = 'org_admin'
   AND p."name" IN (
     'transcripts:read', 'transcripts:write',
     'notes:read', 'notes:write',
     'note_templates:read', 'note_templates:write',
     'graph:read', 'graph:write'
   )
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions" rp
 USING "roles" r, "permissions" p
 WHERE rp."role_id" = r."id" AND rp."permission_id" = p."id"
   AND r."name" = 'admin'
   AND p."name" IN (
     'transcripts:read', 'transcripts:write',
     'notes:read', 'notes:write',
     'note_templates:read', 'note_templates:write',
     'graph:read', 'graph:write'
   );

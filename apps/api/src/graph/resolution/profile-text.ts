// =============================================================================
// Profile texts for embeddings (#364, epic #346; docs/specs/ontology.md §7)
// =============================================================================
//
// PURE. The one text an entity (or item) is embedded from, and the one text a
// proposal mention is embedded from for resolution's vector arm — the SAME
// builder for both, so the two vectors are comparable by construction.
//
//   entity  "{type}: {label}\nAlso known as: {aliases}\nOrganization: {orgs}\n
//            Role: {titles}\nOften mentioned with: {top 5 co-mentions}"
//   item    "{kind}: {title}\n{statement}\nAbout: {subject label}"
//
// A line with nothing to say is omitted, so an entity with no aliases embeds
// exactly as if the field did not exist. Lists are de-duplicated
// (case-insensitively) and ordered as given — the caller orders them.
//
// `profileHash` keys the embed skip: sha256(modelId + '\n' + text). The model
// is part of the key because two models' vectors are never comparable.
// =============================================================================

import { createHash } from 'node:crypto';

export interface EntityProfileInput {
  type: string;
  label: string;
  aliases?: readonly string[];
}

export interface EntityProfileContext {
  orgLabels?: readonly string[];
  roleTitles?: readonly string[];
  /** Most co-mentioned first; only the first five are used. */
  coMentioned?: readonly string[];
}

export interface ItemProfileInput {
  kind: string;
  title: string | null;
  statement: string;
  subjectLabel?: string | null;
}

export const PROFILE_CO_MENTION_LIMIT = 5;

function uniq(values: readonly string[] | undefined, exclude: readonly string[] = []): string[] {
  const seen = new Set(exclude.map((v) => v.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of values ?? []) {
    const v = raw.trim();
    const key = v.toLowerCase();
    if (v.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function buildEntityProfileText(entity: EntityProfileInput, ctx: EntityProfileContext = {}): string {
  const label = entity.label.trim();
  const lines = [`${entity.type}: ${label}`];
  const aliases = uniq(entity.aliases, [label]);
  if (aliases.length > 0) lines.push(`Also known as: ${aliases.join(', ')}`);
  const orgs = uniq(ctx.orgLabels);
  if (orgs.length > 0) lines.push(`Organization: ${orgs.join(', ')}`);
  const roles = uniq(ctx.roleTitles);
  if (roles.length > 0) lines.push(`Role: ${roles.join(', ')}`);
  const co = uniq(ctx.coMentioned, [label]).slice(0, PROFILE_CO_MENTION_LIMIT);
  if (co.length > 0) lines.push(`Often mentioned with: ${co.join(', ')}`);
  return lines.join('\n');
}

export function buildItemProfileText(item: ItemProfileInput): string {
  const title = item.title?.trim() || item.statement.trim().slice(0, 80);
  const lines = [`${item.kind}: ${title}`, item.statement.trim()];
  const about = item.subjectLabel?.trim();
  if (about) lines.push(`About: ${about}`);
  return lines.join('\n');
}

export function profileHash(modelId: string, text: string): string {
  return createHash('sha256').update(`${modelId}\n${text}`, 'utf8').digest('hex');
}

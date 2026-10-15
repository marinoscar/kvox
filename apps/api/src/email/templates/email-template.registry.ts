import { defineRegistry } from '../../common/registry';
import { resetRegistryForTests } from '../../common/registry/testing';
import type { EmailTemplate } from './email-template.types';
import type { EmailTemplateDataMap, EmailTemplateName } from './index';

// =============================================================================
// The email template registry (issue #460, mirrors EnterpriseAppBase
// `email/templates/email-template.registry.ts`)
// =============================================================================
//
// Until #460 `index.ts` imported every template, domain ones included, and
// listed them in a closed `EMAIL_TEMPLATES` object. That is a base module naming
// domain code, which is the edge a published email slice cannot have. Now a
// template is REGISTERED: the base ones from `kvox.manifest.ts` through
// `BASE_EMAIL_TEMPLATES`, a domain one from its own folder
// (`transcripts/notifications/`, `notes/notifications/`), and `index.ts` reads
// this registry.
//
// -----------------------------------------------------------------------------
// THE TYPE-LEVEL LOCK SURVIVES, MOVED
// -----------------------------------------------------------------------------
//
// `EmailTemplateName` is still derived from `EmailTemplateDataMap`, and
// `registerEmailTemplate` pins each template's data parameter to its name's
// entry in that map, so a template cannot be registered under a key whose
// payload it does not accept. What changed is who may add a key: the interface
// is AUGMENTABLE, and a domain file adds its own with
//
//     declare module '../../email/templates' {
//       interface EmailTemplateDataMap { 'thing': ThingEmailData }
//     }
//
// The cost of the move is the half of the old lock that was a mapped type over
// the closed object: "declared in the map but never registered" is now a RUNTIME
// property (`notification-registry.ts` refuses a binding whose template is not
// registered, and the `index.spec.ts` contract loop walks every registered
// template), not a compile error.
//
// -----------------------------------------------------------------------------
// WHY `EMAIL_TEMPLATES` IS STILL AN OBJECT
// -----------------------------------------------------------------------------
//
// `EMAIL_TEMPLATES` and `EMAIL_TEMPLATE_NAMES` are exported by name from
// `email/templates` and `email`, and specs index them. They are READ-ONLY VIEWS
// kept in step by this file alone: the registry is the source of truth, and
// `registerEmailTemplate(s)` appends to the views in the same call, after the
// registry has accepted the entry. A view is mutated nowhere else (its type is
// `Readonly`), and the registry refuses every write once the application has
// bootstrapped, so the views cannot drift.
// =============================================================================

interface EmailTemplateEntry {
  readonly name: string;
  readonly template: EmailTemplate<never>;
}

/** Name -> renderer. The source of truth; registration order is the view order. */
export const emailTemplateRegistry = defineRegistry<EmailTemplateEntry>({
  name: 'email-templates',
  idOf: (entry) => entry.name,
  validate: (entry) => {
    if (typeof entry.template !== 'function') {
      throw new TypeError('an email template must be a function (data) => RenderedEmail');
    }
  },
  describeDuplicate: (_existing, incoming) =>
    `Email template '${incoming.name}' is already registered.`,
});

const templateView: Partial<Record<string, EmailTemplate<never>>> = {};
const nameView: string[] = [];

/**
 * Name -> renderer, in registration order. A read-only view of
 * {@link emailTemplateRegistry}; every renderer's data parameter is pinned to
 * its name's entry in {@link EmailTemplateDataMap}.
 */
export const EMAIL_TEMPLATES = templateView as Readonly<{
  [K in EmailTemplateName]: EmailTemplate<EmailTemplateDataMap[K]>;
}>;

/**
 * Every registered name, derived from the registry rather than restated.
 *
 * For tests that need to assert something about all templates at once -- that
 * each returns a non-empty `subject`, `html` AND `text`, for instance, which is
 * a test that has to be able to enumerate them or it only ever checks the ones
 * somebody remembered to list.
 */
export const EMAIL_TEMPLATE_NAMES = nameView as readonly EmailTemplateName[];

/** A template and the data type it is registered for. */
export type EmailTemplateRegistrations = {
  [K in EmailTemplateName]?: EmailTemplate<EmailTemplateDataMap[K]>;
};

function entriesOf(templates: EmailTemplateRegistrations): EmailTemplateEntry[] {
  return Object.entries(templates).map(([name, template]) => ({
    name,
    template: template as EmailTemplate<never>,
  }));
}

function commit(entries: EmailTemplateEntry[]): void {
  for (const entry of entries) {
    templateView[entry.name] = entry.template;
    nameView.push(entry.name);
  }
}

/**
 * Registers one template under `name`.
 *
 * @throws RegistryError `DUPLICATE_ID` when the name is taken, `FROZEN` after
 * bootstrap, `INVALID_ID`/`INVALID_ENTRY` for a malformed one; nothing is
 * stored when it throws.
 */
export function registerEmailTemplate<K extends EmailTemplateName>(
  name: K,
  template: EmailTemplate<EmailTemplateDataMap[K]>,
): void {
  const entry: EmailTemplateEntry = {
    name,
    template: template as EmailTemplate<never>,
  };
  emailTemplateRegistry.register(entry);
  commit([entry]);
}

/**
 * Registers several templates, in key order, all or nothing: a duplicate or
 * malformed entry anywhere in the batch stores none of them.
 */
export function registerEmailTemplates(templates: EmailTemplateRegistrations): void {
  const entries = entriesOf(templates);
  emailTemplateRegistry.registerAll(entries);
  commit(entries);
}

/**
 * Empties the registry and its views and unfreezes it. SPECS ONLY: refused
 * outside Jest/Vitest, and a Jest worker gives each test file its own module
 * instance, so it cannot leak into another file.
 */
export function resetEmailTemplatesForTests(): void {
  resetRegistryForTests(emailTemplateRegistry);
  for (const name of Object.keys(templateView)) delete templateView[name];
  nameView.length = 0;
}

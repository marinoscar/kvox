import { RegistryError } from '../../common/registry';
import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_NAMES,
  emailTemplateRegistry,
  registerEmailTemplate,
  registerEmailTemplates,
  resetEmailTemplatesForTests,
} from './email-template.registry';
import { findEmailTemplate, isEmailTemplateName, renderEmailTemplate } from './index';

// =============================================================================
// The email template registry (issue #460): duplicate, atomic and frozen
// behaviour, and the views `index.ts` reads
// =============================================================================
//
// `test/setup.ts` has already run the manifest, so the registry holds every real
// template; each test starts from an empty one so it controls exactly what is
// registered. A Jest worker gives every test file its own module instance, so
// the reset cannot leak into another file.
// =============================================================================

const rendered = { subject: 's', html: '<p>h</p>', text: 't' };
const testTemplate = () => rendered;

function code(fn: () => void): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof RegistryError ? err.code : `not a RegistryError: ${String(err)}`;
  }
  return undefined;
}

describe('email template registry', () => {
  beforeEach(() => {
    resetEmailTemplatesForTests();
  });

  it('registers a template and exposes it through every view', () => {
    registerEmailTemplate('test-email', testTemplate);

    expect(emailTemplateRegistry.has('test-email')).toBe(true);
    expect(isEmailTemplateName('test-email')).toBe(true);
    expect(findEmailTemplate('test-email')).toBe(testTemplate);
    expect(EMAIL_TEMPLATES['test-email']).toBe(testTemplate);
    expect([...EMAIL_TEMPLATE_NAMES]).toEqual(['test-email']);
    expect(Object.keys(EMAIL_TEMPLATES)).toEqual(['test-email']);
    expect(
      renderEmailTemplate('test-email', {} as never),
    ).toEqual(rendered);
  });

  it('keeps registration order across single and batch registrations', () => {
    registerEmailTemplate('job-failed', testTemplate);
    registerEmailTemplates({ 'node-offline': testTemplate, broadcast: testTemplate });

    expect([...EMAIL_TEMPLATE_NAMES]).toEqual(['job-failed', 'node-offline', 'broadcast']);
    expect(Object.keys(EMAIL_TEMPLATES)).toEqual(['job-failed', 'node-offline', 'broadcast']);
  });

  it('answers undefined, never throws, for a name nothing registered', () => {
    expect(findEmailTemplate('does-not-exist')).toBeUndefined();
    expect(isEmailTemplateName('does-not-exist')).toBe(false);
  });

  describe('duplicates', () => {
    it('refuses a second template under the same name', () => {
      registerEmailTemplate('test-email', testTemplate);

      expect(code(() => registerEmailTemplate('test-email', () => rendered))).toBe('DUPLICATE_ID');
      expect(EMAIL_TEMPLATES['test-email']).toBe(testTemplate);
      expect(EMAIL_TEMPLATE_NAMES).toHaveLength(1);
    });
  });

  describe('atomic batches', () => {
    it('stores none of a batch whose later entry duplicates a registered name', () => {
      registerEmailTemplate('job-failed', testTemplate);

      expect(
        code(() =>
          registerEmailTemplates({ 'node-offline': testTemplate, 'job-failed': testTemplate }),
        ),
      ).toBe('DUPLICATE_ID');

      expect([...EMAIL_TEMPLATE_NAMES]).toEqual(['job-failed']);
      expect(emailTemplateRegistry.has('node-offline')).toBe(false);
      expect(EMAIL_TEMPLATES['node-offline']).toBeUndefined();
    });

    it('stores none of a batch containing a malformed entry', () => {
      expect(
        code(() =>
          registerEmailTemplates({
            'node-offline': testTemplate,
            broadcast: 'not a function' as never,
          }),
        ),
      ).toBe('INVALID_ENTRY');

      expect(EMAIL_TEMPLATE_NAMES).toHaveLength(0);
      expect(emailTemplateRegistry.size).toBe(0);
    });
  });

  describe('frozen', () => {
    it('refuses every registration once frozen and leaves the views untouched', () => {
      registerEmailTemplate('test-email', testTemplate);
      emailTemplateRegistry.freeze();

      expect(code(() => registerEmailTemplate('job-failed', testTemplate))).toBe('FROZEN');
      expect(code(() => registerEmailTemplates({ broadcast: testTemplate }))).toBe('FROZEN');

      expect([...EMAIL_TEMPLATE_NAMES]).toEqual(['test-email']);
      expect(findEmailTemplate('test-email')).toBe(testTemplate);
    });

    it('is unfrozen again by the test reset', () => {
      emailTemplateRegistry.freeze();
      resetEmailTemplatesForTests();

      expect(code(() => registerEmailTemplate('test-email', testTemplate))).toBeUndefined();
    });
  });
});

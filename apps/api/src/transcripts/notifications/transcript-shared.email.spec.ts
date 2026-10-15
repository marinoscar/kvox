import {
  shareRoleLabel,
  shareRoleSentence,
  transcriptSharedEmail,
  type TranscriptSharedEmailData,
} from './transcript-shared.email';

// =============================================================================
// `transcripts.transcript_shared` template (issue #29, epic #19)
// =============================================================================
//
// `index.spec.ts` already runs the shared contract (non-empty parts, escaping,
// a subject with no markup) over every registered template. What is asserted
// HERE is what is specific to this one:
//
//   * the ROLE is in the message, in both parts, in the reader's language;
//   * the TITLE is deliberately NOT in the subject line;
//   * the CTA points at `/transcripts/:id` and degrades to no button rather
//     than to a broken link when the deployment has no `appUrl`.
// =============================================================================

const data: TranscriptSharedEmailData = {
  transcriptId: '11111111-2222-4333-8444-555555555555',
  title: 'Board meeting, 3 March',
  role: 'editor',
  ownerName: 'Ana Rivera',
  appUrl: 'https://app.example.test',
};

describe('transcriptSharedEmail', () => {
  it('names who shared it in the subject', () => {
    expect(transcriptSharedEmail(data).subject).toContain('Ana Rivera');
  });

  it('keeps the recording TITLE out of the subject line', () => {
    // A subject renders on a lock screen and in a notification preview. The
    // title of somebody else's private conversation has no business there
    // before the recipient has even opened the message — the body carries it.
    expect(transcriptSharedEmail(data).subject).not.toContain('Board meeting');
  });

  it('carries the title in both the html and the text parts', () => {
    const rendered = transcriptSharedEmail(data);

    expect(rendered.html).toContain('Board meeting, 3 March');
    expect(rendered.text).toContain('Board meeting, 3 March');
  });

  it('names the role and says what it allows, in both parts', () => {
    const rendered = transcriptSharedEmail(data);

    expect(rendered.html).toContain('Editor');
    expect(rendered.html).toContain('correct it');
    expect(rendered.text).toContain('Editor');
    expect(rendered.text).toContain('correct it');
  });

  it('says a viewer CANNOT change anything, in so many words', () => {
    const rendered = transcriptSharedEmail({ ...data, role: 'viewer' });

    expect(rendered.html).toContain('Viewer');
    expect(rendered.text).toContain('You cannot change it.');
  });

  it('carries the confidentiality note — this is a private conversation', () => {
    const rendered = transcriptSharedEmail(data);

    expect(rendered.html).toContain('confidential');
    expect(rendered.text).toContain('confidential');
  });

  it('points the CTA at the transcript', () => {
    expect(transcriptSharedEmail(data).html).toContain(
      'https://app.example.test/transcripts/11111111-2222-4333-8444-555555555555',
    );
  });

  it('renders with no CTA at all rather than a broken link when appUrl is unset', () => {
    const rendered = transcriptSharedEmail({ ...data, appUrl: undefined });

    expect(rendered.html).not.toContain('Open transcript');
    expect(rendered.text).not.toContain('Open transcript');
    expect(rendered.subject.length).toBeGreaterThan(0);
  });

  it('escapes hostile content in the title rather than emitting it as markup', () => {
    const rendered = transcriptSharedEmail({
      ...data,
      title: '<script>alert(document.cookie)</script>',
    });

    expect(rendered.html).not.toContain('<script>alert(document.cookie)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('escapes hostile content in the owner name too', () => {
    const rendered = transcriptSharedEmail({
      ...data,
      ownerName: '"><img src=x onerror=alert(1)>',
    });

    expect(rendered.html).not.toContain('<img src=x onerror=alert(1)>');
  });
});

describe('shareRoleLabel / shareRoleSentence', () => {
  it('capitalises the role for a subject or a toast', () => {
    expect(shareRoleLabel('editor')).toBe('Editor');
    expect(shareRoleLabel('viewer')).toBe('Viewer');
  });

  it('describes what each role allows without naming a permission string', () => {
    // A recipient is a person, not an operator: "you can correct it" is the
    // fact they need, and `transcripts:write` is not.
    expect(shareRoleSentence('editor')).not.toMatch(/transcripts:/);
    expect(shareRoleSentence('viewer')).not.toMatch(/transcripts:/);
    expect(shareRoleSentence('editor')).toMatch(/correct/i);
    expect(shareRoleSentence('viewer')).toMatch(/cannot change/i);
  });
});

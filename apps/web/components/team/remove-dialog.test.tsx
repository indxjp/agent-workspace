import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { MemberDialogState, MembershipResource } from './model';
import { RemoveMemberDialog } from './remove-dialog';

/**
 * The removal confirmation, rendered one state at a time — issue #185.
 *
 * `MemberDialogState` is the whole of the dialog's state machine precisely so each member of it can
 * be rendered here: with no jsdom, a state reachable only through an internal transition would be
 * untestable. Focus order, Escape and the Tab cycle are not assertable without a DOM and are
 * covered by `tests/browser/team-members.spec.mjs` instead.
 */
const MEMBER: MembershipResource = {
  id: 'membership-2',
  principalId: '22222222-2222-4222-8222-222222222222',
  userId: 'user-2',
  email: 'kenji.sato@example.test',
  name: 'Kenji Sato',
  role: 'admin',
  createdAt: '2026-09-13T09:15:00.000Z',
};

const noop = () => undefined;

function dialog(state: MemberDialogState): string {
  return renderToStaticMarkup(
    <RemoveMemberDialog member={MEMBER} state={state} onCancel={noop} onConfirm={noop} />,
  );
}

describe('RemoveMemberDialog', () => {
  it('is a labelled modal dialog, the shape the other dialogs here established', () => {
    const html = dialog({ kind: 'counting' });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="team-remove-dialog-title"');
    expect(html).toContain('id="team-remove-dialog-title"');
  });

  it('names the member it is about to remove, by name and by address', () => {
    const html = dialog({ kind: 'counting' });
    expect(html).toContain('Kenji Sato');
    expect(html).toContain('kenji.sato@example.test');
  });

  it('gives the confirm button an accessible name that says which member it acts on', () => {
    expect(dialog({ kind: 'counting' })).toContain(
      'aria-label="Remove Kenji Sato from this workspace"',
    );
  });

  it('says it is still counting while the two impact reads are in flight', () => {
    const html = dialog({ kind: 'counting' });
    expect(html).toContain('Counting the sessions and projects this member owns');
    expect(html).toContain('role="status"');
  });

  it('names the counts once they are in, in the singular, and warns about the refusal', () => {
    const html = dialog({ kind: 'counted', impact: { sessions: 1, projects: 1 } });
    expect(html).toContain('1 session and 1 project');
    expect(html).toContain('may be refused');
  });

  it('names the counts in the plural', () => {
    expect(dialog({ kind: 'counted', impact: { sessions: 3, projects: 12 } })).toContain(
      '3 sessions and 12 projects',
    );
  });

  it('says plainly when the member owns nothing', () => {
    const html = dialog({ kind: 'counted', impact: { sessions: 0, projects: 0 } });
    expect(html).toContain('owns no sessions and no projects');
    expect(html).not.toContain('may be refused');
  });

  it('admits an uncounted impact instead of showing a zero it never established', () => {
    const html = dialog({ kind: 'impact-unavailable' });
    expect(html).toContain('could not be counted');
    expect(html).not.toContain('0 sessions');
    // Still confirmable: an unrelated list endpoint's failure must not block a change the server
    // would accept.
    expect(html).toContain('Remove member');
  });

  it('disables both controls and says so while the removal is in flight', () => {
    const html = dialog({ kind: 'submitting' });
    expect(html).toContain('Removing…');
    expect(html.match(/disabled/gu)).toHaveLength(2);
  });

  it('renders a refusal with the sentence it was given, and keeps the panel usable', () => {
    const html = dialog({
      kind: 'failed',
      message:
        'This is the workspace’s last Owner; removing it leaves a workspace nobody can administer.',
    });
    expect(html).toContain('last Owner');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('disabled');
  });
});

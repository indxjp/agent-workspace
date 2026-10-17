import { describe, expect, it } from 'vitest';

import type { UserMembershipSummary } from '../rbac/directory';
import { pickerQuery, selectionPageHtml } from './workspace-picker';

const HOSTILE = `<b>&"x"</b>`;
const ESCAPED = '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;';

function membership(workspaceName: string): UserMembershipSummary {
  return {
    principalId: 'principal-1',
    workspaceId: 'ws-1',
    workspaceSlug: 'acme',
    workspaceName,
    role: 'builder',
  };
}

describe('selectionPageHtml', () => {
  it('escapes <, >, & and " in workspace name, email and destination', () => {
    const html = selectionPageHtml(HOSTILE, [membership(HOSTILE)], null, HOSTILE);

    expect(html).not.toContain(HOSTILE);
    expect(html).toContain(`Signed in as ${ESCAPED}.`);
    expect(html).toContain(`<button type="submit">${ESCAPED} — builder</button>`);
    expect(html).toContain(`name="next" value="${ESCAPED}"`);
  });

  it('includes the hidden next field only when a destination is given', () => {
    expect(selectionPageHtml('a@example.test', [membership('Acme')], null, null)).not.toContain(
      'name="next"',
    );
    expect(selectionPageHtml('a@example.test', [membership('Acme')], null, '/runs')).toContain(
      '<input type="hidden" name="next" value="/runs" />',
    );
  });

  it('shows the alert only for workspace_not_available', () => {
    expect(selectionPageHtml('a@example.test', [], 'workspace_not_available', null)).toContain(
      '<p role="alert">',
    );
    expect(selectionPageHtml('a@example.test', [], 'other', null)).not.toContain('role="alert"');
  });
});

describe('pickerQuery', () => {
  it('builds the query string for a redirect back to the picker', () => {
    expect(pickerQuery(null, null)).toBe('');
    expect(pickerQuery('workspace_not_available', null)).toBe('?error=workspace_not_available');
    expect(pickerQuery('workspace_not_available', '/runs')).toBe(
      '?error=workspace_not_available&next=%2Fruns',
    );
  });
});

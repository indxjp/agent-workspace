import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ProjectArchiveCapability, ProjectResource } from './model';
import { ProjectArchiveDialog, ProjectLifecycleSection } from './project-archive';

/**
 * Issue #184's lifecycle controls, rendered one state at a time.
 *
 * This repository has no jsdom and no Testing Library, so a component test is one
 * `renderToStaticMarkup` pass with no effects and no events — which is exactly why every async
 * state of the confirmation is a **prop** (`ArchiveDialogState`). Each `it` below renders one
 * member of that union; a state that could only be reached by an internal `useState` transition
 * would be untestable here, and an untestable state is an untested one.
 *
 * Focus order, Escape and the Tab cycle are not assertable without a DOM and are covered by
 * `tests/browser/projects-archive.spec.mjs` and `tests/browser/accessibility.spec.mjs` instead.
 */
const PROJECT: ProjectResource = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'Contract Review',
  instructions: null,
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'workspace',
  createdBy: '44444444-4444-4444-8444-444444444444',
  ownerPrincipalId: '55555555-5555-4555-8555-555555555555',
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  fileIds: [],
  mcpServerIds: [],
};

const ARCHIVED: ProjectResource = { ...PROJECT, archivedAt: '2026-09-13T08:30:00.000Z' };

/** The caller the server said may retire their own projects, and this is one of theirs. */
const MAY_ARCHIVE: ProjectArchiveCapability = {
  canArchiveOwn: true,
  canArchiveOther: false,
  viewerPrincipalId: PROJECT.ownerPrincipalId,
};

const MAY_NOT_ARCHIVE: ProjectArchiveCapability = {
  canArchiveOwn: false,
  canArchiveOther: false,
  viewerPrincipalId: PROJECT.ownerPrincipalId,
};

const noop = () => undefined;

function section(
  project: ProjectResource,
  capability: ProjectArchiveCapability,
  dialog: Parameters<typeof ProjectLifecycleSection>[0]['dialog'] = null,
): string {
  return renderToStaticMarkup(
    <ProjectLifecycleSection
      project={project}
      capability={capability}
      dialog={dialog}
      onOpen={noop}
      onCancel={noop}
      onConfirm={noop}
    />,
  );
}

function dialog(
  project: ProjectResource,
  transition: 'archive' | 'restore',
  state: Parameters<typeof ProjectArchiveDialog>[0]['state'],
): string {
  return renderToStaticMarkup(
    <ProjectArchiveDialog
      project={project}
      transition={transition}
      state={state}
      onCancel={noop}
      onConfirm={noop}
    />,
  );
}

describe('ProjectLifecycleSection', () => {
  it('renders nothing when the caller may not archive', () => {
    // The load-bearing assertion for "refused users see no actionable control": deleting the
    // `canArchiveProject` guard in `project-archive.tsx` fails exactly here.
    expect(section(PROJECT, MAY_NOT_ARCHIVE)).toBe('');
  });

  it('renders nothing when the viewer could not be resolved, however wide the grants look', () => {
    expect(
      section(PROJECT, { canArchiveOwn: true, canArchiveOther: true, viewerPrincipalId: null }),
    ).toBe('');
  });

  it('renders nothing for a project somebody else created when the grant is own-only', () => {
    expect(
      section(
        { ...PROJECT, ownerPrincipalId: '99999999-9999-4999-8999-999999999999' },
        MAY_ARCHIVE,
      ),
    ).toBe('');
  });

  it('offers Archive for an active project the caller may retire', () => {
    const html = section(PROJECT, MAY_ARCHIVE);
    expect(html).toContain('Archive project');
    expect(html).not.toContain('Restore project');
  });

  it('offers Restore instead once the project is archived', () => {
    const html = section(ARCHIVED, MAY_ARCHIVE);
    expect(html).toContain('Restore project');
    expect(html).not.toContain('Archive project');
  });

  it('does not mount the confirmation until it is opened', () => {
    expect(section(PROJECT, MAY_ARCHIVE)).not.toContain('role="dialog"');
    expect(section(PROJECT, MAY_ARCHIVE, { kind: 'counting' })).toContain('role="dialog"');
  });
});

describe('ProjectArchiveDialog', () => {
  it('is a labelled modal dialog, the same shape ShareDialog established', () => {
    const html = dialog(PROJECT, 'archive', { kind: 'counting' });
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="project-lifecycle-dialog-title"');
    expect(html).toContain('id="project-lifecycle-dialog-title"');
  });

  it('names the project it is about to retire', () => {
    expect(dialog(PROJECT, 'archive', { kind: 'counting' })).toContain('Contract Review');
  });

  it('says it is still counting while the two impact reads are in flight', () => {
    const html = dialog(PROJECT, 'archive', { kind: 'counting' });
    expect(html).toContain('Counting the sessions and runs this affects');
    expect(html).toContain('role="status"');
  });

  it('names the counts once they are in, in the singular', () => {
    expect(
      dialog(PROJECT, 'archive', {
        kind: 'counted',
        impact: { sessions: 1, runs: 1, runsTruncated: false },
      }),
    ).toContain('1 session and 1 run that you can see');
  });

  it('names the counts in the plural', () => {
    expect(
      dialog(PROJECT, 'archive', {
        kind: 'counted',
        impact: { sessions: 3, runs: 12, runsTruncated: false },
      }),
    ).toContain('3 sessions and 12 runs that you can see');
  });

  it('says "200+" when the run page was truncated', () => {
    expect(
      dialog(PROJECT, 'archive', {
        kind: 'counted',
        impact: { sessions: 2, runs: 200, runsTruncated: true },
      }),
    ).toContain('200+ runs');
  });

  it('admits an uncounted impact instead of showing a zero it never established', () => {
    const html = dialog(PROJECT, 'archive', { kind: 'count-unavailable' });
    expect(html).toContain('could not be counted');
    expect(html).not.toContain('0 sessions');
    // Still confirmable: an unrelated list endpoint's failure must not block a transition the
    // server would accept.
    expect(html).toContain('Archive project');
  });

  it('disables both controls and says so while the transition is in flight', () => {
    const html = dialog(PROJECT, 'archive', { kind: 'submitting' });
    expect(html).toContain('Archiving…');
    expect(html.match(/disabled/gu)).toHaveLength(2);
  });

  it('renders a concealed 404 as the wording the client can actually stand behind', () => {
    const html = dialog(PROJECT, 'archive', {
      kind: 'failed',
      problem: {
        kind: 'api',
        status: 404,
        code: 'project_not_found',
        message: 'This project is no longer available.',
      },
    });
    expect(html).toContain('This project is no longer available.');
    expect(html).toContain('role="alert"');
  });

  it("renders a 409 conflict with the server's own wording", () => {
    const html = dialog(PROJECT, 'archive', {
      kind: 'failed',
      problem: {
        kind: 'api',
        status: 409,
        code: 'project_archived',
        message: 'This project is archived.',
      },
    });
    expect(html).toContain('409 project_archived');
    expect(html).toContain('This project is archived.');
  });

  it('renders a transport failure as a failure rather than as silence', () => {
    expect(
      dialog(PROJECT, 'archive', {
        kind: 'failed',
        problem: { kind: 'transport', reason: 'The connection was reset.' },
      }),
    ).toContain('The connection was reset.');
  });

  it('confirms a restore without an impact summary, because it retires nothing', () => {
    const html = dialog(ARCHIVED, 'restore', { kind: 'confirming' });
    expect(html).toContain('Restore');
    expect(html).toContain('able to start in this project again');
    expect(html).not.toContain('that you can see');
    expect(html).not.toContain('Counting the sessions');
  });

  it('says it is restoring while that transition is in flight', () => {
    expect(dialog(ARCHIVED, 'restore', { kind: 'submitting' })).toContain('Restoring…');
  });
});

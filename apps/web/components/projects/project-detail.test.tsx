import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ProjectArchiveCapability } from './model';
import { ProjectDetail } from './project-detail';

const CAPABLE: ProjectArchiveCapability = {
  canArchiveOwn: true,
  canArchiveOther: true,
  viewerPrincipalId: '44444444-4444-4444-8444-444444444444',
};

describe('ProjectDetail', () => {
  it('renders a loading state before its fetches resolve, rather than an empty settings form', () => {
    // `renderToStaticMarkup` never runs effects, so `GET /api/projects/:id` never fires here — this
    // is the screen's very first paint, the same one a browser shows before the network answers.
    const html = renderToStaticMarkup(<ProjectDetail id="11111111-1111-4111-8111-111111111111" />);
    expect(html).toContain('Loading project');
  });

  it('offers no lifecycle control while the project is still loading, whatever the capability', () => {
    // The section is inside the loaded branch, so a caller who may archive still sees nothing until
    // there is a project to archive — a control over an unread row would confirm over nothing.
    const html = renderToStaticMarkup(
      <ProjectDetail id="11111111-1111-4111-8111-111111111111" capability={CAPABLE} />,
    );
    expect(html).not.toContain('Archive project');
    expect(html).not.toContain('role="dialog"');
  });

  it('treats a missing capability prop as a refusal, never as permission', () => {
    // The default matters: a caller that mounts this screen without resolving capability must not
    // accidentally be granted the control (ADR-0015).
    const html = renderToStaticMarkup(<ProjectDetail id="11111111-1111-4111-8111-111111111111" />);
    expect(html).not.toContain('Archive project');
  });
});

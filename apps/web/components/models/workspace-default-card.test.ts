import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WorkspaceModelDefaultCard } from './workspace-default-card';

describe('WorkspaceModelDefaultCard', () => {
  it('names the field on the existing admin settings screen, honestly, without a control that would silently do nothing', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceModelDefaultCard));
    expect(html).toContain('Workspace default model');
    // No `<select>`/`<input>` that looks editable but has no write path behind it (ADR-0015: an
    // unavailable capability says so rather than pretending).
    expect(html).not.toContain('<select');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
  });

  it('explains the default in plain words, without internal terms', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceModelDefaultCard));
    expect(html).toContain('when neither the agent nor its project picks one');
    expect(html).not.toMatch(/ladder|rung|API route|layer/u);
  });
});

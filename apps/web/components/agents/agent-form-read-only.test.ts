import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ModelStep, PermissionsStep, ResourcesStep, RuntimeProfileStep } from './agent-form';

const noop = () => undefined;
const CONTROLS = /<(input|select|button|textarea)\b/u;

describe('readOnly steps', () => {
  it('ModelStep shows the chosen model and connection as text', () => {
    const html = renderToStaticMarkup(
      createElement(ModelStep, {
        models: [],
        unavailable: [{ connectionName: 'broken', reason: 'no key' }],
        value: { connectionId: 'anthropic', model: 'claude-sonnet-5' },
        onSelect: noop,
        readOnly: true,
      }),
    );
    expect(html).toContain('claude-sonnet-5');
    expect(html).toContain('anthropic');
    expect(html).not.toContain('broken');
    expect(html).not.toMatch(CONTROLS);
  });

  it('ModelStep says so when the deployment default is used', () => {
    const html = renderToStaticMarkup(
      createElement(ModelStep, {
        models: [],
        unavailable: [],
        value: null,
        onSelect: noop,
        readOnly: true,
      }),
    );
    expect(html).toContain('Deployment default');
  });

  it('RuntimeProfileStep shows only the selected profile', () => {
    const html = renderToStaticMarkup(
      createElement(RuntimeProfileStep, {
        profiles: [
          { id: 'a', name: 'Local default', driver: 'local' },
          { id: 'b', name: 'Docker locked', driver: 'docker' },
        ],
        selectedId: 'b',
        onSelect: noop,
        readOnly: true,
      }),
    );
    expect(html).toContain('Docker locked');
    expect(html).not.toContain('Local default');
    expect(html).not.toMatch(CONTROLS);
  });

  it('ResourcesStep lists only what is assigned, with file access', () => {
    const html = renderToStaticMarkup(
      createElement(ResourcesStep, {
        options: {
          files: [
            { id: 'f1', label: 'reports/' },
            { id: 'f2', label: 'receipts/' },
          ],
          skills: [{ id: 'triage', label: 'triage' }],
          connectors: [{ id: 'erp', label: 'erp' }],
        },
        fileAccess: { f2: 'read-write' },
        selectedSkills: new Set<string>(),
        selectedConnectors: new Set(['erp']),
        onFile: noop,
        onSkill: noop,
        onConnector: noop,
        readOnly: true,
      }),
    );
    expect(html).toContain('receipts/ (read/write)');
    expect(html).not.toContain('reports/');
    expect(html).not.toContain('triage');
    expect(html).toContain('erp');
    expect(html).toContain('None');
    expect(html).not.toMatch(CONTROLS);
  });

  it('PermissionsStep states each capability in words', () => {
    const html = renderToStaticMarkup(
      createElement(PermissionsStep, {
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: true,
          unrestrictedNetwork: false,
        },
        onChange: noop,
        readOnly: true,
      }),
    );
    expect(html).toContain('Read files');
    expect(html.match(/Not allowed/gu)).toHaveLength(2);
    expect(html.match(/>Allowed</gu)).toHaveLength(2);
    expect(html).not.toMatch(CONTROLS);
  });
});

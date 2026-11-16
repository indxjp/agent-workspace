import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ApiKeyRoleSelect,
  ApiKeyRow,
  Breadcrumbs,
  ConnectorNewScreen,
  ConnectorsScreen,
  FilePicker,
  FilesScreen,
  FileTable,
  formatModified,
  SkillDetailScreen,
  SkillsScreen,
  updateSkillSource,
  type FileRow,
} from './resource-screens';

describe('resource screens', () => {
  it('offers the owner role in the API Keys form only to a signed-in owner', () => {
    const render = (callerRole: unknown) =>
      renderToStaticMarkup(createElement(ApiKeyRoleSelect, { callerRole }));
    expect(render('owner')).toContain('value="owner"');
    for (const role of ['admin', 'builder', 'viewer', undefined]) {
      const html = render(role);
      expect(html).not.toContain('value="owner"');
      expect(html).toContain('value="admin"');
    }
  });

  it('shows a revoked API key as revoked, with no Revoke button (BH061-035)', () => {
    const render = (revoked: boolean) =>
      renderToStaticMarkup(
        createElement(ApiKeyRow, { name: 'k', prefix: 'ak_live_x', revoked, onRevoke: () => {} }),
      );
    expect(render(true)).toContain('Revoked');
    expect(render(true)).not.toContain('<button');
    expect(render(false)).toContain('>Revoke</button>');
  });

  it.each([
    [FilesScreen, 'Loading files…'],
    [SkillsScreen, 'Loading skills…'],
    [ConnectorsScreen, 'Loading connectors…'],
  ] as const)('distinguishes loading from an empty API result', (Screen, message) => {
    const html = renderToStaticMarkup(createElement(Screen));
    expect(html).toContain(message);
    expect(html).not.toContain('No files yet.');
    expect(html).not.toContain('No skills yet.');
    expect(html).not.toContain('No connectors yet.');
  });
});

describe('resource screens: connectors and skill detail', () => {
  it('offers every connector authentication mode and keeps the credential masked', () => {
    const html = renderToStaticMarkup(createElement(ConnectorNewScreen));
    expect(html).toContain('No authentication');
    expect(html).toContain('API key');
    expect(html).toContain('Bearer token');
    expect(html).toContain('OAuth token');
    // The secret input is rendered only after a user chooses an authenticated mode.
    expect(html).not.toContain('name="credential"');
  });

  it('does not invent skill detail before its workspace-scoped request resolves', () => {
    const html = renderToStaticMarkup(createElement(SkillDetailScreen, { name: 'reviewer' }));
    expect(html).toContain('Loading skill…');
    expect(html).not.toContain('Save changes');
  });
});

describe('resource screens: skill source frontmatter', () => {
  it('preserves allowed-tools and unknown frontmatter while editing instructions', () => {
    const source =
      '---\nname: old\ndescription: old\nallowed-tools: Read, Grep\nx-vendor: keep\n---\nold body\n';
    expect(updateSkillSource(source, 'new', 'New description', 'new body')).toBe(
      '---\nname: new\ndescription: New description\nallowed-tools: Read, Grep\nx-vendor: keep\n---\n\nnew body\n',
    );
  });

  it('writes frontmatter values as YAML that reads back, quoting what plain YAML would misread', () => {
    const quoted =
      '---\nname: kb\ndescription: "Use when: the user says \\"hi\\" # now"\n---\n\nbody\n';
    expect(updateSkillSource(quoted, 'kb', 'Use when: a # b', 'body')).toBe(
      '---\nname: kb\ndescription: "Use when: a # b"\n---\n\nbody\n',
    );
    expect(updateSkillSource('', 'null', '- leading\nnewline', 'x')).toBe(
      '---\nname: "null"\ndescription: "- leading\\nnewline"\n---\n\nx\n',
    );
    const folded = '---\nname: a\ndescription: >\n  folded\n  text\nx-keep: 1\n---\n\nb\n';
    expect(updateSkillSource(folded, 'a', 'plain words', 'b')).toBe(
      '---\nname: a\ndescription: plain words\nx-keep: 1\n---\n\nb\n',
    );
  });
});

describe('resource screens: the files screen', () => {
  it('does not render the empty-folder message while the files listing is still loading', () => {
    const html = renderToStaticMarkup(createElement(FilesScreen));
    expect(html).toContain('Loading files…');
    expect(html).not.toContain('This folder is empty.');
  });

  it('tells the uploader that a file reaches an agent only through a files() grant', () => {
    const html = renderToStaticMarkup(createElement(FilesScreen));
    expect(html).toContain('<code>files(&#x27;&lt;folder or file path&gt;&#x27;)</code>');
    expect(html).toContain('Chat attachments are not supported yet.');
  });

  it('renders a picker whose files listing is also distinguished from loading', () => {
    const html = renderToStaticMarkup(createElement(FilePicker, { onChange: () => {} }));
    expect(html).toContain('Loading files…');
    expect(html).not.toContain('This folder is empty.');
  });
});

describe('Breadcrumbs', () => {
  it('renders Home plus every segment, and disables Back at the root', () => {
    const html = renderToStaticMarkup(
      createElement(Breadcrumbs, { path: '', onNavigate: () => {} }),
    );
    expect(html).toContain('Home');
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>\s*Back/u);
  });

  it('renders every crumb of a nested path and enables Back', () => {
    const html = renderToStaticMarkup(
      createElement(Breadcrumbs, { path: 'contracts/2026-q3', onNavigate: () => {} }),
    );
    expect(html).toContain('contracts');
    expect(html).toContain('2026-q3');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>\s*Back/u);
  });
});

const file: FileRow = {
  id: 'file-1',
  path: 'contracts/agreement.pdf',
  kind: 'file',
  sizeBytes: 2048,
  contentType: 'application/pdf',
  lastModified: '2026-08-12T09:00:00.000Z',
};
const folder: FileRow = {
  id: 'folder-1',
  path: 'contracts',
  kind: 'folder',
  sizeBytes: null,
  contentType: null,
  lastModified: null,
};

describe('FileTable', () => {
  it('renders the explicit empty-folder state for an empty listing', () => {
    const html = renderToStaticMarkup(createElement(FileTable, { rows: [], onNavigate: () => {} }));
    expect(html).toContain('This folder is empty.');
    expect(html).not.toContain('<table');
  });

  it('offers Download for a file row and never for a folder row', () => {
    const html = renderToStaticMarkup(
      createElement(FileTable, {
        rows: [file, folder],
        onNavigate: () => {},
        onDelete: () => {},
        onRenameStart: () => {},
      }),
    );
    expect(html.match(/Download/gu) ?? []).toHaveLength(1);
    expect(html).toContain(`href="/api/files/`);
    // The folder's own name still renders, as a navigation control, just with no Download beside it.
    expect(html).toContain('contracts/');
  });

  it('renders metadata columns: type, formatted size, content type, and modified time', () => {
    const html = renderToStaticMarkup(
      createElement(FileTable, { rows: [file], onNavigate: () => {} }),
    );
    expect(html).toContain('2.0 KB');
    expect(html).toContain('application/pdf');
    expect(html).toContain(formatModified(file.lastModified, 'en'));
  });

  it('prints the modified time in the language it is given (UX-15)', () => {
    const html = renderToStaticMarkup(
      createElement(FileTable, { rows: [file], onNavigate: () => {}, locale: 'ja' }),
    );
    expect(html).toContain(formatModified(file.lastModified, 'ja'));
    expect(html).toContain('2026年');
    // <html> stays en, so the Japanese date says its own language.
    expect(html).toMatch(/<td lang="ja"[^>]*>2026年/u);
  });
});

describe('FileTable actions and selection', () => {
  it('renders no Actions column and no Download when neither rename nor delete is offered', () => {
    const html = renderToStaticMarkup(
      createElement(FileTable, { rows: [file], onNavigate: () => {} }),
    );
    expect(html).not.toContain('Download');
    expect(html).not.toContain('Actions');
  });

  it('replaces only the row being renamed with an editable destination field', () => {
    const other: FileRow = { ...file, id: 'file-2', path: 'contracts/other.pdf' };
    const html = renderToStaticMarkup(
      createElement(FileTable, {
        rows: [file, other],
        onNavigate: () => {},
        onDelete: () => {},
        onRenameStart: () => {},
        renaming: { id: file.id, value: file.path },
      }),
    );
    expect(html).toContain(`value="${file.path}"`);
    expect(html).toContain('Save');
    expect(html).toContain('Cancel');
    // The row not being renamed keeps its ordinary Rename control.
    expect(html).toContain('Rename');
  });

  it('checks exactly the selected rows in selection mode', () => {
    const html = renderToStaticMarkup(
      createElement(FileTable, {
        rows: [file, folder],
        onNavigate: () => {},
        selection: { selected: new Set([file.id]), onToggle: () => {} },
      }),
    );
    expect(html.match(/type="checkbox"/gu) ?? []).toHaveLength(2);
    expect(html).toContain('checked=""');
  });
});

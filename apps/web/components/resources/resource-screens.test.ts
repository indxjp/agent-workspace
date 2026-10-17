import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ApiKeyRoleSelect,
  ApiKeyRow,
  breadcrumbSegments,
  Breadcrumbs,
  canonicalizeFolderPath,
  ConnectorNewScreen,
  ConnectorsScreen,
  FilePicker,
  FilesScreen,
  FileTable,
  formatModified,
  formatSize,
  SkillDetailScreen,
  SkillsScreen,
  sortedRows,
  toFileRows,
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

  it('preserves allowed-tools and unknown frontmatter while editing instructions', () => {
    const source =
      '---\nname: old\ndescription: old\nallowed-tools: Read, Grep\nx-vendor: keep\n---\nold body\n';
    expect(updateSkillSource(source, 'new', 'New description', 'new body')).toBe(
      '---\nname: new\ndescription: New description\nallowed-tools: Read, Grep\nx-vendor: keep\n---\n\nnew body\n',
    );
  });

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

describe('canonicalizeFolderPath', () => {
  it('passes through an ordinary nested path unchanged', () => {
    expect(canonicalizeFolderPath('a/b/c')).toBe('a/b/c');
  });

  it('treats null, undefined and the empty string as the root', () => {
    expect(canonicalizeFolderPath(null)).toBe('');
    expect(canonicalizeFolderPath(undefined)).toBe('');
    expect(canonicalizeFolderPath('')).toBe('');
  });

  it('drops "." segments', () => {
    expect(canonicalizeFolderPath('a/./b')).toBe('a/b');
  });

  // Verifier attack 1: hand-editing the URL to a traversal, an absolute path, or a
  // percent-encoded dot-segment must never leave as a request containing a traversal — it is
  // clamped inside the workspace instead of being forwarded as-is.
  it('clamps a "../../../" climb at the root rather than escaping it', () => {
    expect(canonicalizeFolderPath('a/b/../../../etc')).toBe('etc');
  });

  it('clamps a lone ".." at the root to the empty (root) path', () => {
    expect(canonicalizeFolderPath('..')).toBe('');
    expect(canonicalizeFolderPath('../../..')).toBe('');
  });

  it('treats a leading "/" as relative to the workspace root, not as an absolute path', () => {
    expect(canonicalizeFolderPath('/absolute/path')).toBe('absolute/path');
  });

  it('resolves a percent-encoded dot-segment the same way as a literal one', () => {
    expect(canonicalizeFolderPath('a/b/%2e%2e/')).toBe('a');
  });

  it('keeps a malformed percent-encoding as a literal, harmless segment rather than throwing', () => {
    expect(canonicalizeFolderPath('a/50%/b')).toBe('a/50%/b');
  });

  it('never returns a path containing a "." or ".." segment, for a battery of hostile inputs', () => {
    const hostile = [
      'a/b/../../../etc',
      '../../../../etc/passwd',
      '/etc/passwd',
      'a/../../b',
      '%2e%2e/%2e%2e/root',
      'a/./././b',
    ];
    for (const raw of hostile) {
      const result = canonicalizeFolderPath(raw);
      expect(result.split('/')).not.toContain('..');
      expect(result.split('/')).not.toContain('.');
      expect(result.startsWith('/')).toBe(false);
    }
  });
});

describe('breadcrumbSegments', () => {
  it('is empty at the root', () => {
    expect(breadcrumbSegments('')).toEqual([]);
  });

  it('accumulates the path up to each segment', () => {
    expect(breadcrumbSegments('a/b/c')).toEqual([
      { name: 'a', path: 'a' },
      { name: 'b', path: 'a/b' },
      { name: 'c', path: 'a/b/c' },
    ]);
  });
});

describe('Breadcrumbs', () => {
  it('renders Home plus every segment, and disables Back at the root', () => {
    const html = renderToStaticMarkup(
      createElement(Breadcrumbs, { path: '', onNavigate: () => {} }),
    );
    expect(html).toContain('Home');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Back/u);
  });

  it('renders every crumb of a nested path and enables Back', () => {
    const html = renderToStaticMarkup(
      createElement(Breadcrumbs, { path: 'contracts/2026-q3', onNavigate: () => {} }),
    );
    expect(html).toContain('contracts');
    expect(html).toContain('2026-q3');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>\s*Back/u);
  });
});

describe('formatSize', () => {
  it('renders an em dash for an unknown size', () => {
    expect(formatSize(null)).toBe('—');
  });

  it('renders sub-kilobyte sizes in bytes', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
  });

  it('renders one decimal place under 10 units, none at or above it', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(10240)).toBe('10 KB');
  });

  it('climbs units for a megabyte-sized file', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
  });
});

describe('formatModified', () => {
  it('renders an em dash for a folder (no lastModified)', () => {
    expect(formatModified(null)).toBe('—');
  });

  it('renders a UTC timestamp without a locale/timezone dependency', () => {
    expect(formatModified('2026-09-11T10:15:30.000Z')).toBe('2026-09-11 10:15 UTC');
  });

  it('falls back to the raw string when it is not the expected ISO shape', () => {
    expect(formatModified('not-a-date')).toBe('not-a-date');
  });
});

describe('toFileRows and sortedRows', () => {
  it('narrows the loosely-typed API body and defaults a missing kind to "file"', () => {
    const rows = toFileRows({
      files: [
        { id: '1', path: 'a.txt', sizeBytes: 3, contentType: 'text/plain', lastModified: 'x' },
        { id: '2', path: 'sub', kind: 'folder' },
        'not-an-object',
      ],
    });
    expect(rows).toEqual([
      {
        id: '1',
        path: 'a.txt',
        kind: 'file',
        sizeBytes: 3,
        contentType: 'text/plain',
        lastModified: 'x',
      },
      {
        id: '2',
        path: 'sub',
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      },
    ]);
  });

  it('returns no rows when "files" is missing or not an array', () => {
    expect(toFileRows({})).toEqual([]);
    expect(toFileRows({ files: 'nope' })).toEqual([]);
  });

  it('sorts folders before files, each group alphabetically by name', () => {
    const unsorted: FileRow[] = [
      {
        id: '1',
        path: 'zeta.txt',
        kind: 'file',
        sizeBytes: 0,
        contentType: null,
        lastModified: null,
      },
      {
        id: '2',
        path: 'beta',
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      },
      {
        id: '3',
        path: 'alpha.txt',
        kind: 'file',
        sizeBytes: 0,
        contentType: null,
        lastModified: null,
      },
      {
        id: '4',
        path: 'alpha',
        kind: 'folder',
        sizeBytes: null,
        contentType: null,
        lastModified: null,
      },
    ];
    expect(sortedRows(unsorted).map((row) => row.path)).toEqual([
      'alpha',
      'beta',
      'alpha.txt',
      'zeta.txt',
    ]);
  });
});

describe('FileTable', () => {
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
    expect(html).toContain('2026-08-12 09:00 UTC');
  });

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

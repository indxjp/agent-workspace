import { describe, expect, it } from 'vitest';

import { ProjectRenderError } from './errors.js';
import { renderTemplateDirectory } from './template.js';

const FIXTURE = new URL('./__fixtures__/template/', import.meta.url);
const VALUES = { name: 'demo', version: '1.2.3' };

describe('renderTemplateDirectory', () => {
  it('renders every file, sorted, with path and text tokens replaced and inert suffixes dropped', () => {
    const files = renderTemplateDirectory(FIXTURE, VALUES, 'the fixture');

    expect(files.map((file) => file.path)).toEqual(['README.md', 'demo.txt', 'docs/greeting.ts']);
    expect(files.find((file) => file.path === 'demo.txt')?.contents).toBe(
      'name: demo\nversion: 1.2.3\n',
    );
    expect(files.find((file) => file.path === 'docs/greeting.ts')?.contents).toBe(
      'export const greeting = "hello demo";\n',
    );
  });

  it("re-aligns a README's file map after the substitution", () => {
    const readme = renderTemplateDirectory(FIXTURE, VALUES, 'the fixture').find(
      (file) => file.path === 'README.md',
    );

    expect(readme?.contents).toBe(
      '# demo\n\n```text\ndemo.txt          the settings\ndocs/greeting.ts  the greeting\n```\n',
    );
  });

  it('returns frozen files', () => {
    const files = renderTemplateDirectory(FIXTURE, VALUES, 'the fixture');

    expect(Object.isFrozen(files)).toBe(true);
    expect(files.every((file) => Object.isFrozen(file))).toBe(true);
  });

  it('refuses a placeholder with no value, naming the key and the subject', () => {
    const render = (): unknown => renderTemplateDirectory(FIXTURE, { name: 'demo' }, 'the fixture');

    expect(render).toThrow(ProjectRenderError);
    expect(render).toThrow(
      expect.objectContaining({
        message: 'the fixture could not be rendered: version: is required: the template uses it',
        issues: [{ path: 'version', message: 'is required: the template uses it' }],
      }),
    );
  });

  it("passes the caller's message for a missing key through", () => {
    expect(() =>
      renderTemplateDirectory(FIXTURE, { name: 'demo' }, 'the project', {
        missingMessage: (key) => `${key} is pinned`,
      }),
    ).toThrow('the project could not be rendered: version: version is pinned');
  });

  it('does not read an inherited property as a value', () => {
    const values = Object.assign(
      Object.create({ version: 'inherited' }) as Record<string, string>,
      {
        name: 'demo',
      },
    );

    expect(() => renderTemplateDirectory(FIXTURE, values, 'the fixture')).toThrow(
      ProjectRenderError,
    );
  });

  it('renders no files for a missing optional directory', () => {
    const missing = new URL('./__fixtures__/no-such-template/', import.meta.url);

    expect(renderTemplateDirectory(missing, VALUES, 'the fixture', { optional: true })).toEqual([]);
  });

  it('throws the file-system error for a missing directory that is not optional', () => {
    const missing = new URL('./__fixtures__/no-such-template/', import.meta.url);

    expect(() => renderTemplateDirectory(missing, VALUES, 'the fixture')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });
});

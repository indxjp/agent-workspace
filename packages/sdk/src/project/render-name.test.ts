import { expect, it } from 'vitest';

import { projectNameFor } from './render.js';
import { renderError } from './render.test-support.js';

it.each([
  ['my-project', 'my-project'],
  ['My Project', 'my-project'],
  ['  Acme__AI  Bot!! ', 'acme-ai-bot'],
  ['café', 'caf'],
  ['--', 'agent-workspace'],
  ['', 'agent-workspace'],
  ['日本語', 'agent-workspace'],
])('names %j as %j', (directory, name) => {
  expect(projectNameFor(directory)).toBe(name);
});

it('refuses a directory name that is not text with a ProjectRenderError', () => {
  const missing: unknown = undefined;
  const error = renderError(() => projectNameFor(missing as string));
  expect(error.issues).toStrictEqual([{ path: '(root)', message: 'must be text' }]);
});

it('cuts a long name to 64 characters with no hyphen at the end', () => {
  const name = projectNameFor(`${'a'.repeat(63)} b${'c'.repeat(40)}`);
  expect(name).toBe('a'.repeat(63));
  expect(name.length).toBeLessThanOrEqual(64);
  expect(projectNameFor('x'.repeat(100))).toBe('x'.repeat(64));
});

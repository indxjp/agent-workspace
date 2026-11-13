import { expect, it } from 'vitest';
import { moduleResourceName } from './gcp-lifecycle.js';

it('keeps the service account ids it makes within the 30 characters Google allows', () => {
  const name = moduleResourceName('a-project-name-of-twenty-two-or-more');
  expect(name).toHaveLength(19);
  expect(`${name}-runner-mgr`.length).toBeLessThanOrEqual(30);
});

it('gives two long names with the same first 19 characters different names', () => {
  const first = moduleResourceName('acme-customer-support-bot');
  const second = moduleResourceName('acme-customer-support-dev');
  expect(first).not.toBe(second);
  expect(first).toMatch(/^acme-customer-[0-9a-f]{4}$/u);
  expect(moduleResourceName('x')).not.toBe(moduleResourceName('y'));
});

it.each([
  ['acme-ai', 'acme-ai'],
  ['a-very-long-project-name-indeed', 'a-very-long-pr-d863'],
  ['x', 'x-2d71'],
  ['9lives', 'agent-ws-bc86'],
])('derives the module name of project %s as %s', (projectName, expected) => {
  expect(moduleResourceName(projectName)).toBe(expected);
});

it('never derives a name starting rt-, which would put the stack inside the sandbox IAM grants', () => {
  for (const projectName of ['rt-tool-demo', 'rt-a', 'rt-a-very-long-project-name']) {
    const name = moduleResourceName(projectName);
    expect(name.startsWith('rt-')).toBe(false);
    expect(name).toMatch(/^agent-ws-[0-9a-f]{4}$/u);
  }
});

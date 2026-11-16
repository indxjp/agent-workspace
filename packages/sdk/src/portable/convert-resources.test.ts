import { expect, it } from 'vitest';

import {
  defineAgent,
  defineSurface,
  files,
  mcp,
  skill,
  toAgentVersionBody,
} from '../define/index.js';
import { portableFromAgentVersionBody, toPortableAgent } from './index.js';
import { PROJECT, MINIMAL, bodyWith } from './convert.fixture.test-support.js';

const skilled = defineAgent({ ...MINIMAL, skills: [skill('a-one'), skill('b-two')] });
const skilledBody = toAgentVersionBody(skilled);

it('skills: each assigned skill the allowlist keeps lands at skills/<name>', () => {
  expect(portableFromAgentVersionBody(skilledBody).value.skills).toEqual([
    { name: 'a-one', path: 'skills/a-one' },
    { name: 'b-two', path: 'skills/b-two' },
  ]);
});

it("skills: mode 'all' keeps every assigned skill", () => {
  const body = bodyWith(skilledBody, {
    policy: { ...skilledBody.definition.policy, skills: { mode: 'all' } },
  });
  const { value, dropped } = portableFromAgentVersionBody(body);
  expect(value.skills.map((entry) => entry.name)).toEqual(['a-one', 'b-two']);
  expect(dropped).toEqual([]);
});

it('skills: an assigned skill the allowlist excludes is dropped', () => {
  const body = bodyWith(skilledBody, {
    policy: {
      ...skilledBody.definition.policy,
      skills: { mode: 'allowlist', names: ['b-two'] },
    },
  });
  const { value, dropped } = portableFromAgentVersionBody(body);
  expect(value.skills).toEqual([{ name: 'b-two', path: 'skills/b-two' }]);
  expect(dropped).toEqual([
    {
      path: 'definition.resources.skills.0',
      reason: "the policy's skill allowlist excludes it",
    },
  ]);
});

it('files: each workspace file grant is dropped at its index', () => {
  const agent = defineAgent({
    ...MINIMAL,
    files: [files('docs/a.md'), files('docs/b.md', 'read-write')],
  });
  expect(toPortableAgent(agent).dropped).toEqual([
    {
      path: 'definition.resources.files.0',
      reason: 'workspace file grants are Agent Workspace resources',
    },
    {
      path: 'definition.resources.files.1',
      reason: 'workspace file grants are Agent Workspace resources',
    },
  ]);
});

it('files: a grant a knowledge source names is carried, not dropped', () => {
  const agent = defineAgent({
    ...MINIMAL,
    files: [files('docs/a.md'), files('docs/b.md')],
    knowledge: [{ kind: 'files', paths: ['docs/a.md', 'docs/c.md'] }],
  });
  const { value, dropped } = toPortableAgent(agent);
  expect(value.knowledge).toEqual([{ kind: 'files', paths: ['docs/a.md', 'docs/c.md'] }]);
  expect(dropped).toEqual([
    {
      path: 'definition.resources.files.1',
      reason: 'workspace file grants are Agent Workspace resources',
    },
  ]);
});

it('files: a read-write grant a knowledge source names is carried as access read-write', () => {
  const agent = defineAgent({
    ...MINIMAL,
    files: [files('docs/a.md', 'read-write')],
    knowledge: [{ kind: 'files', paths: ['docs/a.md'] }],
  });
  const { value, dropped } = toPortableAgent(agent);
  expect(value.knowledge).toEqual([{ kind: 'files', paths: ['docs/a.md'], access: 'read-write' }]);
  expect(dropped).toEqual([]);
});

it('files: a source mixing read and read-write grants splits, read first', () => {
  const agent = defineAgent({
    ...MINIMAL,
    files: [files('docs/a.md', 'read-write'), files('docs/b.md')],
    knowledge: [{ kind: 'files', paths: ['docs/a.md', 'docs/b.md', 'docs/c.md'] }],
  });
  expect(toPortableAgent(agent).value.knowledge).toEqual([
    { kind: 'files', paths: ['docs/b.md', 'docs/c.md'] },
    { kind: 'files', paths: ['docs/a.md'], access: 'read-write' },
  ]);
});

it('description, subagents, knowledge: are carried', () => {
  const agent = defineAgent({
    ...MINIMAL,
    description: 'Answers billing questions.',
    subagents: ['billing', 'refunds'],
    tools: [mcp('plain')],
    knowledge: [{ kind: 'connector', name: 'plain' }],
  });
  const { value, dropped } = toPortableAgent(agent, { project: PROJECT });
  expect(dropped).toEqual([]);
  expect(value.description).toBe('Answers billing questions.');
  expect(value.subagents).toEqual([{ name: 'billing' }, { name: 'refunds' }]);
  expect(value.knowledge).toEqual([{ kind: 'connector', name: 'plain' }]);
  expect(value.tools).toHaveLength(1);
});

it('subagents: a name that is not lower-case kebab is dropped at its index', () => {
  const agent = defineAgent({ ...MINIMAL, subagents: ['Billing Team', 'refunds'] });
  const { value, dropped } = toPortableAgent(agent);
  expect(value.subagents).toEqual([{ name: 'refunds' }]);
  expect(dropped).toEqual([
    { path: 'subagents.0', reason: 'rename the subagent to lower-case kebab to export it' },
  ]);
});

it('knowledge: a source the portable schema refuses is dropped at its index', () => {
  const agent = defineAgent({
    ...MINIMAL,
    knowledge: [{ kind: 'files', paths: ['../outside.md'] }],
    files: [files('../outside.md')],
  });
  const { value, dropped } = toPortableAgent(agent);
  expect(value.knowledge).toEqual([]);
  expect(dropped.map((entry) => entry.path)).toContain('knowledge.0');
});

it('surfaces: each surface is dropped at its index', () => {
  const surface = defineSurface({ name: 'main', agent: 'assistant' });
  const { dropped } = toPortableAgent(defineAgent(MINIMAL), { surfaces: [surface] });
  expect(dropped).toEqual([
    { path: 'surfaces.0', reason: 'surfaces are served by Agent Workspace' },
  ]);
});

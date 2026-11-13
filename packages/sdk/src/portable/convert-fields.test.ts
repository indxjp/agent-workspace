import { describe, expect, it } from 'vitest';
import { type AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

import { defineAgent, toAgentVersionBody } from '../define/index.js';
import { portableFromAgentVersionBody, toPortableAgent } from './index.js';
import {
  openai,
  ALL_PERMISSIONS,
  PROJECT,
  MINIMAL,
  SAMPLE_PERMISSIONS,
  BASE_BODY,
  bodyWith,
  thrown,
} from './convert.fixture.test-support.js';

describe('portableFromAgentVersionBody: body fields', () => {
  it('name: carries a lower-kebab name', () => {
    expect(toPortableAgent(defineAgent(MINIMAL)).value.name).toBe('assistant');
  });

  it('name: refuses a name that is not lower-kebab, at definition.agent.name', () => {
    const agent = defineAgent({ ...MINIMAL, name: 'Support Triage' });
    const error = thrown(() => toPortableAgent(agent));
    expect(error.message).toContain('toPortableAgent()');
    expect(error.issues).toEqual([
      {
        path: 'definition.agent.name',
        message: 'rename the agent to lower-case kebab (1-64 characters) to export it',
      },
    ]);
    const fromBody = thrown(() => portableFromAgentVersionBody(toAgentVersionBody(agent)));
    expect(fromBody.message).toContain('portableFromAgentVersionBody()');
    expect(fromBody.issues[0]?.path).toBe('definition.agent.name');
  });

  it('body: refuses a body that does not parse, under the entry point named', () => {
    const malformed: AgentVersionBody = {
      ...BASE_BODY,
      definition: {
        ...BASE_BODY.definition,
        agent: { ...BASE_BODY.definition.agent, name: '' },
      },
    };
    const error = thrown(() => portableFromAgentVersionBody(malformed));
    expect(error.message).toContain('portableFromAgentVersionBody()');
    expect(error.issues.length).toBeGreaterThan(0);
  });

  it('toPortableAgent: re-throws what toAgentVersionBody refuses under its own subject', () => {
    const agent = defineAgent({ ...MINIMAL, instructions: { file: './instructions.md' } });
    const error = thrown(() => toPortableAgent(agent));
    expect(error.message).toContain('toPortableAgent()');
    expect(error.message).not.toContain('toAgentVersionBody()');
    expect(error.issues[0]?.path).toBe('agent.instructions');
  });

  it('instructions: are carried verbatim', () => {
    const text = 'Line one.\n\n  Indented, with "quotes" and a trailing space. ';
    expect(
      toPortableAgent(defineAgent({ ...MINIMAL, instructions: text })).value.instructions,
    ).toBe(text);
  });

  it('permissions: carries the four switches', () => {
    const { value } = toPortableAgent(defineAgent({ ...MINIMAL, permissions: SAMPLE_PERMISSIONS }));
    expect(value.permissions).toEqual(SAMPLE_PERMISSIONS);
  });

  it('permissions: a withheld switch of a stored arm is exported off, not widened', () => {
    const base = toAgentVersionBody(
      defineAgent({ ...MINIMAL, engine: openai, permissions: ALL_PERMISSIONS }),
    );
    const body = bodyWith(base, {
      policy: { ...base.definition.policy, withheldPermissions: ['writeFiles'] },
    });
    expect(base.definition.agent.permissions.writeFiles).toBe(true);
    expect(portableFromAgentVersionBody(body).value.permissions).toEqual({
      ...ALL_PERMISSIONS,
      writeFiles: false,
    });
  });

  it('permissions: a compiled policy never narrows them', () => {
    const base = toAgentVersionBody(defineAgent({ ...MINIMAL, permissions: ALL_PERMISSIONS }));
    expect(base.definition.policySource).toBe('compiled');
    expect(portableFromAgentVersionBody(base).value.permissions).toEqual(ALL_PERMISSIONS);
  });

  it('model: a model id with a known connection carries its provider', () => {
    const agent = defineAgent({ ...MINIMAL, model: { connection: 'claude-eu', id: 'm-1' } });
    expect(toPortableAgent(agent, { project: PROJECT }).value.model).toEqual({
      provider: 'anthropic',
      id: 'm-1',
    });
  });

  it('model: a model id with an unknown connection leaves the provider out', () => {
    const agent = defineAgent({ ...MINIMAL, model: { connection: 'nowhere', id: 'm-1' } });
    const { value, dropped } = toPortableAgent(agent, { project: PROJECT });
    expect(value.model).toEqual({ id: 'm-1' });
    expect(dropped).toEqual([]);
  });

  it('model: a connection name that is an Object.prototype key resolves to nothing', () => {
    const agent = defineAgent({ ...MINIMAL, model: { connection: 'constructor', id: 'm-1' } });
    expect(toPortableAgent(agent, { project: PROJECT }).value.model).toEqual({ id: 'm-1' });
  });

  it("model: no model, or the 'default' connection, is absent with no drop", () => {
    for (const model of [undefined, 'default'] as const) {
      const result = toPortableAgent(defineAgent({ ...MINIMAL, model }));
      expect(result.value.model).toBeUndefined();
      expect(result.dropped).toEqual([]);
    }
  });

  it('model: a named connection with no model id is dropped, with the connection named', () => {
    const { value, dropped } = toPortableAgent(defineAgent({ ...MINIMAL, model: 'anthropic' }), {
      project: PROJECT,
    });
    expect(value.model).toBeUndefined();
    expect(dropped).toEqual([
      {
        path: 'definition.agent.model',
        reason:
          'the model connection "anthropic" names no model id; set model: { connection, id } to export it',
      },
    ]);
  });

  it('runtimeProfileName: a named profile is dropped', () => {
    const body = bodyWith(BASE_BODY, {
      agent: { ...BASE_BODY.definition.agent, runtimeProfileName: 'gpu' },
    });
    expect(portableFromAgentVersionBody(body).dropped).toEqual([
      {
        path: 'definition.agent.runtimeProfileName',
        reason: 'runtime profiles are Agent Workspace resources',
      },
    ]);
  });
});

import { format, resolveConfig } from 'prettier';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';

import {
  agentFromVersionBody,
  defineAgent,
  files,
  mcp,
  skill,
  toAgentVersionBody,
  type DefineAgentInput,
} from '../define/index.js';
import { printAgentProject } from './index.js';

/** Recorded so a failure replays: `fc.assert` prints the seed and path of a counterexample too. */
const SEED = 20_261_025;
const RUNS = 200;
const CONFIG_FROM = new URL('../../../../package.json', import.meta.url).pathname;

const name = fc.stringMatching(/^[a-z][a-z0-9]{0,10}(-[a-z0-9]{1,6}){0,2}$/u);
const text = fc.string({ minLength: 1, maxLength: 160, unit: 'binary' });

/** The agents the printer can write: every part of a body `defineAgent()` accepts and holds. */
const agentInput = fc
  .record({
    name,
    instructions: text,
    description: fc.option(text, { nil: undefined }),
    model: fc.option(fc.record({ connection: fc.constant('default'), id: text }), {
      nil: undefined,
    }),
    permissions: fc.option(
      fc.record({ readFiles: fc.boolean(), writeFiles: fc.boolean(), runCommands: fc.boolean() }),
      { nil: undefined },
    ),
    connectors: fc.uniqueArray(name, { maxLength: 3 }),
    skills: fc.uniqueArray(
      fc.record({
        name,
        revision: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: undefined }),
      }),
      { maxLength: 3, selector: (entry) => entry.name },
    ),
    grants: fc.uniqueArray(
      fc.record({
        path: fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,12}(\/[a-z0-9_-]{1,12}){0,8}$/u),
        access: fc.constantFrom('read', 'read-write'),
      }),
      { maxLength: 3, selector: (entry) => entry.path },
    ),
  })
  .map(({ connectors, skills, grants, ...rest }): DefineAgentInput => {
    const input: DefineAgentInput = {
      ...rest,
      tools: connectors.map((connector) => mcp(connector)),
      skills: skills.map((entry) =>
        skill(entry.name, entry.revision === undefined ? {} : { revision: entry.revision }),
      ),
      files: grants.map((grant) => files(grant.path, grant.access)),
    };
    return input;
  });

describe('printAgentProject properties [US-BLD-06][unit][sdk]', () => {
  it(`writes every printable agent as prettier-clean TypeScript (${RUNS} runs, seed ${SEED})`, async () => {
    const options = await resolveConfig(CONFIG_FROM);
    await fc.assert(
      fc.asyncProperty(agentInput, async (input) => {
        const agent = defineAgent(input);
        const body = AgentVersionBodySchema.parse(toAgentVersionBody(agent));
        const connectors = Object.fromEntries(
          body.definition.resources.connectors.map((connector) => [
            connector,
            { url: 'https://hub.example.test/mcp' },
          ]),
        );
        const source = { body, project: { connectors } };

        expect(agentFromVersionBody(source).dropped).toStrictEqual([]);
        const printed = printAgentProject(source);
        expect(printAgentProject(source)).toStrictEqual(printed);
        expect(printed.files[1]?.text).toBe(body.definition.agent.instructions);
        const code = printed.files[0]?.text ?? '';
        expect(await format(code, { ...options, filepath: 'agents/x.ts' })).toBe(code);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
});

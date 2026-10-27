import { RunRequest } from '@agent-workspace/run-protocol';
// ENG-04 (#303): `compileRunRequest` is one engine's compile step and moved into that engine's
// adapter. ENG-04b (#325) moved the Claude *tool mapping* and the tenant session scope's
// `configDir` in after it, so two more of this family's vector files are replayed here rather than
// in `apps/web/formal/run-compose.test.ts`. The vectors themselves are unchanged, and that is the
// point — the refinement theorem this suite replays is "the Claude adapter produces what compose
// produced", so a vector that had to change would have been a behaviour change rather than a move.
import {
  claudeSessionScope,
  compileClaudeToolPolicy,
  compileRunRequest,
} from '@agent-workspace/engine-claude-agent-sdk/testing';
import { AgentPermissionsSchema, AgentPolicyLimitsSchema } from '@indx-workspace/contracts/agents';
import { EngineIdSchema } from '@indx-workspace/contracts/engines';
import {
  meetPolicyCeiling,
  policyWidenings,
  ProjectPolicySchema,
} from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const environmentVectors = loadVectors('run-compose', 'environment.json');
const toolVectors = loadVectors('run-compose', 'tools.json');
const sandboxVectors = loadVectors('run-compose', 'sandbox.json');
const ceilingVectors = loadVectors('run-compose', 'ceiling.json');

const portable = {
  name: 'Formal compose',
  instructions: '',
  model: null,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  skills: { mode: 'allowlist', names: [] },
  mcpServers: {},
  limits: { maxTurns: null, maxBudgetUsd: null },
} as const;

/** The engine arm compose composes for an agent whose stored policy narrows two tools. */
const policy = {
  tools: {
    base: ['Read'],
    autoApprove: [],
    deny: ['Write', 'Bash'],
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
  },
  fileGrantDeny: [],
} as const;

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name}: expected boolean`);
  return value;
}

describe('run-compose: real SDK option environment', () => {
  it.each(environmentVectors)('$id', ({ id, input, expected }) => {
    const env = asRecord(input, id);
    const candidate = {
      runId: '6f1d0d0a-8b0a-4a1f-9b3e-1c2d3e4f5a6b',
      sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e',
      // The vector's `CLAUDE_CONFIG_DIR` is this `cwd` plus the adapter's own configuration
      // directory. Since ENG-04b the adapter *derives* it rather than receiving it, so the vector
      // names the sandbox root and the derivation supplies the rest.
      cwd: '/run/claude/tenant-a',
      prompt: 'go',
      projectKey: 'tenant-a',
      portable,
      policy,
      session: { kind: 'fresh', sessionId: '2b0f5f2a-91a4-4a0e-9a1a-9f7a1b2c3d4e' },
      env,
    };
    const expectedEnv = asRecord(expected, id)['env'];
    if (expectedEnv === null) {
      expect(() => compileRunRequest(RunRequest.parse(candidate))).toThrow(/ANTHROPIC_API_KEY/iu);
    } else {
      expect(compileRunRequest(RunRequest.parse(candidate)).env).toEqual(expectedEnv);
    }
  });
});

describe('run-compose: permission-derived tool denials, in the adapter that now owns them', () => {
  it.each(toolVectors)('$id', ({ id, input, expected }) => {
    const flags = asRecord(input, id);
    const compiled = compileClaudeToolPolicy(
      {
        readFiles: boolean(flags['readFiles'], 'readFiles'),
        writeFiles: boolean(flags['writeFiles'], 'writeFiles'),
        runCommands: boolean(flags['runCommands'], 'runCommands'),
        unrestrictedNetwork: boolean(flags['unrestrictedNetwork'], 'unrestrictedNetwork'),
      },
      { stored: null, fileGrantDeny: [], mcpServers: {} },
    );
    // Byte-identical to what `apps/web/server/compose/run-request.ts`'s `toolPolicyFor` answered
    // before ENG-04b, for every vector in this file — which is the unit's refinement claim.
    expect(compiled.deny).toEqual(asRecord(expected, id)['deny']);
    expect(compiled.autoApprove).toEqual([]);
    expect(compiled.base).toBe('claude_code_preset');
    expect(compiled.permissionMode).toBe('default');
    expect(compiled.allowDangerouslySkipPermissions).toBe(false);
  });
});

describe("run-compose: the engine's own configuration directory, derived from the sandbox root", () => {
  it.each(sandboxVectors)('$id', ({ id, expected }) => {
    const result = asRecord(expected, id)['result'];
    // A session id compose refuses never reaches an engine, so the refusal half of this vector is
    // replayed in `apps/web/formal/run-compose.test.ts` and this half is about the accepted ones.
    if (result === null) return;
    const cwd = asString(asRecord(result, id)['cwd'], 'cwd');
    const projectKey = asString(asRecord(result, id)['projectKey'], 'projectKey');
    const derived = claudeSessionScope(cwd, projectKey);
    expect(derived.ok).toBe(true);
    expect(derived.ok ? derived.scope.configDir : '').toBe(asRecord(result, id)['configDir']);
    expect(derived.ok ? derived.scope.projectKey : '').toBe(projectKey);
  });
});

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((item, index) => asString(item, `${what}[${String(index)}]`));
}

// S2-04c: `meetRunCeiling` is `meetPolicyCeiling` then `policyWidenings`, and the met permissions
// reach the Claude adapter, which puts the stored arm's denials first.
describe('run-compose: compose meets the policy ceiling', () => {
  it.each(ceilingVectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const { model } = request;
    const ceiling =
      request['ceiling'] === null ? null : ProjectPolicySchema.parse(request['ceiling']);
    const met = meetPolicyCeiling(
      {
        permissions: AgentPermissionsSchema.parse(request['permissions']),
        limits: AgentPolicyLimitsSchema.parse(request['limits']),
        engine: EngineIdSchema.parse(request['engine']),
        model: model === null ? null : asString(model, `${id}.model`),
        tools: strings(request['tools'], `${id}.tools`),
      },
      ceiling,
    );
    const refused = policyWidenings(met, ceiling);
    const deny = compileClaudeToolPolicy(met.permissions, {
      stored: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: strings(request['storedDeny'], `${id}.storedDeny`),
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      fileGrantDeny: [],
      mcpServers: {},
    }).deny;
    expect({
      result: refused.length === 0 ? 'ok' : 'refused',
      details: refused,
      permissions: met.permissions,
      limits: met.limits,
      tools: met.tools,
      deny,
    }).toStrictEqual(expected);
  });
});

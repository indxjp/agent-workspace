/**
 * `engine-compose`: the two halves ENG-04b (#325) moved behind the port, replayed against the real
 * TypeScript.
 *
 * `tool-policy.json` carries **both** answers for each input — what compose produced before the
 * move and what the adapter compiles now — so the replay states the refinement rather than one side
 * of it: the adapter's compiled policy is asserted against `expected.target`, and `expected.target`
 * is asserted equal to `expected.current`. A vector whose two sides had drifted apart would fail
 * here even if the adapter agreed with one of them.
 *
 * `skills.json` carries the placement verdict every adapter's `placeSkills` is held to.
 *
 * Under D-012 this file is in `tests/formal/` rather than under an application's own `formal/`
 * directory: both subjects are reached through a package's public exports.
 */
import {
  skillPlacementVerdict,
  type EngineSkillFile,
  type EngineSkillGrant,
} from '@agent-workspace/engine';
import {
  claudeFileGrantDenials,
  compileClaudeToolPolicy,
  type ClaudeToolPolicyInputs,
} from '@agent-workspace/engine-claude-agent-sdk';
import type { AgentPermissions, AgentToolPolicy } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const toolPolicyVectors = loadVectors('engine-compose', 'tool-policy.json');
const skillVectors = loadVectors('engine-compose', 'skills.json');

function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name}: expected boolean`);
  return value;
}

function strings(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${name}: expected an array of strings`);
  }
  return value as readonly string[];
}

function permissions(value: unknown, id: string): AgentPermissions {
  const record = asRecord(value, id);
  return {
    readFiles: bool(record['readFiles'], 'readFiles'),
    writeFiles: bool(record['writeFiles'], 'writeFiles'),
    runCommands: bool(record['runCommands'], 'runCommands'),
    unrestrictedNetwork: bool(record['unrestrictedNetwork'], 'unrestrictedNetwork'),
  };
}

/** The Lean model's `base: null` is the SDK's `claude_code` preset. */
function toolPolicy(value: unknown, id: string): AgentToolPolicy {
  const record = asRecord(value, id);
  const base = record['base'];
  return {
    base: base === null ? 'claude_code_preset' : strings(base, 'base'),
    autoApprove: strings(record['autoApprove'], 'autoApprove'),
    deny: strings(record['deny'], 'deny'),
    permissionMode: asString(
      record['permissionMode'],
      'permissionMode',
    ) as AgentToolPolicy['permissionMode'],
    allowDangerouslySkipPermissions: bool(
      record['allowDangerouslySkipPermissions'],
      'allowDangerouslySkipPermissions',
    ),
  };
}

function grants(value: unknown, id: string): readonly { path: string; directory: boolean }[] {
  if (!Array.isArray(value)) throw new Error(`${id}: readOnly must be an array`);
  return value.map((entry, index) => {
    const record = asRecord(entry, `${id}.readOnly[${String(index)}]`);
    return {
      path: asString(record['path'], 'path'),
      directory: bool(record['directory'], 'directory'),
    };
  });
}

describe('engine-compose: the Claude tool policy the adapter compiles', () => {
  it.each(toolPolicyVectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const outcome = asRecord(expected, id);
    const cwd = asString(request['cwd'], 'cwd');
    const readOnly = grants(request['readOnly'], id);

    // The compose-side legacy guard's contribution, as the vector says the wire carried it.
    const derived = claudeFileGrantDenials(
      cwd,
      readOnly.map((grant) => ({
        kind: grant.directory ? ('directory' as const) : ('file' as const),
        path: grant.path,
        access: 'read' as const,
      })),
      '.claude',
    );
    if (!derived.ok) throw new Error(`${id}: the vector's own grants did not normalise`);
    const guarded = bool(request['guarded'], 'guarded');
    expect(guarded ? derived.deny : []).toEqual(
      strings(outcome['wireFileGrantDeny'], 'wireFileGrantDeny'),
    );

    const stored = request['stored'];
    const inputs: ClaudeToolPolicyInputs = {
      stored: stored === null ? null : toolPolicy(stored, id),
      // The adapter folds its own derivation in after whatever the wire carried, and de-duplicates
      // — so this is the request as `withFileGrants` hands it to the compile.
      fileGrantDeny: [...new Set([...(guarded ? derived.deny : []), ...derived.deny])],
      mcpServers: Object.fromEntries(
        strings(request['mcpServers'], 'mcpServers').map((name) => [name, {}]),
      ),
    };
    const compiled = compileClaudeToolPolicy(permissions(request['permissions'], id), inputs);

    expect(compiled).toEqual(toolPolicy(outcome['target'], id));
    // The refinement, stated by the vector itself: what the adapter compiles is what compose
    // produced before ENG-04b moved the mapping.
    expect(toolPolicy(outcome['target'], id)).toEqual(toolPolicy(outcome['current'], id));
  });
});

describe('engine-compose: where an adapter may place a skill', () => {
  it.each(skillVectors)('$id', ({ id, input, expected }) => {
    const request = asRecord(input, id);
    const outcome = asRecord(expected, id);
    const placements: EngineSkillFile[] = (
      Array.isArray(request['placements']) ? request['placements'] : []
    ).map((entry, index) => {
      const record = asRecord(entry, `${id}.placements[${String(index)}]`);
      return {
        skill: asString(record['skill'], 'skill'),
        path: asString(record['path'], 'path'),
        // The verdict never reads the bytes, so the vector does not carry any.
        contentBase64: '',
      };
    });
    const granted: EngineSkillGrant[] = (
      Array.isArray(request['grants']) ? request['grants'] : []
    ).map((entry, index) => {
      const record = asRecord(entry, `${id}.grants[${String(index)}]`);
      const files = record['files'];
      if (typeof files !== 'number') throw new Error(`${id}: grant.files must be a number`);
      return {
        name: asString(record['name'], 'name'),
        files: Array.from({ length: files }, (_, position) => ({
          path: `file-${String(position)}`,
          contentBase64: '',
        })),
      };
    });

    const verdict = skillPlacementVerdict(
      placements,
      granted,
      asString(request['configDirectory'], 'configDirectory'),
    );
    expect(verdict.ok ? verdict.files : null).toEqual(outcome['files']);
    expect(verdict.ok ? null : verdict.refusal).toEqual(outcome['refusal']);
  });
});

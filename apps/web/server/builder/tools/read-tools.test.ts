import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import {
  BUILDER_CHECK_FIXES,
  BUILDER_TOOL_FIXES,
  BuilderToolOutputSchemas,
} from '@indx-workspace/contracts/builder';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryAgentVersionStoreProvider } from '../../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { recordingCeilingFor } from '../../policy-ceiling/fixtures';
import { draftBody } from '../adapters/checker/checker.contract';
import { createChecker } from '../adapters/checker/production';
import { MemoryCatalog } from '../adapters/catalog/memory';
import { MemoryChecker } from '../adapters/checker/memory';
import { EXAMPLES } from '../examples';
import { handleToolCall } from '../index';
import { callContextOf } from '../testing/context';
import { BuilderAuthorization, makeMemoryPorts } from '../testing/ports';
import type { BuilderPorts } from './types';

const WORKSPACE = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const COMMANDS = new URL('../../../../../packages/aw/src/commands/', import.meta.url);
const SOURCES = readdirSync(COMMANDS).map((file) => readFileSync(new URL(file, COMMANDS), 'utf8'));

/** Each `&&` part of an awCommand names a command `packages/aw` registers. */
function registered(awCommand: string): boolean {
  return awCommand.split(' && ').every((part) => {
    // The command is the words before its first argument or flag.
    const words = /^aw ((?:[a-z]+(?: |$))+)/u.exec(part)?.[1]?.trim() ?? '';
    const pattern = new RegExp(String.raw`command\(\s*'${words}'`, 'u');
    return SOURCES.some((source) => pattern.test(source));
  });
}

const call = (name: string, args: unknown = {}) => ({
  name,
  arguments: args,
  callId: crypto.randomUUID(),
});

describe('the read tools through handleToolCall', () => {
  let ports: BuilderPorts;
  let agentId = '';
  beforeEach(() => {
    const authorization = new BuilderAuthorization();
    agentId = authorization.addAgent(WORKSPACE, OWNER);
    ports = makeMemoryPorts({
      authorization,
      catalog: new MemoryCatalog([
        { kind: 'connectors', id: 'c-1', name: 'crm' },
        { kind: 'skills', id: 's-1', name: 'summarise' },
      ]),
      checker: new MemoryChecker(
        new Set(['crm']),
        new Map([[agentId, { versions: 1, ownerPrincipalId: OWNER }]]),
      ),
    });
  });
  const builder = callContextOf(WORKSPACE, 'builder', OWNER);

  it('catalog_list: names and ids only, the asked kinds, their aw commands', async () => {
    const output = BuilderToolOutputSchemas.catalog_list.parse(
      await handleToolCall(
        call('catalog_list', { kinds: ['connectors', 'skills'] }),
        builder,
        ports,
      ),
    );
    expect(output.entries).toEqual([
      { kind: 'skills', id: 's-1', name: 'summarise' },
      { kind: 'connectors', id: 'c-1', name: 'crm' },
    ]);
    expect(output.awCommand).toBe('aw skills list && aw connectors list');
    const files = await handleToolCall(call('catalog_list', { kinds: ['files'] }), builder, ports);
    expect(BuilderToolOutputSchemas.catalog_list.parse(files).awCommand).not.toContain('aw files');
  });

  it('examples_get: ten names, one body by name, invalid_arguments for an unknown name', async () => {
    const list = BuilderToolOutputSchemas.examples_get.parse(
      await handleToolCall(call('examples_get'), builder, ports),
    );
    expect(list.names).toEqual(EXAMPLES.map((example) => example.name));
    expect(list.names).toHaveLength(10);
    const [first] = EXAMPLES;
    const one = await handleToolCall(call('examples_get', { name: first?.name }), builder, ports);
    expect(one).toMatchObject({ example: { name: first?.name, body: first?.body } });
    expect(
      await handleToolCall(call('examples_get', { name: 'nope' }), builder, ports),
    ).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      fix: BUILDER_TOOL_FIXES.unknownExample,
    });
  });

  it('draft_check: a missing connector by name, with the contracts fix', async () => {
    const result = await handleToolCall(
      call('draft_check', { body: draftBody('Refunds', ['erp']) }),
      builder,
      ports,
    );
    expect(result).toStrictEqual({
      ok: false,
      code: 'agent_definition_references_missing',
      message: 'The definition names resources this workspace does not have.',
      details: ['connector:erp'],
      fix: BUILDER_CHECK_FIXES.missingReferences,
    });
    expect(await ports.audit.runCounts(builder)).toEqual({ toolCalls: 1, failedChecksInARow: 1 });
  });

  it('draft_check: the checker forbidden passes through unchanged for a Viewer', async () => {
    const viewer = callContextOf(WORKSPACE, 'viewer');
    const body = draftBody('Refunds');
    const expected = await ports.checker.check(viewer, undefined, body);
    expect(expected).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await handleToolCall(call('draft_check', { body }), viewer, ports)).toStrictEqual(
      expected,
    );
  });

  it('every awCommand names a command packages/aw registers', async () => {
    const outputs = await Promise.all([
      handleToolCall(call('catalog_list'), builder, ports),
      handleToolCall(call('examples_get'), builder, ports),
      handleToolCall(call('draft_check', { body: draftBody('Refunds', ['crm']) }), builder, ports),
      handleToolCall(call('draft_check', { agentId, body: draftBody('Refunds') }), builder, ports),
    ]);
    expect(
      outputs.filter((output) => !('awCommand' in output) || !registered(output.awCommand)),
    ).toEqual([]);
  });
});

describe('draft_check never writes', () => {
  it('leaves agents, versions and audit rows as they were, and journals one row', async () => {
    const agents = createInMemoryAgentStoreProvider();
    const versions = createInMemoryAgentVersionStoreProvider({
      agents,
      references: { [WORKSPACE]: {} },
    });
    const ceiling = recordingCeilingFor({ permissions: { readFiles: false } });
    const checker = createChecker({
      agents,
      versions,
      pipeline: (ctx) => ({
        ceiling: ceiling.ceilingFor(new Request('https://web.test'), ctx.workspaceId),
      }),
    });
    const ports = makeMemoryPorts({ checker });
    const ctx = callContextOf(WORKSPACE, 'builder');

    const result = await handleToolCall(
      call('draft_check', { body: draftBody('Refunds') }),
      ctx,
      ports,
    );

    expect(result).toMatchObject({ ok: false, code: 'policy_cannot_widen' });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
    expect(versions.versionCount()).toBe(0);
    expect(ceiling.audit).toEqual([]);
    expect((await ports.audit.runCounts(ctx)).toolCalls).toBe(1);
  });
});

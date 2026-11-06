import { createHash } from 'node:crypto';

import { compileRunRequest } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { type AgentResourceAssignmentsInput } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';
import type { AgentPermissions } from '../../contracts/agents';

import { buildRunRequestFor } from './run-request';
import {
  ALL_ON,
  EMPTY_SHA256,
  GATEWAY,
  SESSION,
  SETTINGS,
  WORKSPACE,
  issued,
  launchContext,
  rowRunAgent,
} from './run-request.fixture.test-support';
export function registerResourcesCases() {
  describe('a fileScope narrows the agent’s file grants (issue #1539)', () => {
    const fileOf = (path: string) => ({
      kind: 'file' as const,
      path,
      access: 'read' as const,
      size: 0,
      sha256: EMPTY_SHA256,
    });
    const loader = {
      load: () =>
        Promise.resolve({
          files: [
            { kind: 'directory' as const, path: 'docs', access: 'read' as const },
            fileOf('docs/alice/a.md'),
            fileOf('docs/bob/b.md'),
          ],
          skills: [],
          mcpServers: {},
        }),
    };

    it('keeps only the files inside the scope in the request', async () => {
      const { context, agents } = await launchContext();
      const request = await buildRunRequestFor(
        { ...context, fileScope: ['docs/alice'] },
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON,
        null,
        loader,
      );
      expect(request.resources?.files.map((file) => file.path)).toEqual(['docs/alice/a.md']);
      const compiled = compileRunRequest(request);
      expect(compiled.disallowedTools.join(' ')).not.toContain('docs/bob');
    });

    it('keeps every grant when the run has no scope', async () => {
      const { context, agents } = await launchContext();
      const request = await buildRunRequestFor(
        context,
        await rowRunAgent(agents, context),
        SETTINGS,
        GATEWAY,
        {},
        ALL_ON,
        null,
        loader,
      );
      expect(request.resources?.files).toHaveLength(3);
    });

    it('refuses a scope outside the grants before a token is issued', async () => {
      const { context, agents } = await launchContext();
      const before = issued;
      await expect(
        buildRunRequestFor(
          { ...context, fileScope: ['docs/alice', 'finance'] },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          loader,
        ),
      ).rejects.toThrow(/^run_file_scope_not_granted: /u);
      expect(issued).toBe(before);
    });

    it('refuses any scope for an agent that has no files', async () => {
      const { context, agents } = await launchContext();
      await expect(
        buildRunRequestFor(
          { ...context, fileScope: ['docs/alice'] },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
        ),
      ).rejects.toThrow(/run_file_scope_not_granted/u);
    });

    // @story US-STO-06
    it('[US-STO-06][unit][run] a scope that narrows a grant over the run limit still composes', async () => {
      const { context, agents } = await launchContext();
      const over = {
        load: () =>
          Promise.resolve({
            files: [
              { kind: 'directory' as const, path: 'docs', access: 'read' as const },
              fileOf('docs/alice/a.md'),
              { ...fileOf('docs/bob/b.bin'), size: RUN_FILES_MAX_BYTES + 1 },
            ],
            skills: [],
            mcpServers: {},
          }),
      };
      const compose = async (fileScope?: readonly string[]) =>
        buildRunRequestFor(
          fileScope === undefined ? context : { ...context, fileScope },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          over,
        );
      const scoped = await compose(['docs/alice']);
      expect(scoped.resources?.files.map((file) => file.path)).toEqual(['docs/alice/a.md']);
      // Unscoped, the same grant is over the limit: compose refuses it as the backstop.
      await expect(compose()).rejects.toMatchObject({ code: 'run_files_too_large' });
    });

    it('words a refusal the same whether a path is outside the grants or does not exist', async () => {
      const { context, agents } = await launchContext();
      const refusal = async (fileScope: readonly string[]): Promise<string> => {
        const failure: unknown = await buildRunRequestFor(
          { ...context, fileScope },
          await rowRunAgent(agents, context),
          SETTINGS,
          GATEWAY,
          {},
          ALL_ON,
          null,
          loader,
        ).catch((e: unknown) => e);
        return failure instanceof Error ? failure.message : 'resolved';
      };
      const outside = await refusal(['finance']);
      expect(outside).toMatch(/^run_file_scope_not_granted: /u);
      expect(outside).not.toContain('finance');
      expect(await refusal(['no-such-folder/x.md'])).toBe(outside);
    });
  });
  it('[US-STO-11][unit][run] an attachment is a read reference in the body, never its bytes, and removes the shell (ADR-0146)', async () => {
    const { context, agents } = await launchContext();
    const brief = {
      kind: 'file' as const,
      path: 'notes/brief.md',
      access: 'read' as const,
      size: 5,
      sha256: createHash('sha256').update('brief').digest('hex'),
    };
    const loads: unknown[] = [];
    const request = await buildRunRequestFor(
      {
        ...context,
        attachments: [{ fileId: 'file-1', path: 'notes/brief.md', kind: 'file' }],
      },
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      {
        load: (_workspaceId, assignments) => {
          loads.push(assignments.files);
          return Promise.resolve({
            files: assignments.files.length === 0 ? [] : [{ ...brief, access: 'read-write' }],
            skills: [],
            mcpServers: {},
          });
        },
      },
    );

    // The attachment's own load, by file id, read-only whatever the loader says.
    expect(loads).toContainEqual([{ fileId: 'file-1', access: 'read' }]);
    expect(request.resources?.files).toEqual([brief]);
    expect(request.portable.permissions.runCommands).toBe(false);
    const compiled = compileRunRequest(request);
    expect(compiled.disallowedTools).toContain(
      `Edit(//workspace/${WORKSPACE}/${SESSION}/notes/brief.md)`,
    );
    expect(compiled.disallowedTools).toContain('Bash');

    // ADR-0146 Decision 2: the grant is the run's. A follow-up turn without the attachment does
    // not name it, so the runner removes it like any revoked grant.
    const followUp = await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
    );
    expect(followUp.resources?.files).toEqual([]);
  });
  it('passes the run’s assignments, the session’s project id and the agent’s own permissions to the resource loader (issue #125)', async () => {
    const { context, agents } = await launchContext();
    const runAgent = {
      ...(await rowRunAgent(agents, context)),
      assignments: {
        files: [],
        skillIds: ['a pinned skill'],
        connectorIds: [],
        storageGrants: [],
      },
    };
    const seen: {
      workspaceId: string | undefined;
      assignments: AgentResourceAssignmentsInput | undefined;
      projectId: string | null | undefined;
      permissions: AgentPermissions | undefined;
    } = {
      workspaceId: undefined,
      assignments: undefined,
      projectId: undefined,
      permissions: undefined,
    };
    await buildRunRequestFor(
      context,
      runAgent,
      SETTINGS,
      GATEWAY,
      {},
      ALL_ON,
      null,
      {
        load: (workspaceId, assignments, projectId, agentPermissions) => {
          seen.workspaceId = workspaceId;
          seen.assignments = assignments;
          seen.projectId = projectId;
          seen.permissions = agentPermissions;
          return Promise.resolve({ files: [], skills: [], mcpServers: {} });
        },
      },
      undefined,
      'a project id',
    );
    expect(seen).toEqual({
      workspaceId: WORKSPACE,
      assignments: runAgent.assignments,
      projectId: 'a project id',
      permissions: ALL_ON,
    });
  });
  it('threads no project id when the session has none, exactly like every pre-#125 call site', async () => {
    const { context, agents } = await launchContext();
    let seenProjectId: string | null | undefined = 'unset';
    await buildRunRequestFor(
      context,
      await rowRunAgent(agents, context),
      SETTINGS,
      GATEWAY,
      {},
      undefined,
      null,
      {
        load: (_workspaceId, _assignments, projectId) => {
          seenProjectId = projectId;
          return Promise.resolve({ files: [], skills: [], mcpServers: {} });
        },
      },
    );
    expect(seenProjectId).toBeNull();
  });
}

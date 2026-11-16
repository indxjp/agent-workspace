import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';
import {
  context,
  members,
  memoryStorage,
  NOTHING_GRANTED,
  referenced,
  sha256Of,
} from './workspace-lifecycle.test-support';

describe('createRuntimeWorkspaceLifecycle', () => {
  it(
    'hydrates the files the run references, under its cwd, read-only unless granted read-write',
    hydratesFilesRunReferencesUnderCwdReadOnly,
  );

  it(
    'hydrates only the files inside the run fileScope (issue #1539)',
    hydratesOnlyFilesInsideRunFileScopeIssue1539,
  );

  it(
    'hydrates attachments read-only under the run cwd, loaded by file id (ADR-0146)',
    hydratesAttachmentsReadOnlyUnderRunCwdLoaded,
  );

  it(
    'refuses files over the run limit in total before reading any of them',
    refusesFilesOverRunLimitTotalBeforeReading,
  );

  // @story US-STO-06
  it(
    '[US-STO-06][unit][run] a fileScope that narrows a grant over the run limit still streams',
    usSTO06UnitRunFileScopeThatNarrows,
  );
});

async function hydratesFilesRunReferencesUnderCwdReadOnly() {
  const notes = referenced('notes/input.txt', 'hello');
  const draft = referenced('drafts/plan.md', 'plan', 'read-write');
  const skill = referenced('.aw-inbox/skills/triage/SKILL.md', '# triage');
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage: memoryStorage().storage,
    granted: () =>
      Promise.resolve({
        files: [
          notes.file,
          draft.file,
          { kind: 'directory', path: 'output', access: 'read-write' },
        ],
        skills: [
          {
            name: 'triage',
            files: [{ path: 'SKILL.md', size: skill.file.size, sha256: skill.file.sha256 }],
          },
        ],
        sources: new Map([notes.source, draft.source, skill.source]),
      }),
    resources: { load: () => Promise.reject(new Error('no attachment was asked for')) },
  });

  expect(await members(await lifecycle.inputArchive(context))).toMatchObject([
    { path: 'workspace-1/session-1/notes/input.txt', type: 'file', mode: 0o444 },
    { path: 'workspace-1/session-1/drafts/plan.md', type: 'file', mode: 0o644 },
    { path: 'workspace-1/session-1/output', type: 'directory', mode: 0o755 },
    {
      path: 'workspace-1/session-1/.aw-inbox/skills/triage/SKILL.md',
      type: 'file',
      mode: 0o444,
      data: Buffer.from('# triage'),
    },
  ]);
}

async function hydratesOnlyFilesInsideRunFileScopeIssue1539() {
  const alice = referenced('docs/alice/a.md', 'a');
  const bob = referenced('docs/bob/b.md', 'b');
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage: memoryStorage().storage,
    granted: () =>
      Promise.resolve({
        files: [alice.file, bob.file],
        skills: [],
        sources: new Map([alice.source, bob.source]),
      }),
    resources: { load: () => Promise.reject(new Error('no attachment was asked for')) },
  });

  const archive = await lifecycle.inputArchive({ ...context, fileScope: ['docs/alice'] });
  expect((await members(archive))?.map((entry) => entry.path)).toEqual([
    'workspace-1/session-1/docs/alice/a.md',
  ]);
  expect(await lifecycle.inputArchive({ ...context, fileScope: ['docs/carol'] })).toBeNull();
}

async function hydratesAttachmentsReadOnlyUnderRunCwdLoaded() {
  const loads: unknown[] = [];
  const brief = referenced('notes/brief.md', 'brief', 'read-write');
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage: memoryStorage().storage,
    granted: NOTHING_GRANTED,
    resources: {
      load: (_workspaceId, assignments) => {
        loads.push(assignments);
        return Promise.resolve({
          files: [brief.file],
          skills: [],
          sources: new Map([brief.source]),
          mcpServers: {},
        });
      },
    },
  });

  const archive = await lifecycle.inputArchive({
    ...context,
    attachments: [{ fileId: 'file-1', path: 'notes/brief.md', kind: 'file' }],
  });
  expect(await members(archive)).toMatchObject([
    { path: 'workspace-1/session-1/notes/brief.md', type: 'file', mode: 0o444 },
  ]);
  expect(loads).toEqual([
    { files: [{ fileId: 'file-1', access: 'read' }], skillIds: [], connectorIds: [] },
  ]);
}

async function refusesFilesOverRunLimitTotalBeforeReading() {
  const opened: string[] = [];
  const big = (path: string, size: number) => ({
    file: { kind: 'file' as const, path, access: 'read' as const, size, sha256: sha256Of(path) },
    source: [
      path,
      {
        objectId: null,
        open: () => {
          opened.push(path);
          return Promise.resolve(null);
        },
      },
    ] as const,
  });
  const granted = big('big/a.bin', 100 * 1024 * 1024);
  const attached = big('big/b.bin', 29 * 1024 * 1024);
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage: memoryStorage().storage,
    granted: () =>
      Promise.resolve({ files: [granted.file], skills: [], sources: new Map([granted.source]) }),
    resources: {
      load: () =>
        Promise.resolve({
          files: [attached.file],
          skills: [],
          sources: new Map([attached.source]),
          mcpServers: {},
        }),
    },
  });

  // Each alone fits; the grant and the attachment together do not.
  await expect(
    lifecycle.inputArchive({
      ...context,
      attachments: [{ fileId: 'file-1', path: 'big/b.bin', kind: 'file' }],
    }),
  ).rejects.toMatchObject({ code: 'run_files_too_large' });
  expect(opened).toEqual([]);
}

async function usSTO06UnitRunFileScopeThatNarrows() {
  const small = referenced('kb/small.txt', 'small');
  const huge = { ...referenced('kb/huge.bin', '').file, size: RUN_FILES_MAX_BYTES + 1 };
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage: memoryStorage().storage,
    granted: () =>
      Promise.resolve({
        files: [huge, small.file],
        skills: [],
        sources: new Map([small.source]),
      }),
    resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
  });

  const archive = await lifecycle.inputArchive({ ...context, fileScope: ['kb/small.txt'] });
  expect(await members(archive)).toMatchObject([
    { path: 'workspace-1/session-1/kb/small.txt', type: 'file' },
  ]);
  // Unscoped, the same grant is over the limit.
  await expect(lifecycle.inputArchive(context)).rejects.toMatchObject({
    code: 'run_files_too_large',
  });
}

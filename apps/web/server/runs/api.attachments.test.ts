import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalogFile } from '@agent-workspace/core/db';
import { clearApplicationContext } from '../application-context';
import { installTestDomains, resetTestRunApi } from '../application-context-fixtures';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { startRun } from './api';
import { AGENT, errorCode, install, post, PRINCIPAL, SESSION, WORKSPACE } from './api.test-support';
import { type AgentRef, type RunPrincipal, type SessionRef } from './environment';

afterEach(() => {
  resetTestRunApi();
});

const UNKNOWN_ID = 'a0000000-0000-4000-8000-000000000002';
let FILE_ID: string;
let RESERVED_ID: string;
let BIG_ID: string;
let AUDIO_ID: string;
const row = (path: string, contentType: string | null, sizeBytes = 3) => ({
  path,
  kind: 'file' as const,
  storageKey: path,
  sizeBytes,
  contentType,
  ownerPrincipalId: PRINCIPAL.ownerPrincipalId,
});
const sessionSpy = () =>
  vi.fn((_p: RunPrincipal, agent: AgentRef) =>
    Promise.resolve<SessionRef | null>({ id: SESSION, agentId: agent.id, engine: null }),
  );
function useAttachmentCatalog(): void {
  beforeEach(async () => {
    // The Builder ownership check reads the agents runtime; an empty store answers `unknown`, as
    // the unwired agents slot did before it moved into the application context.
    const { createInMemoryAgentStoreProvider } = await import('../agents/memory-store');
    const catalog = createInMemoryCatalogStore();
    const seeded = catalog.forWorkspaceSync(WORKSPACE);
    FILE_ID = (await seedCatalogFile(seeded, row('notes/brief.md', 'text/markdown'))).id;
    AUDIO_ID = (await seedCatalogFile(seeded, row('meetings/a.m4a', null))).id;
    RESERVED_ID = (await seedCatalogFile(seeded, row('.attachments/upload.md', 'text/markdown')))
      .id;
    BIG_ID = (
      await seedCatalogFile(
        seeded,
        row('notes/huge.bin', 'application/octet-stream', 10 * 1024 * 1024 + 1),
      )
    ).id;
    installTestDomains({
      agents: {
        agents: createInMemoryAgentStoreProvider(),
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      },
      files: {
        kind: 'serving',
        runtime: {
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
          store: {} as never,
          catalog,
        },
      },
    });
  });
  afterEach(clearApplicationContext);
}

describe('runs.start attachments (issue #1307)', () => {
  useAttachmentCatalog();
  it('launches with the resolved attachments and a prompt that names them', async () => {
    const harness = install();
    const response = await startRun(
      post(AGENT, { prompt: 'summarise', attachments: [{ fileId: FILE_ID }] }),
      AGENT,
    );
    expect(response.status).toBe(202);
    const context = harness.launched[0];
    expect(context?.attachments).toEqual([
      { fileId: FILE_ID, path: 'notes/brief.md', kind: 'file' },
    ]);
    expect(context?.prompt).toContain('summarise');
    expect(context?.prompt).toContain('Attached (read-only): notes/brief.md');
  });

  it('launches a run without attachments exactly as before', async () => {
    const harness = install();
    await startRun(post(AGENT, { prompt: 'plain' }), AGENT);
    expect(harness.launched[0]?.attachments).toBeUndefined();
    expect(harness.launched[0]?.prompt).toBe('plain');
  });
  it('refuses an oversized attachment with run_attachments_too_large before any run exists', async () => {
    const openSession = sessionSpy();
    const harness = install({ openSession });
    const response = await startRun(
      post(AGENT, { prompt: 'hi', attachments: [{ fileId: BIG_ID }] }),
      AGENT,
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('run_attachments_too_large');
    expect(harness.launched).toHaveLength(0);
    expect(openSession).not.toHaveBeenCalled();
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
  });
});

describe('runs.start attachments (issue #1307)', () => {
  useAttachmentCatalog();
  it('answers one concealed 404 for an unknown id, a reserved path and a session-scoped token, and opens no session or run', async () => {
    const openSession = sessionSpy();
    const unknownHarness = install({ openSession });
    const unknown = await startRun(
      post(AGENT, { prompt: 'hi', attachments: [{ fileId: UNKNOWN_ID }] }),
      AGENT,
    );
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    expect(unknownBody).toContain('file_not_found');
    expect(unknownHarness.launched).toHaveLength(0);
    expect(openSession).not.toHaveBeenCalled();
    expect((await unknownHarness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);

    const reservedSession = sessionSpy();
    const reservedHarness = install({ openSession: reservedSession });
    const reserved = await startRun(
      post(AGENT, { prompt: 'hi', attachments: [{ fileId: RESERVED_ID }] }),
      AGENT,
    );
    expect(reserved.status).toBe(404);
    expect(await reserved.text()).toBe(unknownBody);
    expect(reservedHarness.launched).toHaveLength(0);
    expect(reservedSession).not.toHaveBeenCalled();
    expect((await reservedHarness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);

    const scopedSession = sessionSpy();
    const scoped = install({
      openSession: scopedSession,
      authenticate: () =>
        Promise.resolve({ ...PRINCIPAL, scope: { kind: 'session', id: SESSION } }),
    });
    const refused = await startRun(
      post(AGENT, { prompt: 'hi', sessionId: SESSION, attachments: [{ fileId: FILE_ID }] }),
      AGENT,
    );
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(unknownBody);
    expect(scoped.launched).toHaveLength(0);
    expect(scopedSession).not.toHaveBeenCalled();
    expect((await scoped.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
  });
});

describe('runs.start attachments (issue #1307)', () => {
  useAttachmentCatalog();
  it('passes the attachment count to preflight and answers its 422 with no run', async () => {
    const counts: (number | undefined)[] = [];
    const harness = install({
      preflight: (_p, _a, _s, _m, _v, attachmentCount) => {
        counts.push(attachmentCount);
        return Promise.resolve({
          code: 'run_attachments_unreadable',
          message: 'this agent cannot read files.',
        });
      },
    });
    const response = await startRun(
      post(AGENT, { prompt: 'hi', attachments: [{ fileId: FILE_ID }] }),
      AGENT,
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('run_attachments_unreadable');
    expect(counts).toEqual([1]);
    expect(harness.launched).toHaveLength(0);
  });
  it('counts the audio attachments for preflight and answers its 422 with no run (issue #1313)', async () => {
    const counts: (number | undefined)[][] = [];
    const harness = install({
      preflight: (_p, _a, _s, _m, _v, attachmentCount, audioAttachmentCount) => {
        counts.push([attachmentCount, audioAttachmentCount]);
        return Promise.resolve({
          code: 'run_attachments_untranscribable',
          message: 'the anthropic provider cannot transcribe audio.',
        });
      },
    });
    const response = await startRun(
      post(AGENT, {
        prompt: 'minutes',
        attachments: [{ fileId: FILE_ID }, { fileId: AUDIO_ID }],
      }),
      AGENT,
    );
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe('run_attachments_untranscribable');
    expect(counts).toEqual([[2, 1]]);
    expect(harness.launched).toHaveLength(0);
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(0);
  });
});

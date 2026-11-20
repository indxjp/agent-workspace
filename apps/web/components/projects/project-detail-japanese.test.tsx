// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchDouble, jsonResponse, type RecordedRequest } from '@indx-workspace/sdk/testing';

import type { ProjectResource } from '../../contracts/projects';

import { describeLifecycleFailure, summariseArchiveImpact, type ArchiveDialogState } from './model';
import { ProjectArchiveDialog } from './project-archive';
import { ProjectDetail } from './project-detail';
import { ProjectFields, type ProjectCatalogs } from './project-form';
import { projectsStrings } from './projects-messages';

// UX-15 in #2086: the project form and the project detail screen in the reader's language.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const en = projectsStrings('en');
const ja = projectsStrings('ja');

/** Every word a catalog holds; functions are called with a sample. */
function englishWords(): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'function')
      out.push((value as (s: string) => string)('X').replace(/X/gu, ''));
    else for (const inner of Object.values(value as Record<string, unknown>)) visit(inner);
  };
  visit(en);
  return out.map((word) => word.trim()).filter((word) => word.length > 3);
}

/** English words of the catalog found in what a reader sees or hears. */
function englishLeftIn(node: ParentNode, text: string): string[] {
  const seen = [
    text,
    ...[...node.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')),
    ...[...node.querySelectorAll('[placeholder]')].map((n) => n.getAttribute('placeholder')),
    ...[...node.querySelectorAll('option')].map((n) => n.textContent),
  ].join('\n');
  return englishWords().filter((word) => seen.includes(word));
}

const PROJECT: ProjectResource = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  name: 'Quarterly report',
  instructions: 'Use the house style.',
  defaultAgentId: null,
  defaultModelConnectionId: null,
  defaultModel: null,
  visibility: 'workspace',
  createdBy: '33333333-3333-4333-8333-333333333333',
  ownerPrincipalId: '44444444-4444-4444-8444-444444444444',
  archivedAt: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  fileIds: ['55555555-5555-4555-8555-555555555555'],
  mcpServerIds: [],
};

const CAPABLE = {
  canArchiveOwn: true,
  canArchiveOther: true,
  viewerPrincipalId: PROJECT.ownerPrincipalId,
};

const CATALOGS: ProjectCatalogs = {
  agents: [{ id: 'agent-1', label: 'Support' }],
  files: [],
  connectors: [],
};

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function serve(project: ProjectResource) {
  vi.stubGlobal(
    'fetch',
    fetchDouble((request: RecordedRequest) => {
      const path = request.url.pathname;
      if (path === `/api/projects/${project.id}`) return jsonResponse(200, project);
      if (path === '/api/agents') return jsonResponse(200, { agents: [] });
      // Files, connectors and models are optional subsystems: switched off, they list nothing.
      return jsonResponse(503, { error: { code: 'unavailable', message: 'Not configured.' } });
    }).fetch,
  );
}

describe('ProjectFields in Japanese', () => {
  it('shows every label, hint, option and empty list in Japanese, names as they are stored', () => {
    vi.stubGlobal('fetch', fetchDouble(() => jsonResponse(503, {})).fetch);
    act(() =>
      root.render(
        <ProjectFields
          draft={{
            name: '',
            instructions: '',
            visibility: 'private',
            defaultAgentId: null,
            defaultModel: null,
            fileIds: [],
            mcpServerIds: [],
          }}
          catalogs={CATALOGS}
          onChange={() => undefined}
          idPrefix="t"
          locale="ja"
        />,
      ),
    );
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual(['名前', '指示文', '公開範囲', '既定のエージェント']);
    expect(host.querySelector('#t-name')?.getAttribute('placeholder')).toBe(
      ja.form.namePlaceholder,
    );
    expect(host.textContent).toContain(ja.form.instructionsHelp);
    expect([...host.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '非公開 — 自分のみ',
      'ワークスペース — このワークスペースの全員',
      '公開 — 共有リンクを知っている人全員',
      '既定のエージェントなし',
      'Support',
    ]);
    expect([...host.querySelectorAll('legend')].map((l) => l.textContent)).toEqual([
      'ファイルとフォルダー',
      'コネクタ',
    ]);
    expect(host.textContent).toContain('既定のモデル');
    expect(englishLeftIn(host, host.textContent ?? '')).toEqual([]);
  });

  it('keeps the English form as it was', () => {
    const html = renderToStaticMarkup(
      <ProjectFields
        draft={{
          name: '',
          instructions: '',
          visibility: 'private',
          defaultAgentId: null,
          defaultModel: null,
          fileIds: [],
          mcpServerIds: [],
        }}
        catalogs={CATALOGS}
        onChange={() => undefined}
        idPrefix="t"
      />,
    );
    expect(html).toContain('placeholder="e.g. Q3 Contract Review"');
    expect(html).toContain('Added to every agent’s context when this project is selected.');
    expect(html).toContain('<option value="public">Public — anyone with a share link</option>');
    expect(html).toContain('<option value="" selected="">No default agent</option>');
    expect(html).toContain('Files and folders');
    expect(html).toContain('None configured.');
    expect(html).toContain('Default model');
    expect(html).toContain('Loading model connections…');
  });
});

describe('ProjectDetail in Japanese', () => {
  it('shows the settings screen in Japanese, the project name as it is stored', async () => {
    serve(PROJECT);
    act(() => root.render(<ProjectDetail id={PROJECT.id} capability={CAPABLE} locale="ja" />));
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Quarterly report'));
    await vi.waitFor(() => expect(host.textContent).toContain(ja.form.projectDefaultNotSet));

    expect(host.querySelector('main')?.getAttribute('lang')).toBe('ja');
    expect(host.textContent).toContain('プロジェクトの設定');
    expect(host.textContent).toContain('プロジェクト一覧に戻る');
    expect(host.textContent).toContain('割り当てたリソース');
    expect(host.textContent).toContain('割り当てはありません。');
    expect(host.textContent).toContain(`削除されたリソース (${PROJECT.fileIds[0] ?? ''})`);
    expect(host.textContent).toContain('変更を保存');
    expect(host.textContent).toContain('キャンセル');
    expect(host.textContent).toContain('プロジェクトのライフサイクル');
    expect(host.textContent).toContain('プロジェクトをアーカイブ');
    expect(englishLeftIn(host, host.textContent ?? '')).toEqual([]);
  });

  it('says an archived project in Japanese', async () => {
    serve({ ...PROJECT, archivedAt: '2026-09-13T08:00:00.000Z' });
    act(() => root.render(<ProjectDetail id={PROJECT.id} capability={CAPABLE} locale="ja" />));
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')).not.toBeNull());
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      ja.detail.archivedOn('2026-09-13'),
    );
    expect(host.textContent).toContain(ja.lifecycle.archivedHelp);
    expect(host.textContent).toContain('プロジェクトを復元');
    expect(englishLeftIn(host, host.textContent ?? '')).toEqual([]);
  });

  it('says loading in Japanese', () => {
    const html = renderToStaticMarkup(<ProjectDetail id={PROJECT.id} locale="ja" />);
    expect(html).toBe(
      '<main lang="ja" class="px-8 pt-[26px] text-muted">プロジェクトを読み込み中…</main>',
    );
  });

  it('keeps the English screen as it was', async () => {
    serve({ ...PROJECT, archivedAt: '2026-09-13T08:00:00.000Z' });
    act(() => root.render(<ProjectDetail id={PROJECT.id} capability={CAPABLE} />));
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')).not.toBeNull());
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Archived on 2026-09-13. Its settings are read-only and no new sessions or runs can start in it. Completed work stays in history.',
    );
    expect(host.textContent).toContain('Project settings');
    expect(host.textContent).toContain('Back to projects');
    expect(host.textContent).toContain('Assigned resources');
    expect(host.textContent).toContain(`Deleted resource (${PROJECT.fileIds[0] ?? ''})`);
    expect(host.textContent).toContain('Restore project');
  });
});

describe('the archive confirmation in Japanese', () => {
  const STATES: readonly ArchiveDialogState[] = [
    { kind: 'counting' },
    { kind: 'counted', impact: { sessions: 3, runs: 200, runsTruncated: true } },
    { kind: 'counted', impact: { sessions: 0, runs: 0, runsTruncated: false } },
    { kind: 'count-unavailable' },
    { kind: 'confirming' },
    { kind: 'submitting' },
  ];

  it.each(STATES)('shows the $kind state in Japanese', (state) => {
    act(() =>
      root.render(
        <ProjectArchiveDialog
          project={PROJECT}
          transition="archive"
          state={state}
          onCancel={() => undefined}
          onConfirm={() => undefined}
          strings={ja}
        />,
      ),
    );
    expect(host.querySelector('h2')?.textContent).toBe('「Quarterly report」をアーカイブしますか?');
    expect(host.textContent).toContain('キャンセル');
    expect(englishLeftIn(host, host.textContent ?? '')).toEqual([]);
  });

  it('shows a restore in Japanese', () => {
    act(() =>
      root.render(
        <ProjectArchiveDialog
          project={PROJECT}
          transition="restore"
          state={{ kind: 'confirming' }}
          onCancel={() => undefined}
          onConfirm={() => undefined}
          strings={ja}
        />,
      ),
    );
    expect(host.querySelector('h2')?.textContent).toBe('「Quarterly report」を復元しますか?');
    expect(host.textContent).toContain(ja.lifecycle.restoreBody);
    expect(host.textContent).toContain('プロジェクトを復元');
  });

  it('counts in Japanese, and keeps the English sentences', () => {
    expect(
      summariseArchiveImpact({ sessions: 3, runs: 200, runsTruncated: true }, ja.lifecycle),
    ).toBe(
      'あなたが見られるセッション 3 件と実行 200+ 件が読み取り専用になります。完了した作業は履歴に残り、このプロジェクトでは新しいセッションや実行を開始できなくなります。',
    );
    expect(summariseArchiveImpact({ sessions: 1, runs: 1, runsTruncated: false })).toBe(
      '1 session and 1 run that you can see become read-only. Completed work stays in history, and no new sessions or runs can start in this project.',
    );
    expect(summariseArchiveImpact({ sessions: 1, runs: 1, runsTruncated: true })).toContain(
      '1 session and 1+ runs',
    );
    const gone = describeLifecycleFailure(
      { kind: 'api', status: 404, code: 'not_found', message: 'Project not found.' },
      ja.lifecycle.noLongerAvailable,
    );
    expect(gone).toMatchObject({ message: 'このプロジェクトはもう利用できません。' });
  });
});

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { AgentEvent } from '@indx-workspace/sdk/events';
import type { DefinitionChange } from '@indx-workspace/sdk/portable';

import { BuilderApproval } from './builder-approval';
import { changeInWords } from './builder-approval-words';
import { builderStrings, detailText, refusalText } from './builder-messages';
import { BuilderPreviewPanel } from './builder-mode';
import { BuilderSaved } from './builder-saved';
import { definitionBody } from './definition-fixture';
import { newAgentStrings } from './new-agent-messages';

// UX-15 in #2086: the New Agent screen and the Builder chat in the reader's language.

const ENGINE = 'claude-agent-sdk';
const AGENT_ID = '0b7f4f0e-6a38-4d6c-9d0e-0c7a1f5a8c11';

let searchParams = new URLSearchParams('');
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
const client = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../lib/browser-client', () => ({
  browserClient: () => ({ agents: { versions: { list: client.list } } }),
}));

const { ModelStep, NewAgentScreen, PermissionsStep, ResourcesStep, RuntimeProfileStep } =
  await import('./agent-form');
const { BuilderMode } = await import('./builder-mode');
const { AgentFormProblem } = await import('./agent-form-problem');

/** Every word a strings object holds, keyed by its path; functions are called with samples. */
function flatten(value: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  if (typeof value === 'string') out.set(path, value);
  else if (typeof value === 'function') {
    out.set(path, (value as (...args: unknown[]) => string)('3', '2'));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) flatten(inner, `${path}.${key}`, out);
  }
  return out;
}

function expectEveryWordTranslated(en: object, ja: object): void {
  const english = flatten(en);
  const japanese = flatten(ja);
  expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
  for (const [key, word] of english) {
    expect(japanese.get(key), key).not.toBe('');
    expect(japanese.get(key), key).not.toBe(word);
  }
}

const enForm = newAgentStrings('en');
const jaForm = newAgentStrings('ja');
const enBuilder = builderStrings('en');
const jaBuilder = builderStrings('ja');

/** Every English word these screens print; a Japanese screen shows none as a text node or label. */
const ENGLISH = [...flatten(enForm).values(), ...flatten(enBuilder).values()]
  .map((word) => word.trim())
  .filter((word) => word.length > 1);

/** The page as a reader sees and hears it: text nodes and the names controls are announced by. */
function readable(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/>([^<]+)</gu)) out.push((match[1] ?? '').trim());
  for (const match of html.matchAll(/(?:aria-label|placeholder|title)="([^"]*)"/gu)) {
    out.push(match[1] ?? '');
  }
  return out.filter((text) => text !== '');
}

function expectJapanese(html: string, ...expected: string[]): void {
  for (const text of expected) expect(html).toContain(text);
  const seen = readable(html);
  for (const english of ENGLISH) expect(seen, english).not.toContain(english);
}

describe('the New Agent words', () => {
  it('has a Japanese word for every English one, and never the same word', () => {
    expectEveryWordTranslated(enForm, jaForm);
    expectEveryWordTranslated(enBuilder, jaBuilder);
  });

  it('keeps English exactly as the screen printed it', () => {
    expect(enForm.step1).toBe('Step 1 · Name and instructions');
    expect(enForm.permissions.runCommands).toEqual([
      'Run commands',
      'Run commands inside the selected runtime. A command that changes something waits for your approval first.',
    ]);
    expect(enBuilder.warnSkips).toBe('This change lets the agent skip permission checks.');
    expect(enBuilder.trialCap('$0.30')).toBe(
      'This runs the draft once with at most a $0.30 budget. Its tools may change real systems.',
    );
    expect(detailText('connector:erp')).toBe('Connector: erp');
    expect(refusalText('builder_disabled')).toBe('An admin has switched the Builder off.');
  });

  it('names a refused check detail in Japanese, and never an inherited property', () => {
    expect(detailText('connector:erp', jaBuilder)).toBe('コネクタ: erp');
    expect(detailText('provider:anthropic', jaBuilder)).toBe('モデルの接続: anthropic');
    expect(detailText('constructor:x', jaBuilder)).toBe('constructor:x');
    expect(detailText('toString:x')).toBe('toString:x');
    expect(refusalText('builder_model_unavailable', jaBuilder)).toBe(
      'Builder が使うモデルを利用できません。',
    );
  });
});

/** The approval card's words for one change, in Japanese. */
function ja(change: DefinitionChange): string {
  const { label, value } = changeInWords(change, 'ja');
  return `${label} = ${value}`;
}

describe('the approval card names each change in Japanese', () => {
  const field = (path: string, before: unknown, after: unknown): DefinitionChange => ({
    path,
    section: 'policy',
    before,
    after,
  });
  const added = (path: string, after: unknown): DefinitionChange => ({
    path,
    section: 'resources',
    after,
  });

  it('fields, permissions and defaults', () => {
    expect(ja(field('definition.policy.tools.allowDangerouslySkipPermissions', false, true))).toBe(
      '権限チェックを省略 = いいえ → はい',
    );
    expect(ja(field('definition.agent.permissions.runCommands', false, true))).toBe(
      'コマンドの実行 = 不許可 → 許可',
    );
    expect(ja(field('definition.agent.model', 'claude-sonnet-5', null))).toBe(
      'モデル = "claude-sonnet-5" → デプロイメントの既定',
    );
    expect(ja(field('definition.agent.runtimeProfileName', 'local', null))).toBe(
      'ランタイムプロファイル = "local" → ワークスペースの既定',
    );
    expect(ja(field('definition.policy.tools.base', ['Read'], 'claude_code_preset'))).toBe(
      'ツールセット = ["Read"] → Claude Code プリセット',
    );
  });

  it('every kind of list entry, with the names the model wrote kept as written', () => {
    expect(ja(added('definition.resources.files["receipts/"]', 'read-write'))).toBe(
      'ファイルのアクセス権: receipts/ = 追加: 読み書き',
    );
    expect(ja(added('definition.resources.files["a"]#2', 'read'))).toBe(
      'ファイルのアクセス権: a（項目 2） = 追加: 読み取りのみ',
    );
    expect(ja(added('definition.resources.skills["s"].revision', 3))).toBe(
      'スキルのバージョン: s = 追加: 3',
    );
    expect(ja(added('definition.resources.skills["s"]', true))).toBe('スキル: s = 追加');
    expect(ja(added('definition.resources.connectors["erp"]', true))).toBe('コネクタ: erp = 追加');
    expect(ja(added('definition.policy.tools.base["Bash"]', true))).toBe(
      'ツールセットのツール: Bash = 追加',
    );
    expect(
      ja({
        path: 'definition.policy.tools.deny["Bash"]',
        section: 'policy',
        before: true,
        after: undefined,
      }),
    ).toBe('禁止されたツール: Bash = 削除');
    expect(ja(added('definition.policy.tools.autoApprove["Write"]', true))).toBe(
      '確認なしで使用: Write = 追加',
    );
    expect(ja(added('toolBundles["calc"].timeoutMs', 500))).toBe(
      'コードツールのタイムアウト（ミリ秒）: calc = 追加: 500',
    );
    expect(ja(added('toolBundles["calc"].allowedDomains["api.example.com"]', true))).toBe(
      'コードツール calc の接続先: api.example.com = 追加',
    );
    expect(ja(added('toolBundles["calc"].secrets["KEY"]', true))).toBe(
      'コードツール calc が使うシークレット: KEY = 追加',
    );
    expect(ja(added('toolBundles["calc"]', true))).toBe('コードツール: calc = 追加');
    expect(ja(added('subagents["helper"]', true))).toBe('サブエージェント: helper = 追加');
    expect(ja(added('knowledge.files["docs/"]', true))).toBe('ナレッジのファイル: docs/ = 追加');
    expect(ja(added('knowledge.connectors["wiki"]', true))).toBe('ナレッジのコネクタ: wiki = 追加');
  });

  it('keeps English labels exactly as before', () => {
    expect(changeInWords(added('definition.resources.connectors["erp"]', true))).toEqual({
      label: 'Connector: erp',
      value: 'Added',
    });
    expect(
      changeInWords(field('definition.policy.tools.allowDangerouslySkipPermissions', false, true)),
    ).toEqual({ label: 'Skip permission checks', value: 'No → Yes' });
  });

  it('shows a path it does not know as itself, and never an inherited property', () => {
    expect(changeInWords(field('constructor', 1, 2), 'ja')).toEqual({
      label: 'constructor',
      value: '1 → 2',
    });
  });
});

const BASE = definitionBody();

type Tools = Extract<
  AgentVersionBody['definition']['policy'],
  { engine: 'claude-agent-sdk' }
>['tools'];

function withTools(body: AgentVersionBody, patch: Partial<Tools>): AgentVersionBody {
  const { policy } = body.definition;
  if (policy.engine !== 'claude-agent-sdk')
    throw new Error('the fixture is a claude-agent-sdk body');
  return {
    ...body,
    definition: { ...body.definition, policy: { ...policy, tools: { ...policy.tools, ...patch } } },
  };
}

function asksToCall(toolName: string, input: unknown): AgentEvent {
  return {
    frame: 'agent.approval.requested',
    engine: ENGINE,
    raw: null,
    toolCallId: 'call-1',
    toolName,
    canonicalCall: JSON.stringify({ input }),
  };
}

describe('the approval card for a Japanese reader', () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    client.list.mockResolvedValue({ items: [{ number: 1, body: BASE }] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    client.list.mockReset();
  });

  async function show(
    events: readonly AgentEvent[],
    onDecide: () => Promise<{ message: string; code: string } | null> = () => Promise.resolve(null),
  ): Promise<string> {
    await act(async () => {
      createRoot(container).render(
        <BuilderApproval events={events} onDecide={onDecide} locale="ja" />,
      );
      await Promise.resolve();
    });
    return container.innerHTML;
  }

  it('says, no softer, what each change that lowers a guard lets the agent do', async () => {
    const lowered = withTools(BASE, {
      base: ['Read', 'Bash'],
      allowDangerouslySkipPermissions: true,
      permissionMode: 'bypassPermissions',
      autoApprove: ['Write'],
    });
    const fromList = withTools(BASE, { base: ['Read'], deny: ['WebFetch'] });
    client.list.mockResolvedValue({ items: [{ number: 1, body: fromList }] });
    const html = await show([
      asksToCall('draft_save', { agentId: AGENT_ID, baseVersion: 1, body: lowered }),
    ]);
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (node) => node.textContent,
    );
    expect(alerts).toEqual(
      expect.arrayContaining([
        jaBuilder.warnSkips,
        jaBuilder.warnAddsTool,
        jaBuilder.warnRemovesDeny,
        jaBuilder.warnWithoutAsking,
      ]),
    );
    // One warning per meaning: skip and bypass say the same thing once.
    expect(alerts.filter((text) => text === jaBuilder.warnSkips)).toHaveLength(1);
    expect(container.querySelector('section')?.getAttribute('lang')).toBe('ja');
    expect(container.querySelector('section')?.getAttribute('aria-label')).toBe(
      jaBuilder.cardLabel,
    );
    expectJapanese(html, '承認', '却下', '正確な項目を表示', 'バージョン 1 をもとに');
  });

  it('warns in Japanese when the whole Claude Code tool set is given', async () => {
    client.list.mockResolvedValue({
      items: [{ number: 1, body: withTools(BASE, { base: ['Read'] }) }],
    });
    await show([asksToCall('draft_save', { agentId: AGENT_ID, baseVersion: 1, body: BASE })]);
    const alerts = [...container.querySelectorAll('[role="alert"]')].map(
      (node) => node.textContent,
    );
    expect(alerts).toContain(jaBuilder.warnPreset);
  });

  it('a trial run and an evals run, with their budget caps', async () => {
    let html = await show([
      asksToCall('trial_run', { agentId: AGENT_ID, version: 1, input: '12 ユーロを払い戻す' }),
    ]);
    expectJapanese(html, 'エージェント', '入力', jaBuilder.trialCap('$0.30'));
    document.body.replaceChildren();
    container = document.createElement('div');
    document.body.append(container);
    html = await show([
      asksToCall('evals_run', {
        agentId: AGENT_ID,
        version: 1,
        cases: [{ name: 'ケース', input: '入力', expect: { contains: ['済'] } }],
      }),
    ]);
    expectJapanese(html, 'チェック', '期待: ', jaBuilder.evalsCap('$0.30'));
  });

  it('a call it cannot show offers Reject only, in Japanese', async () => {
    const html = await show([asksToCall('draft_save', { nonsense: true })]);
    expectJapanese(html, jaBuilder.cardUnreadable, '却下');
    expect(html).not.toContain('承認<');
  });

  it("a refused decision keeps the server's sentence, marked as English", async () => {
    await show([asksToCall('trial_run', { agentId: AGENT_ID, version: 1, input: 'x' })], () =>
      Promise.resolve({ message: 'Run is not awaiting approval.', code: 'not_awaiting' }),
    );
    const reject = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '却下',
    );
    await act(async () => {
      reject?.click();
      await Promise.resolve();
    });
    expect(container.innerHTML).toContain(
      '判断は受け付けられませんでした。 <span lang="en">Run is not awaiting approval.</span>',
    );
    expect(container.innerHTML).toContain('コード: <code>not_awaiting</code>');
  });
});

describe('the definition preview and the saved line for a Japanese reader', () => {
  const save: AgentEvent = {
    frame: 'agent.tool.call',
    engine: ENGINE,
    raw: null,
    toolCallId: 'c1',
    name: 'mcp__aw-control__draft_check',
    kind: 'mcp',
    input: { body: withTools(BASE, { autoApprove: ['Write'] }) },
  };

  it('before any draft', () => {
    const html = renderToStaticMarkup(
      <BuilderPreviewPanel events={[]} onAskBuilder={() => undefined} locale="ja" />,
    );
    expectJapanese(html, jaBuilder.previewEmpty);
  });

  it('every section, its read-mode steps and the Ask button', () => {
    const html = renderToStaticMarkup(
      <BuilderPreviewPanel events={[save]} onAskBuilder={() => undefined} locale="ja" />,
    );
    expectJapanese(
      html,
      '>指示文</h2>',
      '>ツールのポリシー</h2>',
      '確認なしで使用: Write',
      '権限チェックを省略: いいえ',
      'ツールセット: Claude Code プリセット',
      '>コマンドの実行</dt>',
      '>不許可</dd>',
      'aria-label="Builder に「権限」の変更を依頼する"',
    );
  });

  it('the line after an approved save', () => {
    const html = renderToStaticMarkup(
      <BuilderSaved
        saved={{ agentId: AGENT_ID, version: 2, name: 'expense-refunds' } as never}
        locale="ja"
      />,
    );
    expectJapanese(
      html,
      'バージョン 2 として local に保存しました',
      '>試す<',
      '>履歴を見る<',
      '>昇格<',
    );
  });
});

describe('the New Agent screen for a Japanese reader', () => {
  it('the form while its catalogs load, with the mode switch', () => {
    searchParams = new URLSearchParams('');
    const html = renderToStaticMarkup(<NewAgentScreen chatEnabled locale="ja" />);
    expect(html).toContain('lang="ja"');
    expectJapanese(
      html,
      '>新しいエージェント</h1>',
      'aria-label="エージェントの作成方法"',
      '>フォーム<',
      '>チャット<',
      'ステップ 1 · 名前と指示文',
      'placeholder="例: 契約書レビュー"',
      'モデルの接続を読み込み中…',
      'ランタイムプロファイルを読み込み中…',
      'ファイル、スキル、コネクタを読み込み中…',
      '>エージェントを作成<',
      '>キャンセル<',
    );
  });

  it('the Builder chat while it loads', () => {
    const html = renderToStaticMarkup(<BuilderMode modeSwitch={null} filesEnabled locale="ja" />);
    expect(html).toContain('lang="ja"');
    expectJapanese(html, '>新しいエージェント</h1>', 'Builder を読み込み中…');
  });

  it('each step, to choose and to read', () => {
    const model = {
      connectionId: 'c1',
      connectionName: 'anthropic',
      providerModelId: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      capabilities: { promptCaching: false },
    } as never;
    // The same model from a second connection brings up the Connection control.
    const second = { ...(model as object), connectionId: 'c2', connectionName: 'vertex' } as never;
    const steps = [
      <ModelStep
        key="m"
        models={[model, second]}
        unavailable={[{ connectionName: 'openai', reason: 'credential missing' }]}
        value={{ connectionId: 'c1', model: 'claude-sonnet-5' }}
        onSelect={() => undefined}
        words={jaForm}
      />,
      <ModelStep
        key="m0"
        models={[]}
        unavailable={[]}
        value={null}
        onSelect={() => undefined}
        words={jaForm}
      />,
      <RuntimeProfileStep
        key="r0"
        profiles={[]}
        selectedId={null}
        onSelect={() => undefined}
        words={jaForm}
      />,
      <ResourcesStep
        key="res"
        options={{ files: [{ id: 'f1', label: 'receipts/' }], skills: [], connectors: [] }}
        fileAccess={{ f1: 'read' }}
        selectedSkills={new Set()}
        selectedConnectors={new Set()}
        onFile={() => undefined}
        onSkill={() => undefined}
        onConnector={() => undefined}
        words={jaForm}
      />,
      <PermissionsStep
        key="p"
        permissions={{
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        }}
        onChange={() => undefined}
        words={jaForm}
      />,
    ];
    const html = steps.map((step) => renderToStaticMarkup(step)).join('');
    expectJapanese(
      html,
      'ステップ 2 · モデル',
      '>接続</label>',
      'aria-label="閉じる"',
      'プロンプトキャッシュ',
      'モデル画面でプロバイダーを追加',
      'ランタイム画面で作成',
      'ステップ 4 · リソース',
      'aria-label="receipts/ のアクセス権"',
      '>読み取り</option>',
      '>設定されていません。</p>',
      'ステップ 5 · 権限',
      '何かを変更するコマンドは、実行前にあなたの承認を待ちます。',
    );
    const read = [
      <ResourcesStep
        key="res"
        options={{ files: [{ id: 'f1', label: 'receipts/' }], skills: [], connectors: [] }}
        fileAccess={{ f1: 'read-write' }}
        selectedSkills={new Set()}
        selectedConnectors={new Set()}
        onFile={() => undefined}
        onSkill={() => undefined}
        onConnector={() => undefined}
        readOnly
        words={jaForm}
      />,
      <RuntimeProfileStep
        key="r"
        profiles={[]}
        selectedId={null}
        onSelect={() => undefined}
        readOnly
        words={jaForm}
      />,
      <ModelStep
        key="m"
        models={[]}
        unavailable={[]}
        value={null}
        onSelect={() => undefined}
        readOnly
        words={jaForm}
      />,
    ]
      .map((step) => renderToStaticMarkup(step))
      .join('');
    expectJapanese(read, 'receipts/ (読み書き)', '>なし</dd>', '>デプロイメントの既定</dd>');
  });

  it('an English reader sees the form exactly as before', () => {
    searchParams = new URLSearchParams('');
    const html = renderToStaticMarkup(<NewAgentScreen chatEnabled />);
    expect(html).toContain('lang="en"');
    for (const text of [
      '>New Agent</h1>',
      'aria-label="How to create this agent"',
      'Step 1 · Name and instructions',
      'placeholder="e.g. Contract Review"',
      '>Create Agent<',
    ]) {
      expect(html).toContain(text);
    }
  });
});

describe('a refused create for a Japanese reader', () => {
  const refused = {
    kind: 'api',
    status: 409,
    code: 'name_taken',
    message: 'An agent named X exists.',
  } as const;

  it('leads with a Japanese sentence and keeps the server words English', () => {
    const html = renderToStaticMarkup(
      <AgentFormProblem problem={refused} strings={jaForm} locale="ja" />,
    );
    expect(html).toContain(`<div class="font-semibold">${jaForm.createFailed}</div>`);
    expect(html).toContain('409 name_taken');
    expect(html).toContain('<div lang="en">An agent named X exists.</div>');
  });

  it('keeps a transport failure English after the Japanese lead', () => {
    const html = renderToStaticMarkup(
      <AgentFormProblem
        problem={{ kind: 'transport', reason: 'Failed to fetch' }}
        strings={jaForm}
        locale="ja"
      />,
    );
    expect(html).toContain(jaForm.createFailed);
    expect(html).toContain('<div lang="en">Failed to fetch</div>');
  });

  it('shows English readers the refusal alone, as before', () => {
    const html = renderToStaticMarkup(
      <AgentFormProblem problem={refused} strings={enForm} locale="en" />,
    );
    expect(html).not.toContain(enForm.createFailed);
    expect(html).toContain('409 name_taken');
    expect(html).toContain('An agent named X exists.');
  });
});

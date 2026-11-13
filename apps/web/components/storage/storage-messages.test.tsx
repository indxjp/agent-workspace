// @vitest-environment happy-dom
import { ApiProblemError, createClient, type StorageConnectionResource } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse, type FetchDouble } from '@indx-workspace/sdk/testing';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VersionsLocale } from '../agents/versions-messages';

import { EditConnectionScreen } from './edit-connection-screen';
import { NewConnectionForm } from './new-connection-form';
import { StorageConnectionsScreen } from './storage-connections-screen';
import { storageStrings, type StorageStrings } from './storage-messages';
import {
  PROVIDER_OPTIONS,
  savedTestFailure,
  savedTestResult,
  storageProblemMessage,
  testOutcomeMessage,
} from './storage-model';

// UX-15 in #2086: the Storage screens in the reader's language.

const double: { current: FetchDouble } = {
  current: fetchDouble(() => jsonResponse(500, {})),
};
vi.mock('../../lib/browser-client', () => ({
  browserClient: () =>
    createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: (input, init) => double.current.fetch(input, init),
    }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every word a `StorageStrings` holds, keyed by its path; functions are called with samples. */
function flatten(strings: StorageStrings): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(strings)) {
    if (typeof value === 'string') out.set(key, value);
    else if (typeof value === 'function') out.set(key, (value as (sample: string) => string)('X'));
    else
      for (const [inner, word] of Object.entries(value as Record<string, string>))
        out.set(`${key}.${inner}`, word);
  }
  return out;
}

const en = storageStrings('en');
const ja = storageStrings('ja');

/** Words that are the same in both: product names and the literal `URL`. */
const SAME_IN_BOTH = new Set(['providerLabel.gcs', 'providerLabel.azblob', 'url']);

describe('storageStrings', () => {
  it('has a Japanese word for every English one', () => {
    const english = flatten(en);
    const japanese = flatten(ja);
    expect([...japanese.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [key, word] of english) {
      expect(japanese.get(key), key).not.toBe('');
      if (!SAME_IN_BOTH.has(key)) expect(japanese.get(key), key).not.toBe(word);
    }
  });

  it('keeps English exactly as the screens and the model printed it', () => {
    for (const option of PROVIDER_OPTIONS)
      expect(en.providerLabel[option.value]).toBe(option.label);
    expect(testOutcomeMessage({ ok: true, emptyFolders: ['a', 'b'] } as never)).toBe(
      'Connection OK, but no files found under: a, b. Check the folder names.',
    );
    expect(savedTestResult({ ok: false, code: 'forbidden' } as never)).toEqual({
      level: 'fail',
      message:
        'Saved, but the test did not pass. The storage refused the credential or the endpoint.',
      next: 'Check the credential and the endpoint, then edit the connection.',
    });
    expect(savedTestFailure(new Error('x')).message).toBe(
      'Saved. The connection could not be tested.',
    );
  });

  it("words the model's sentences for a Japanese reader", () => {
    expect(testOutcomeMessage({ ok: false, code: 'not_found' } as never, ja)).toBe(
      'ストレージの場所が見つかりませんでした。',
    );
    expect(savedTestResult({ ok: true, emptyFolders: ['reports'] } as never, ja)).toEqual({
      level: 'warn',
      message: '保存して接続できましたが、次のフォルダーにファイルがありません: reports。',
      next: 'フォルダー名が間違っている場合は、接続を編集してください。',
    });
    const taken = new ApiProblemError({
      status: 409,
      problem: { code: 'storage_connection_name_taken', message: 'server words' },
    });
    expect(storageProblemMessage(taken, 'fallback', ja)).toBe(
      '同じ名前のストレージ接続がすでにあります。',
    );
    const forbidden = new ApiProblemError({
      status: 403,
      problem: { code: 'forbidden', message: 'server words' },
    });
    expect(storageProblemMessage(forbidden, 'fallback', ja)).toBe(
      '接続済みストレージへのアクセス権がありません。',
    );
    expect(savedTestFailure(forbidden, ja)).toEqual({
      level: 'fail',
      message: '保存しました。接続済みストレージへのアクセス権がありません。',
      next: 'ストレージ画面からもう一度テストしてください。',
    });
    expect(savedTestFailure(new Error('x'), ja).message).toBe(
      '保存しました。接続をテストできませんでした。',
    );
    // A code that only looks like a key of the table is not one.
    const inherited = new ApiProblemError({
      status: 400,
      problem: { code: 'toString', message: 'server words' },
    });
    expect(storageProblemMessage(inherited, 'fallback', ja)).toBe('fallback');
  });
});

const CONNECTION: StorageConnectionResource = {
  id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
  name: 'acme-data',
  provider: 'azblob',
  url: 'azblob://acme/data',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

let container: HTMLElement;

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(element: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(element);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** Every English word these screens print; a Japanese screen shows none as a whole text. */
const ENGLISH = new Set(
  [...flatten(en)]
    .filter(([key]) => !SAME_IN_BOTH.has(key))
    .map(([, word]) => word.trim())
    .filter((word) => word !== ''),
);

function expectJapanese(...expected: string[]): void {
  expect(container.querySelector('[lang="ja"]')).not.toBeNull();
  const text = container.textContent ?? '';
  for (const word of expected) expect(text).toContain(word);
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node as HTMLElement;
    const own = element.textContent?.trim() ?? '';
    expect(ENGLISH.has(own), own).toBe(false);
    for (const attribute of ['aria-label', 'placeholder']) {
      const value = element.getAttribute(attribute);
      if (value !== null) expect(ENGLISH.has(value), value).toBe(false);
    }
  }
}

function type(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
  if (input === null) throw new Error(`no #${id}`);
  const prototype = Object.getPrototypeOf(input) as object;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function select(id: string, value: string): void {
  const input = container.querySelector<HTMLSelectElement>(`#${id}`);
  if (input === null) throw new Error(`no #${id}`);
  act(() => {
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const locales: readonly VersionsLocale[] = ['ja'];

describe('the Storage screens for a Japanese reader', () => {
  it.each(locales)('the list: heading, a row, and a test result (%s)', async (locale) => {
    double.current = fetchDouble((request) =>
      request.url.pathname.endsWith('/test')
        ? jsonResponse(200, { ok: true })
        : jsonResponse(200, { connections: [CONNECTION] }),
    );
    await mount(<StorageConnectionsScreen locale={locale} />);
    expectJapanese(
      'ストレージ',
      '+ ストレージを接続',
      'フォルダー: reports',
      '読み取り専用',
      '認証情報は安全に保存済み',
    );
    expect(container.querySelector('[aria-label="acme-data を編集"]')).not.toBeNull();
    await settle(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="acme-data をテスト"]')?.click(),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'acme-data: 接続できました',
    );
  });

  it('the empty list and a refused list', async () => {
    double.current = fetchDouble(() => jsonResponse(200, { connections: [] }));
    await mount(<StorageConnectionsScreen locale="ja" />);
    expectJapanese('ストレージはまだ接続されていません。');
    double.current = fetchDouble(() => jsonResponse(500, {}));
    await mount(<StorageConnectionsScreen locale="ja" />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'ストレージ接続を読み込めませんでした。',
    );
  });

  it('Connect storage: every field, each credential kind, and a refused name', async () => {
    await mount(<NewConnectionForm locale="ja" />);
    expectJapanese(
      'ストレージを接続',
      '名前',
      '許可するフォルダー',
      '書き込みを許可',
      'アクセスキー ID',
    );
    for (const option of ['Amazon S3 または互換ストレージ', 'ローカルフォルダー'])
      expect(container.textContent).toContain(option);
    select('storage-provider', 'gcs');
    expectJapanese('サービスアカウントの JSON');
    select('storage-provider', 'azblob');
    expectJapanese('認証情報の種類', 'アカウントキー', 'SAS トークン');
    type('storage-name', 'Sales');
    type('storage-url', 'azblob://acme/data');
    type('storage-folders', 'reports');
    await settle(() => container.querySelector('form')?.requestSubmit());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('名前: 英小文字');
  });

  it('Connect storage: the saved result after its test', async () => {
    double.current = fetchDouble((request) =>
      request.url.pathname.endsWith('/test')
        ? jsonResponse(200, { ok: false, code: 'forbidden' })
        : jsonResponse(201, CONNECTION),
    );
    await mount(<NewConnectionForm locale="ja" />);
    type('storage-name', 'acme-data');
    type('storage-url', 'azblob://acme/data');
    type('storage-folders', 'reports');
    await settle(() => container.querySelector('form')?.requestSubmit());
    expectJapanese(
      'acme-data を保存しました',
      '保存しましたが、テストに失敗しました。ストレージが認証情報またはエンドポイントを拒否しました。',
      '認証情報とエンドポイントを確認してから、接続を編集してください。',
      '接続を編集',
      'ストレージに戻る',
    );
  });

  it('Edit storage connection, its credential section and the delete dialog', async () => {
    double.current = fetchDouble(() => jsonResponse(200, CONNECTION));
    await mount(<EditConnectionScreen id={CONNECTION.id} locale="ja" />);
    expectJapanese(
      'ストレージ接続を編集',
      '認証情報は暗号化して保存されており',
      '認証情報を更新',
      '変更を保存',
      'この接続を削除',
    );
    await settle(() => container.querySelector('form')?.requestSubmit());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('変更はありません。');
    await settle(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'この接続を削除')
        ?.click(),
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('acme-data を削除しますか？');
    expect(dialog?.textContent).toContain('バケット内のファイルには触れません。');
    expectJapanese('接続を削除');
  });

  it('English readers see what they saw before', async () => {
    double.current = fetchDouble(() => jsonResponse(200, CONNECTION));
    await mount(<EditConnectionScreen id={CONNECTION.id} />);
    expect(container.querySelector('main')?.getAttribute('lang')).toBe('en');
    expect(container.textContent).toContain(
      'For example azblob://account/container/optional-prefix. Moving to another endpoint, bucket or account needs a new credential.',
    );
    await mount(<NewConnectionForm />);
    expect(container.textContent).toContain(
      'For example s3://bucket/optional-prefix?endpoint=https://s3.example.com. No keys in the URL.',
    );
  });
});

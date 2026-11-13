// @vitest-environment happy-dom
import { fileRouteId } from '@indx-workspace/contracts/files';
import { ApiProblemError, type RunOutputFile } from '@indx-workspace/sdk';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MOCKUP_RUN_COMPLETED } from './mockup-fixture';
import {
  loadSessionOutputs,
  outputsFolderHref,
  RunOutputs,
  type RunOutputsProps,
} from './run-outputs';
import { RunView } from './run-view';

const file = (runId: string, name: string, sizeBytes: number | null = 2048): RunOutputFile => ({
  id: `${runId}-${name}`,
  path: `runs/${runId}/outputs/${name}`,
  kind: 'file',
  sizeBytes,
  contentType: null,
  lastModified: null,
  name,
});

let root: Root | undefined;

async function render(props: RunOutputsProps): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<RunOutputs {...props} />);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

// UX-14 in #2086: a run's files were only reachable through the SDK or by browsing Files.
describe('RunOutputs', () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('lists each file with its size and a download link, and links one run’s folder in Files', async () => {
    const outputs = vi.fn(() =>
      Promise.resolve([file('r1', 'report.md'), file('r1', 'charts/q3.png', 3 * 1024 * 1024)]),
    );
    const view = await render({ runIds: ['r1'], settled: true, locale: 'en', outputs });
    expect(outputs).toHaveBeenCalledWith('r1');
    expect(view.querySelector('h3')?.textContent).toBe('Files this run wrote');
    const links = [...view.querySelectorAll<HTMLAnchorElement>('li a')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/api/files/${fileRouteId('runs/r1/outputs/report.md')}`,
      `/api/files/${fileRouteId('runs/r1/outputs/charts/q3.png')}`,
    ]);
    expect(links[1]?.getAttribute('aria-label')).toBe('Download charts/q3.png');
    expect(view.textContent).toContain('2.0 KB');
    expect(view.textContent).toContain('3.0 MB');
    const open = view.querySelector<HTMLAnchorElement>('section > div a');
    expect(open?.textContent).toBe('Open in Files');
    expect(open?.getAttribute('href')).toBe(outputsFolderHref('r1'));
  });

  it('lists the files of every run in the session, without a single folder link', async () => {
    const outputs = (runId: string) => Promise.resolve([file(runId, `${runId}.txt`)]);
    const view = await render({ runIds: ['r1', 'r2'], settled: true, locale: 'en', outputs });
    expect([...view.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      expect.stringContaining('r1.txt'),
      expect.stringContaining('r2.txt'),
    ]);
    expect(view.querySelector('section > div a')).toBeNull();
  });

  it('renders nothing while a run is live, and asks for nothing', async () => {
    const outputs = vi.fn(() => Promise.resolve([file('r1', 'report.md')]));
    const view = await render({ runIds: ['r1'], settled: false, locale: 'en', outputs });
    expect(outputs).not.toHaveBeenCalled();
    expect(view.innerHTML).toBe('');
  });

  it('renders nothing for a session without runs', async () => {
    const outputs = vi.fn(() => Promise.resolve([file('r1', 'report.md')]));
    const view = await render({ runIds: [], settled: true, locale: 'en', outputs });
    expect(outputs).not.toHaveBeenCalled();
    expect(view.innerHTML).toBe('');
  });

  it('renders nothing when the runs wrote no files', async () => {
    const view = await render({
      runIds: ['r1'],
      settled: true,
      locale: 'en',
      outputs: () => Promise.resolve([]),
    });
    expect(view.innerHTML).toBe('');
  });

  it('says when the listing failed, and lists the files after a retry', async () => {
    const outputs = vi
      .fn<(runId: string) => Promise<readonly RunOutputFile[]>>()
      .mockRejectedValueOnce(new Error('Files returned 503.'))
      .mockResolvedValueOnce([file('r1', 'report.md')]);
    const view = await render({ runIds: ['r1'], settled: true, locale: 'en', outputs });
    const alert = view.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Could not list the files this run wrote.');
    expect(alert?.textContent).toContain('Files returned 503.');
    await act(async () => {
      view.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(outputs).toHaveBeenCalledTimes(2);
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.querySelector('li')?.textContent).toContain('report.md');
  });

  it('keeps the newest session’s files when an older listing answers late', async () => {
    let answerOld: (files: readonly RunOutputFile[]) => void = () => undefined;
    const outputs = (runId: string) =>
      runId === 'old'
        ? new Promise<readonly RunOutputFile[]>((resolve) => {
            answerOld = resolve;
          })
        : Promise.resolve([file('new', 'new.txt')]);
    const view = await render({ runIds: ['old'], settled: true, locale: 'en', outputs });
    await act(async () => {
      root?.render(<RunOutputs runIds={['new']} settled locale="en" outputs={outputs} />);
      await Promise.resolve();
    });
    await act(async () => {
      answerOld([file('old', 'old.txt')]);
      await Promise.resolve();
    });
    expect([...view.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      expect.stringContaining('new.txt'),
    ]);
  });

  it('renders nothing for a caller who may not read Files, but names any other refusal', async () => {
    const refused = (status: number) => () =>
      Promise.reject(
        new ApiProblemError({ status, problem: { code: 'forbidden', message: 'Refused.' } }),
      );
    const viewer = await render({
      runIds: ['r1'],
      settled: true,
      locale: 'en',
      outputs: refused(403),
    });
    expect(viewer.innerHTML).toBe('');
    act(() => root?.unmount());
    const other = await render({
      runIds: ['r1'],
      settled: true,
      locale: 'en',
      outputs: refused(500),
    });
    expect(other.querySelector('[role="alert"]')?.textContent).toContain('Refused.');
  });

  it('hides the listing once a follow-up run is live', async () => {
    const outputs = () => Promise.resolve([file('r1', 'report.md')]);
    const view = await render({ runIds: ['r1'], settled: true, locale: 'en', outputs });
    expect(view.querySelector('li')).not.toBeNull();
    await act(async () => {
      root?.render(<RunOutputs runIds={['r1']} settled={false} locale="en" outputs={outputs} />);
      await Promise.resolve();
    });
    expect(view.innerHTML).toBe('');
  });

  it('clears a failure while it retries', async () => {
    const outputs = vi
      .fn<(runId: string) => Promise<readonly RunOutputFile[]>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockReturnValueOnce(new Promise(() => undefined));
    const view = await render({ runIds: ['r1'], settled: true, locale: 'en', outputs });
    expect(view.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      view.querySelector('button')?.click();
      await Promise.resolve();
    });
    expect(view.innerHTML).toBe('');
  });

  it('ignores an older listing that fails late', async () => {
    let failOld: (error: Error) => void = () => undefined;
    const outputs = (runId: string) =>
      runId === 'old'
        ? new Promise<readonly RunOutputFile[]>((_resolve, reject) => {
            failOld = reject;
          })
        : Promise.resolve([file('new', 'new.txt')]);
    const view = await render({ runIds: ['old'], settled: true, locale: 'en', outputs });
    await act(async () => {
      root?.render(<RunOutputs runIds={['new']} settled locale="en" outputs={outputs} />);
      await Promise.resolve();
    });
    await act(async () => {
      failOld(new Error('late'));
      await Promise.resolve();
    });
    expect(view.querySelector('[role="alert"]')).toBeNull();
    expect(view.querySelector('li')?.textContent).toContain('new.txt');
  });

  it('speaks Japanese', async () => {
    const view = await render({
      runIds: ['r1'],
      settled: true,
      locale: 'ja',
      outputs: () => Promise.resolve([file('r1', 'report.md')]),
    });
    expect(view.querySelector('h3')?.textContent).toBe('このランが書いたファイル');
    expect(view.querySelector('li a')?.textContent).toBe('ダウンロード');
  });
});

describe('loadSessionOutputs', () => {
  it('fails as a whole when one run’s listing fails', async () => {
    await expect(
      loadSessionOutputs(['r1', 'r2'], (runId) =>
        runId === 'r2' ? Promise.reject(new Error('down')) : Promise.resolve([file('r1', 'a')]),
      ),
    ).rejects.toThrow('down');
  });
});

describe('RunView and run outputs', () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  async function requestedPaths(filesEnabled: boolean): Promise<string[]> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetch = vi.fn<(input: unknown) => Promise<never>>(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetch);
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <RunView
          run={MOCKUP_RUN_COMPLETED}
          sessionId="s1"
          runIds={['r1']}
          filesEnabled={filesEnabled}
        />,
      );
      await Promise.resolve();
    });
    return fetch.mock.calls.map(([input]) => String(input));
  }

  it('asks Files for a completed run’s outputs folder', async () => {
    const paths = await requestedPaths(true);
    expect(paths.some((path) => path.includes('/api/files?path=runs%2Fr1%2Foutputs'))).toBe(true);
  });

  it('asks nothing when Files is switched off', async () => {
    const paths = await requestedPaths(false);
    expect(paths.some((path) => path.includes('/api/files'))).toBe(false);
  });
  it('says its own language, since <html> stays en for the English parts of the run view', async () => {
    const outputs = vi.fn(() => Promise.resolve([file('r1', 'report.md')]));
    const ja = await render({ runIds: ['r1'], settled: true, locale: 'ja', outputs });
    expect(ja.querySelector('section')?.getAttribute('lang')).toBe('ja');
    expect(ja.querySelector('h3')?.textContent).toBe('このランが書いたファイル');
  });
});

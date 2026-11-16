import { expect, it } from 'vitest';
import { FileResourceSchema } from '@indx-workspace/contracts/files';
import type { FileReadFixture } from './list-download.harness.test-support';

export function registerFileReadDownloadsTests(
  getFixture: () => Pick<FileReadFixture, 'save' | 'download' | 'listed' | 'list'>,
) {
  // @story US-STO-05
  it('[US-STO-05][api][sdk] download is a streamed attachment with nosniff', async () => {
    const testContext = getFixture();

    await testContext.save('pages/index.html', '<script>alert(1)</script>');

    const response = await testContext.download('a', 'pages/index.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="index\.html"/u,
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe('25');
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(await response.text()).toBe('<script>alert(1)</script>');
    expect((await testContext.download('b', 'pages/index.html')).status).toBe(404);
  });

  // @story US-STO-05
  it('[US-STO-05][api][sdk] a member cannot read a visitor attachment, and a folder answers its metadata', async () => {
    const testContext1 = getFixture();

    const visitor = '.attachments/33333333-3333-4333-8333-333333333333/scan.txt';
    await testContext1.save(visitor, 'visitor');
    await testContext1.save('docs/a.txt', 'a');

    expect((await testContext1.download('a', visitor)).status).toBe(404);
    expect((await testContext1.listed('a')).map((entry) => entry.path)).toEqual(['docs']);
    expect((await testContext1.list('a', '.attachments')).status).toBe(404);

    const folder = await testContext1.download('a', 'docs');
    expect(folder.status).toBe(200);
    expect(
      FileResourceSchema.parse(((await folder.json()) as { file: unknown }).file),
    ).toMatchObject({
      path: 'docs',
      kind: 'folder',
    });
    expect((await testContext1.download('b', 'docs')).status).toBe(404);
  });
}

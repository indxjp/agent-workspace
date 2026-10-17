import { createHash } from 'node:crypto';

import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { TOOL_BUNDLE_MAX_BYTES } from '@indx-workspace/contracts/agent-versions';
import { describe, expect, it, vi } from 'vitest';

import { getToolBundle, toolBundleLookup, uploadToolBundle } from './handlers';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OTHER = '77777777-7777-4777-8777-777777777777';

const SOURCE = 'export default async () => "ok";\n';
const DIGEST = createHash('sha256').update(SOURCE).digest('hex');
const upload = (source: string) => ({ contentBase64: Buffer.from(source).toString('base64') });

function stores() {
  const provider = createInMemoryObjectStoreProvider();
  return { mine: provider.forWorkspace(WORKSPACE), theirs: provider.forWorkspace(OTHER) };
}

describe('uploadToolBundle', () => {
  it('stores the bytes under their SHA-256 and answers 201 created', async () => {
    const { mine } = stores();
    const result = await uploadToolBundle(mine, upload(SOURCE));
    expect(result).toEqual({
      status: 201,
      body: { bundle: { digest: DIGEST, sizeBytes: SOURCE.length }, created: true },
    });
    const stored = await mine.get(`tool-bundles/${DIGEST}.mjs`);
    expect(Buffer.from(stored?.body ?? []).toString()).toBe(SOURCE);
  });

  it('is idempotent: a second upload answers 200 created:false and writes nothing', async () => {
    const { mine } = stores();
    await uploadToolBundle(mine, upload(SOURCE));
    const put = vi.spyOn(mine, 'put');
    const again = await uploadToolBundle(mine, upload(SOURCE));
    expect(again).toEqual({
      status: 200,
      body: { bundle: { digest: DIGEST, sizeBytes: SOURCE.length }, created: false },
    });
    expect(put).not.toHaveBeenCalled();
  });

  it('gives different bytes a different digest', async () => {
    const { mine } = stores();
    const first = await uploadToolBundle(mine, upload(SOURCE));
    const second = await uploadToolBundle(mine, upload(`${SOURCE}// changed\n`));
    expect(second.status).toBe(201);
    expect(second.body).not.toEqual(first.body);
  });

  it('keeps workspaces apart: the same bytes are created again in another workspace', async () => {
    const { mine, theirs } = stores();
    await uploadToolBundle(mine, upload(SOURCE));
    expect((await uploadToolBundle(theirs, upload(SOURCE))).status).toBe(201);
    expect((await getToolBundle(theirs, DIGEST)).status).toBe(200);
  });

  it.each([
    ['an unknown key', { ...upload(SOURCE), extra: true }],
    ['an empty string', { contentBase64: '' }],
    ['text that is not base64', { contentBase64: 'not base64!' }],
    ['a missing field', {}],
    ['a body that is not an object', 'x'],
  ])('refuses %s with 400 invalid_tool_bundle', async (_name, body) => {
    const { mine } = stores();
    const result = await uploadToolBundle(mine, body);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'invalid_tool_bundle' } });
    expect(await mine.list('tool-bundles')).toEqual([]);
  });

  it('refuses a bundle over the cap with 413 tool_bundle_too_large', async () => {
    const { mine } = stores();
    const bytes = Buffer.alloc(TOOL_BUNDLE_MAX_BYTES + 1, 'a');
    const result = await uploadToolBundle(mine, { contentBase64: bytes.toString('base64') });
    expect(result.status).toBe(413);
    expect(result.body).toMatchObject({ error: { code: 'tool_bundle_too_large' } });
  });
});

describe('getToolBundle', () => {
  it('answers the stored bundle', async () => {
    const { mine } = stores();
    await uploadToolBundle(mine, upload(SOURCE));
    expect(await getToolBundle(mine, DIGEST)).toEqual({
      status: 200,
      body: { bundle: { digest: DIGEST, sizeBytes: SOURCE.length } },
    });
  });

  it.each([DIGEST, 'not-a-digest', 7, undefined])(
    'answers 404 for %s when absent',
    async (digest) => {
      const { mine } = stores();
      const result = await getToolBundle(mine, digest);
      expect(result.status).toBe(404);
      expect(result.body).toMatchObject({ error: { code: 'tool_bundle_not_found' } });
    },
  );
});

describe('toolBundleLookup', () => {
  it('names the digests the workspace has no bundle for, in the order asked', async () => {
    const { mine } = stores();
    await uploadToolBundle(mine, upload(SOURCE));
    const absent = 'c'.repeat(64);
    expect(await toolBundleLookup(mine)([absent, DIGEST])).toEqual([absent]);
  });
});

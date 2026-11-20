import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';

import { aw, changed, chatApp, removeProjectsAfterEach, tree } from './generate.test-support.js';

removeProjectsAfterEach();

describe('aw generate channel (#1519)', () => {
  it('writes the channel, its events route and page, and edits each route file by one line', async () => {
    const root = await chatApp();
    const before = await tree(root);

    const run = await aw(root, ['generate', 'channel', 'message']);
    const after = await tree(root);

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(changed(before, after)).toEqual([
      'app/api/channels/message/events/route.ts',
      'app/api/messages/[id]/route.ts',
      'app/api/messages/route.ts',
      'app/channels/message/[key]/page.tsx',
      'aw-generated.json',
      'channels/message.ts',
    ]);
    expect(after['channels/message.ts']).toContain(
      "export default channel('message', { resource: roomResource, key: 'room' });",
    );
    // Pinned here rather than in a snapshot file: packages/aw/src/commands holds commands only.
    expect(after['app/api/messages/route.ts']).toBe(
      [
        "import message from '@/resources/message';",
        "import { resourceRoutes } from '@indx-workspace/app/server';",
        "import messageChannel from '@/channels/message';",
        'export const { GET, POST } = resourceRoutes(message, { publish: messageChannel });',
        '',
      ].join('\n'),
    );
    expect(after['app/api/messages/[id]/route.ts']).toBe(
      [
        "import message from '@/resources/message';",
        "import { resourceItemRoutes } from '@indx-workspace/app/server';",
        "import messageChannel from '@/channels/message';",
        'export const { GET, PATCH, DELETE } = resourceItemRoutes(message, { publish: messageChannel });',
        '',
      ].join('\n'),
    );
    const manifest = JSON.parse(after['aw-generated.json'] ?? '{}') as {
      entries: Record<string, { files: Record<string, string>; edits: unknown[] }>;
    };
    expect(Object.keys(manifest.entries['channel:message']?.files ?? {})).toEqual([
      'app/api/channels/message/events/route.ts',
      'app/channels/message/[key]/page.tsx',
      'channels/message.ts',
    ]);
    expect(manifest.entries['channel:message']?.edits).toHaveLength(4);
  });
});

describe('aw generate channel refusals and destroy (#1519)', () => {
  it('refuses a resource with no ref() to key on, as channel_key_required, and writes nothing', async () => {
    const root = await chatApp();
    const before = await tree(root);

    const room = await aw(root, ['generate', 'channel', 'room']);
    const wrongKey = await aw(root, ['generate', 'channel', 'message', '--key', 'thread_root']);
    const missing = await aw(root, ['generate', 'channel', 'reaction']);

    expect(room.code).toBe(EXIT_CODE.usage);
    expect(room.stderr).toContain('channel_key_required');
    expect(wrongKey.code).toBe(EXIT_CODE.usage);
    expect(wrongKey.stderr).toContain(
      'channel_key_required: thread_root refers to the resource itself',
    );
    expect(missing.code).toBe(EXIT_CODE.problem);
    expect(missing.stderr).toContain('there is no resource reaction here');
    expect(await tree(root)).toEqual(before);
  });

  it('destroy channel after editing channels/message.ts exits non-zero and names the file', async () => {
    const root = await chatApp();
    await aw(root, ['generate', 'channel', 'message']);
    await writeFile(path.join(root, 'channels/message.ts'), '// mine now\n');
    const before = await tree(root);

    const run = await aw(root, ['destroy', 'channel', 'message', '--yes']);

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('edited since they were generated:\n  channels/message.ts');
    expect(await tree(root)).toEqual(before);
  });

  it('destroy channel restores the route files byte for byte, and the resource can go after it', async () => {
    const root = await chatApp();
    const before = await tree(root);
    await aw(root, ['generate', 'channel', 'message']);

    const refused = await aw(root, ['destroy', 'resource', 'message', '--yes']);
    const run = await aw(root, ['destroy', 'channel', 'message', '--yes']);

    expect(refused.code).toBe(EXIT_CODE.problem);
    expect(refused.stderr).toContain('app/api/messages/route.ts');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(await tree(root)).toEqual(before);
    expect((await aw(root, ['destroy', 'resource', 'message', '--yes'])).code).toBe(EXIT_CODE.ok);
  });
});

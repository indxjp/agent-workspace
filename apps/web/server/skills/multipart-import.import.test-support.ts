import { expect, it } from 'vitest';
import { POST as importRoute } from '../../app/api/skills/route';
import { createClient } from '@indx-workspace/sdk';
import { MiB } from '../../../../tests/load/flat-memory';
import type { SkillImportFixture } from './multipart-import.harness.test-support';
import { SKILL_MD, skillMdPart, namePart, filePart } from './multipart-import.fixture.test-support';
export function registerSkillImportImportTests(
  getFixture: () => Pick<SkillImportFixture, 'catalog' | 'postParts' | 'rowTexts'>,
) {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] 15 MiB skill imports as multipart', async () => {
    const testContext = getFixture();

    const size = 15 * MiB;
    const bytes = new Uint8Array(size);
    for (let at = 0; at < size; at += 1) bytes[at] = (at * 31) % 251;
    let contentType: string | null = null;
    const client = createClient({
      baseUrl: 'https://example.invalid',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      // The SDK's own request, handed to the real route handler.
      fetch: (input, init) => {
        const request = new Request(input, init);
        contentType = request.headers.get('content-type');
        return importRoute(request);
      },
    });
    const skill = await client.skills.import({
      name: 'pricing',
      files: [
        { path: 'data/table.bin', body: new Blob([bytes]) },
        { path: 'SKILL.md', body: SKILL_MD },
      ],
    });
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/u);
    expect(skill.name).toBe('pricing');
    expect(skill.files.map((file) => file.path)).toEqual(['SKILL.md', 'data/table.bin']);
    expect(await (await testContext.catalog()).get('.skills/pricing/data/table.bin')).toMatchObject(
      {
        sizeBytes: size,
      },
    );
  }, 120_000);

  // @story US-STO-08
  it('[US-STO-08][api][sdk] each file part is one row and the response lists them', async () => {
    const testContext1 = getFixture();

    const response = await testContext1.postParts([
      namePart(),
      skillMdPart(),
      filePart('scripts/run.sh', '#!/bin/sh\n'),
      filePart('data/a.txt', 'alpha'),
    ]);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('deprecation')).toBeNull();
    const { skill } = (await response.json()) as {
      skill: { id: string; name: string; files: { path: string }[] };
    };
    expect(skill.name).toBe('pricing');
    expect(skill.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'data/a.txt',
      'scripts/run.sh',
    ]);
    const listed = await (await testContext1.catalog()).listSkills();
    expect(listed.map((row) => [row.name, row.id])).toEqual([['pricing', skill.id]]);
    expect(await testContext1.rowTexts('.skills/pricing')).toEqual({
      '.skills/pricing/SKILL.md': SKILL_MD,
      '.skills/pricing/data/a.txt': 'alpha',
      '.skills/pricing/scripts/run.sh': '#!/bin/sh\n',
    });
  });
}

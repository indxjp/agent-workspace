import { expect, it } from 'vitest';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import type { SkillImportFixture } from './multipart-import.harness.test-support';
import { SKILL_MD, skillMdPart, namePart, filePart } from './multipart-import.fixture.test-support';
export function registerSkillImportRecoveryTests(
  getFixture: () => Pick<
    SkillImportFixture,
    'install' | 'postParts' | 'expectNothingSaved' | 'post'
  >,
) {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] a failed save releases the name and removes what was saved', async () => {
    const testContext = getFixture();

    const inner = createInMemoryObjectStore();
    let streams = 0;
    testContext.install({
      ...inner,
      write: (key, body, options) => {
        if ((streams += 1) < 3) return inner.write(key, body, options);
        return Promise.reject(new Error('object store down'));
      },
    });
    const parts = [namePart(), skillMdPart(), filePart('a.txt', 'a'), filePart('b.txt', 'b')];
    const outcome = await testContext.postParts(parts).then(
      (response) => response.status,
      () => 'threw',
    );
    expect(outcome).not.toBe(201);
    await testContext.expectNothingSaved();
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] the JSON body still imports, with a Deprecation header', async () => {
    const testContext1 = getFixture();

    const json = JSON.stringify({
      name: 'pricing',
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from(SKILL_MD).toString('base64') }],
    });
    const response = await testContext1.post({ body: json, contentType: 'application/json' });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get('deprecation')).toBe('@1792800000');

    const refused = await testContext1.post({ body: 'x', contentType: 'text/plain' });
    expect(refused.status).toBe(415);
    expect(await refused.clone().json()).toEqual({
      error: {
        code: 'unsupported_media_type',
        message: 'This route accepts multipart/form-data or application/json.',
      },
    });
    expect(refused.headers.get('deprecation')).toBeNull();
  });
}

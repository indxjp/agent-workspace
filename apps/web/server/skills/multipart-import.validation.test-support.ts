import { expect, it } from 'vitest';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';
import { generatedBody } from '../../../../tests/load/flat-memory';
import type { SkillImportFixture } from './multipart-import.harness.test-support';
import {
  bytesOf,
  type PartSpec,
  multipart,
  skillMdPart,
  namePart,
  filePart,
  bigPart,
  codeOf,
} from './multipart-import.fixture.test-support';
export function registerSkillImportValidationTests(
  getFixture: () => Pick<
    SkillImportFixture,
    'postParts' | 'expectNothingSaved' | 'post' | 'rowTexts'
  >,
) {
  // @story US-STO-08
  it('[US-STO-08][api][sdk] a body over the limit answers 413 and saves nothing', async () => {
    const testContext = getFixture();

    const declared = await testContext.postParts([namePart(), skillMdPart()], {
      'content-length': String(MAX_SKILL_REQUEST_BODY_BYTES + 1),
    });
    expect(declared.status).toBe(413);
    await testContext.expectNothingSaved();

    // No Content-Length: the running total across parts stops it, the byte after the limit.
    const overhead = multipart([namePart(), skillMdPart(), bigPart(generatedBody(0), 0)]).length;
    const over = MAX_SKILL_REQUEST_BODY_BYTES - overhead + 1;
    const counted = await testContext.postParts([
      namePart(),
      skillMdPart(),
      bigPart(generatedBody(over), over),
    ]);
    expect(counted.status, await counted.clone().text()).toBe(413);
    expect(await codeOf(counted)).toBe('request_body_too_large');
    await testContext.expectNothingSaved();

    // One byte fewer fits, and the refused import released the name.
    const fits = over - 1;
    const accepted = await testContext.postParts([
      namePart(),
      skillMdPart(),
      bigPart(generatedBody(fits), fits),
    ]);
    expect(accepted.status, await accepted.clone().text()).toBe(201);
  }, 120_000);

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a bad, repeated or colliding path leaves nothing saved', async () => {
    const testContext1 = getFixture();

    const cases: [PartSpec[], number, string][] = [
      [[filePart('ok.txt'), filePart('../evil.txt')], 400, 'inadmissible_path'],
      [[filePart('ok.txt'), filePart('/abs.txt')], 400, 'inadmissible_path'],
      [[filePart('ok.txt'), filePart('ok.txt')], 400, 'duplicate_path'],
      [[filePart('SKILL.md')], 400, 'duplicate_path'],
      [[filePart('Doc.txt'), filePart('doc.txt')], 409, 'colliding_paths'],
      [[{ name: 'file', content: bytesOf('x') }], 400, 'malformed_file_entry'],
      [[{ name: 'extra', filename: 'a.txt', content: bytesOf('x') }], 400, 'malformed_file_entry'],
    ];
    for (const [parts, status, code] of cases) {
      const response = await testContext1.postParts([namePart(), skillMdPart(), ...parts]);
      expect([response.status, await codeOf(response)]).toEqual([status, code]);
      await testContext1.expectNothingSaved();
    }
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a refused head or a cut-off body leaves nothing saved', async () => {
    const testContext2 = getFixture();

    const invalidUtf8: PartSpec = {
      ...skillMdPart(),
      content: new Uint8Array([0xff, 0xfe, 0x41]),
    };
    const cases: [PartSpec[], number, string][] = [
      [[skillMdPart()], 400, 'missing_name'],
      [[namePart(''), skillMdPart()], 400, 'missing_name'],
      [[namePart('Not Valid'), skillMdPart()], 400, 'invalid_name'],
      [[namePart('a'.repeat(2000)), skillMdPart()], 400, 'invalid_name'],
      [[namePart(), filePart('a.txt')], 400, 'missing_skill_md'],
      [[namePart()], 400, 'missing_skill_md'],
      [[namePart(), invalidUtf8], 400, 'malformed_content'],
      [[namePart(), { ...skillMdPart(), content: bytesOf('  \n') }], 400, 'malformed_content'],
    ];
    for (const [parts, status, code] of cases) {
      const response = await testContext2.postParts(parts);
      expect([response.status, await codeOf(response)]).toEqual([status, code]);
      await testContext2.expectNothingSaved();
    }

    // Cut off after a file started: the stream fails mid-save, and the row and object go.
    const whole = multipart([namePart(), skillMdPart(), filePart('a.txt', 'abcdef')]);
    const bytes = new Uint8Array(await new Response(whole.body).arrayBuffer());
    const cut = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, bytes.length - 20));
        controller.close();
      },
    });
    const response = await testContext2.post({ body: cut, contentType: whole.contentType });
    expect([response.status, await codeOf(response)]).toEqual([400, 'malformed_body']);
    await testContext2.expectNothingSaved();
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a name already taken answers 409 and keeps the first skill', async () => {
    const testContext3 = getFixture();

    expect(
      (await testContext3.postParts([namePart(), skillMdPart(), filePart('a.txt', 'one')])).status,
    ).toBe(201);
    const before = await testContext3.rowTexts('.skills/pricing');
    const again = await testContext3.postParts([
      namePart(),
      skillMdPart(),
      filePart('a.txt', 'two'),
    ]);
    expect([again.status, await codeOf(again)]).toEqual([409, 'skill_already_exists']);
    expect(await testContext3.rowTexts('.skills/pricing')).toEqual(before);
  });
}

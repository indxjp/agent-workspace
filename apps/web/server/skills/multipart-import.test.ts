import { beforeAll } from 'vitest';
import { startFixtureDatabase } from './multipart-import.fixture.test-support';
beforeAll(() => startFixtureDatabase(process.env['TEST_DATABASE_URL']), 180_000);
import { describe, expect, it } from 'vitest';
import { MAX_SKILL_REQUEST_BODY_BYTES } from '@indx-workspace/contracts/skills';
import { MultipartReader, multipartBoundary, SkillMultipartRefused } from './multipart';
import { createSkillImportFixture } from './multipart-import.harness.test-support';
import { registerSkillImportMemoryTests } from './multipart-import.memory.test-support';
import { registerSkillImportImportTests } from './multipart-import.import.test-support';
import { registerSkillImportValidationTests } from './multipart-import.validation.test-support';
import { registerSkillImportRecoveryTests } from './multipart-import.recovery.test-support';
import {
  type World,
  bytesOf,
  multipart,
  namePart,
  filePart,
  memoryWorld,
  postgresWorld,
} from './multipart-import.fixture.test-support';
function defineSuite(name: string, setup: () => Promise<World>, phase: 'memory' | 'behaviour') {
  describe(`multipart skill import on the ${name} (${phase})`, () => {
    const fixture = createSkillImportFixture(setup);
    registerSkillImportMemoryTests(() => fixture);
    if (phase === 'memory') return;
    registerSkillImportImportTests(() => fixture);
    registerSkillImportValidationTests(() => fixture);
    registerSkillImportRecoveryTests(() => fixture);
  });
}
defineSuite('in-memory catalog', memoryWorld, 'memory');
defineSuite('PostgreSQL catalog', postgresWorld, 'memory');
defineSuite('in-memory catalog', memoryWorld, 'behaviour');
defineSuite('PostgreSQL catalog', postgresWorld, 'behaviour');
function readerOver(bytes: Uint8Array, chunkSize: number): MultipartReader {
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
  return new MultipartReader(body, 'skill-test-boundary', MAX_SKILL_REQUEST_BODY_BYTES);
}
const must = <T>(value: T | null): T => {
  if (value === null) throw new Error('expected a value');
  return value;
};
const bytesOfBody = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(body).arrayBuffer());
describe('multipart reader', () => {
  // @story US-STO-08
  it('[US-STO-08][unit][sdk] reads parts split at any byte and skips a part left unread', async () => {
    // Content that starts like a delimiter and is not one must come through whole.
    const tricky = 'a\r\n--skill-test-boun\r\n--\r\nb';
    const sent = multipart([namePart(), filePart('a.txt', tricky), filePart('b.txt', 'last')]);
    const whole = Buffer.concat([
      bytesOf('preamble\r\n'),
      await bytesOfBody(sent.body),
      bytesOf('epilogue'),
    ]);
    for (const chunkSize of [1, 7, 4096]) {
      const reader = readerOver(whole, chunkSize);
      expect((await reader.next())?.name).toBe('name');
      const second = must(await reader.next());
      expect([second.name, second.filename]).toEqual(['file', 'a.txt']);
      expect(new TextDecoder().decode(await bytesOfBody(second.body))).toBe(tricky);
      expect((await reader.next())?.filename).toBe('b.txt');
      expect(await reader.next()).toBeNull();
    }
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] a body that ends inside a part fails the part stream and is remembered', async () => {
    const head = '--skill-test-boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\nabc';
    const reader = readerOver(bytesOf(head), 5);
    const part = must(await reader.next());
    await expect(bytesOfBody(part.body)).rejects.toBeInstanceOf(SkillMultipartRefused);
    expect(reader.refusal?.status).toBe(400);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] refuses a part header over the cap even when it arrives in one chunk', async () => {
    const head = `--skill-test-boundary\r\nContent-Disposition: form-data; name="name"\r\nX-Pad: ${'a'.repeat(9000)}\r\n\r\nabc`;
    const reader = readerOver(bytesOf(head), 64 * 1024);
    await expect(reader.next()).rejects.toBeInstanceOf(SkillMultipartRefused);
    expect(reader.refusal?.status).toBe(400);
  });

  // @story US-STO-08
  it('[US-STO-08][unit][sdk] finds the boundary parameter, quoted or not, up to 70 characters', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc');
    expect(multipartBoundary('multipart/form-data; charset=utf-8; boundary="a b"')).toBe('a b');
    expect(multipartBoundary('multipart/form-data')).toBeNull();
    expect(multipartBoundary(`multipart/form-data; boundary=${'a'.repeat(71)}`)).toBeNull();
  });
});

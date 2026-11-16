/**
 * W2-CP-03's verification-round counter-examples against the files routes. Harness:
 * `routes.test-support.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute } from '../../app/api/files/route';
import { clearApplicationContext } from '../application-context';
import {
  WORKSPACE_A,
  download,
  expectError,
  installDefaultWorld,
  remove,
  req,
  upload,
} from './routes.test-support';

beforeEach(() => {
  installDefaultWorld();
});

afterEach(() => {
  clearApplicationContext();
});

/**
 * The four counter-examples W2-CP-03's verification round 1 built and ran against these very route
 * handlers, kept as tests so the defects they found cannot come back. Each one is the verifier's
 * own reproduction, not a paraphrase of it.
 */
describe('verification round 1 counter-examples, driven through the real route handlers', () => {
  const post = (filePath: string, body: string, contentType?: string): Promise<Response> =>
    upload(filePath, body, { contentType });

  it('F2: a doubly-encoded path is refused, and does not overwrite the object it used to decode to', async () => {
    expect((await post('a/b', 'VICTIM BYTES')).status).toBe(201);

    await expectError(await post('a%252fb', 'ATTACKER BYTES'), 400, 'invalid_path');

    // The victim is untouched, and still reachable under its own id and its own path.
    const victim = await download('a/b');
    expect(victim.status).toBe(200);
    expect(await victim.text()).toBe('VICTIM BYTES');

    const listed = await listRoute(req('GET', '/api/files?path=a', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['a/b']);
  });

  it("F3: a key naming the metadata sidecar is refused in every spelling, so no uploader can choose another file's content type", async () => {
    expect((await post('note.txt', 'hello', 'text/plain')).status).toBe(201);

    // Round 2 closed only the first of these. Round 3 re-ran the whole of F3's evidence through
    // this same route with the second one and got a `201`, a forged content type on the victim,
    // and a listing that hid the file it had just created — because this route's filesystem folds
    // case. Every spelling that a folding namespace resolves to the sidecar is asserted here.
    const spellings = [
      'note.txt.__objectstore_meta__.json',
      'note.txt.__objectstore_meta__.JSON',
      'note.txt.__ObjectStore_Meta__.json',
      'NOTE.TXT.__OBJECTSTORE_META__.JSON',
      'note.txt.__objectstore_meta__.json::$DATA',
      'note.txt.%__objectstore_meta__%.json',
    ];
    for (const spelling of spellings) {
      const forge = await post(spelling, '{"contentType":"text/html"}');
      expect(forge.status, `POST ${spelling}`).toBe(400);
      expect(await forge.json()).toMatchObject({ error: { code: 'invalid_path' } });
    }

    expect((await download('note.txt')).headers.get('content-type')).toBe('text/plain');

    // And the listing is complete: `list()` filters nothing at all now, so there is no filter for
    // a stored file to hide behind.
    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path)).toEqual(['note.txt']);
  });

  it('B1: the NTFS 8.3 alias of a sidecar is an ordinary file, forges nothing, and is listed', async () => {
    // Verification round 4's counter-example, end to end. `NOTETX~1.JSO` was the short name NTFS
    // minted for `note.txt`'s sidecar when sidecars lived beside their objects: it contains no
    // marker and no `%`, so it was a legal key, and posting it forged the content type this route
    // reported for `note.txt` while being absent from its own listing. Metadata now lives in a
    // tree no key resolves into, so this key is simply a file called `NOTETX~1.JSO`.
    //
    // The name is asserted as a legal key rather than refused on purpose: refusing it would be
    // another spelling rule, and a spelling rule is what failed three times.
    expect((await post('note.txt', 'hello', 'text/plain')).status).toBe(201);
    expect((await post('NOTETX~1.JSO', '{"contentType":"text/html"}')).status).toBe(201);

    const note = await download('note.txt');
    expect(note.headers.get('content-type')).toBe('text/plain');
    expect(await note.text()).toBe('hello');

    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    const body = (await listed.json()) as { files: Array<{ path: string }> };
    expect(body.files.map((f) => f.path).sort()).toEqual(['NOTETX~1.JSO', 'note.txt']);
  });

  it('F4: an uploaded script is not served back as active content from this origin', async () => {
    const payload = '<script>alert(document.domain)</script>';
    // The uploader declares HTML; the download still answers with a type from the closed table.
    expect((await post('pwn.html', payload, 'text/html')).status).toBe(201);

    const served = await download('pwn.html');
    expect(served.status).toBe(200);
    // The bytes are returned unchanged — this is a delivery fix, not a sanitising one.
    expect(await served.clone().text()).toBe(payload);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toBe(
      `attachment; filename="pwn.html"; filename*=UTF-8''pwn.html`,
    );
  });

  it('F4b: a filename that could break the Content-Disposition quoting cannot', async () => {
    // `;` is the parameter separator this header is built from, and a space ends an unquoted
    // token: between them they are the injection shape a naive builder would fall to. (A control
    // character cannot get this far — `key-safety.ts` refuses one outright. A `\"` cannot be
    // stored by the local-filesystem backend on Windows at all, which is a carried gap declared on
    // this PR, not something this test can drive.)
    const name = 'a;b, c.txt';
    expect((await post(name, 'x')).status).toBe(201);
    const disposition = (await download(name)).headers.get('content-disposition') ?? '';
    expect(disposition).toBe(
      `attachment; filename="a_b__c.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    // One quoted string, one `filename*`: the caller's punctuation did not open a parameter.
    expect(disposition.split('"').length - 1).toBe(2);
  });

  it('F5: an input the guard refuses is a 400 invalid_path, never an uncaught 500', async () => {
    await expectError(await post('%252e%252e%252fx', 'x'), 400, 'invalid_path');
  });

  it('every response carries nosniff, not only the binary one', async () => {
    const listed = await listRoute(req('GET', '/api/files', { workspace: WORKSPACE_A }));
    expect(listed.headers.get('x-content-type-options')).toBe('nosniff');
    await post('gone.txt', 'x');
    const deleted = await remove('gone.txt');
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

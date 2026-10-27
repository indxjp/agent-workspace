/**
 * A streaming reader for the `multipart/form-data` body of `POST /api/skills` (the storage design,
 * §07 US-STO-08). `Request.formData()` buffers the whole body, so a 16 MiB import would be held
 * whole; this reader hands each part out as a stream, holding only the bytes that could still turn
 * out to be the start of the next delimiter.
 */
import {
  MAX_SKILL_REQUEST_BODY_BYTES,
  SKILL_IMPORT_MULTIPART,
} from '@indx-workspace/contracts/skills';

import type { ApiResult } from '../http/result';
import { declaredLengthRefusal, tooLarge } from './http';
import { problem } from './result';

const MAX_PART_HEADER_BYTES = 8 * 1024;

/** Thrown out of the reader, and out of a part's stream, when the body is refused. */
export class SkillMultipartRefused extends Error {
  public constructor(public readonly result: ApiResult) {
    super('skill multipart import refused');
    this.name = 'SkillMultipartRefused';
  }
}

/** One part of the body. `body` must be read to its end, or left for the next `next()` to skip. */
export interface MultipartPart {
  readonly name: string;
  readonly filename: string | null;
  readonly body: ReadableStream<Uint8Array>;
}

export function isMultipartContentType(contentType: string | null): boolean {
  return contentType?.toLowerCase().startsWith(SKILL_IMPORT_MULTIPART.mediaType) === true;
}

/** The `boundary` parameter (1-70 characters), or `null` when there is none. */
export function multipartBoundary(contentType: string | null): string | null {
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^;\s"]{1,70}))\s*(?:;|$)/i.exec(
    contentType ?? '',
  );
  return match?.[1] ?? match?.[2] ?? null;
}

export class MultipartReader {
  /** The refusal this reader threw, so a caller can recover it when a writer wrapped the error. */
  public refusal: ApiResult | null = null;
  private readonly source: ReadableStreamDefaultReader<Uint8Array>;
  private readonly delimiter: Buffer;
  // The body is read as if a CRLF came before it, so the first delimiter matches like the rest.
  private buffer: Buffer = Buffer.from('\r\n');
  private total = 0;
  private state: 'before' | 'content' | 'after' | 'end' = 'before';

  public constructor(
    body: ReadableStream<Uint8Array>,
    boundary: string,
    private readonly maxBytes: number,
  ) {
    this.source = body.getReader();
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
  }

  /** The next part, or `null` after the closing delimiter. Skips what is left of the last part. */
  public async next(): Promise<MultipartPart | null> {
    while (this.state === 'before' || this.state === 'content') await this.take();
    if (this.state === 'end') return null;

    await this.need(2);
    if (this.buffer.subarray(0, 2).toString('latin1') === '--') {
      this.state = 'end';
      return null;
    }
    if (this.buffer.subarray(0, 2).toString('latin1') !== '\r\n') {
      this.malformed('a delimiter is not followed by a line break');
    }
    // Headers end at the first blank line; the CRLF that follows the delimiter opens them.
    let end = this.buffer.indexOf('\r\n\r\n');
    while (end < 0) {
      if (this.buffer.length > MAX_PART_HEADER_BYTES) this.malformed('a part header is too long');
      if (!(await this.fill())) this.malformed('the body ended inside a part header');
      end = this.buffer.indexOf('\r\n\r\n');
    }
    // A header block that arrived in one large chunk skipped the check above.
    if (end > MAX_PART_HEADER_BYTES) this.malformed('a part header is too long');
    const lines = this.buffer.subarray(0, end).toString('utf8').split('\r\n').slice(1);
    this.buffer = this.buffer.subarray(end + 4);
    this.state = 'content';

    const disposition = lines.find((line) => /^content-disposition\s*:/i.test(line));
    const name = /;\s*name="([^"]*)"/i.exec(disposition ?? '')?.[1];
    if (name === undefined) this.malformed('a part has no Content-Disposition name');
    const filename = /;\s*filename="([^"]*)"/i.exec(disposition ?? '')?.[1] ?? null;
    return {
      name,
      filename,
      body: new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            const { chunk, last } = await this.take();
            if (chunk.length > 0) controller.enqueue(chunk);
            if (last) controller.close();
          },
        },
        { highWaterMark: 0 },
      ),
    };
  }

  /** Stops reading the request body. */
  public async close(): Promise<void> {
    await this.source.cancel().catch(() => undefined);
  }

  // The next run of the current part's bytes. It is `last` when the closing delimiter was found,
  // and it holds back the tail that could still be the start of one.
  private async take(): Promise<{ chunk: Buffer; last: boolean }> {
    for (;;) {
      const at = this.buffer.indexOf(this.delimiter);
      if (at >= 0) {
        const chunk = this.buffer.subarray(0, at);
        this.buffer = this.buffer.subarray(at + this.delimiter.length);
        this.state = 'after';
        return { chunk, last: true };
      }
      const safe = this.buffer.length - (this.delimiter.length - 1);
      if (safe > 0) {
        const chunk = this.buffer.subarray(0, safe);
        this.buffer = this.buffer.subarray(safe);
        return { chunk, last: false };
      }
      if (!(await this.fill())) this.malformed('the body ended before its closing delimiter');
    }
  }

  private async need(count: number): Promise<void> {
    while (this.buffer.length < count) {
      if (!(await this.fill())) this.malformed('the body ended before its closing delimiter');
    }
  }

  // The running total counts every byte of the request, framing included, across all parts.
  private async fill(): Promise<boolean> {
    const { done, value } = await this.source.read();
    if (done) return false;
    this.total += value.byteLength;
    if (this.total > this.maxBytes) {
      await this.close();
      this.fail(tooLarge('sent more than that and was not read to the end'));
    }
    this.buffer = Buffer.concat([this.buffer, value]);
    return true;
  }

  private malformed(why: string): never {
    return this.fail(problem(400, 'malformed_body', `The multipart body is malformed: ${why}.`));
  }

  private fail(result: ApiResult): never {
    this.refusal = result;
    throw new SkillMultipartRefused(result);
  }
}

/** The reader for a `multipart/form-data` request, or the refusal when its head is not acceptable. */
export function openMultipartImport(
  request: Request,
): { ok: true; reader: MultipartReader } | { ok: false; result: ApiResult } {
  const refusal = declaredLengthRefusal(request);
  if (refusal !== null) return { ok: false, result: refusal };
  const boundary = multipartBoundary(request.headers.get('content-type'));
  if (boundary === null) {
    return {
      ok: false,
      result: problem(
        400,
        'malformed_body',
        'The multipart Content-Type has no boundary parameter of 1 to 70 characters.',
      ),
    };
  }
  const reader = new MultipartReader(
    request.body ?? new Blob([]).stream(),
    boundary,
    MAX_SKILL_REQUEST_BODY_BYTES,
  );
  return { ok: true, reader };
}

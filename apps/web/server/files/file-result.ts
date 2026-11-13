import { problemBody } from '../http/result';

/** A status and a body, before either becomes an HTTP `Response`. `kind` tags the json, binary and empty arms. */
export type FileResult =
  | { readonly status: number; readonly kind: 'json'; readonly body: unknown }
  | {
      readonly status: number;
      readonly kind: 'binary';
      readonly body: Uint8Array;
      /** Already reduced to an inert type by {@link downloadContentType}; never caller text. */
      readonly contentType: string;
      /** The file's own name, for `http.ts`'s `Content-Disposition: attachment`. */
      readonly filename: string;
    }
  | {
      readonly status: number;
      readonly kind: 'stream';
      /** Handed to the response as is: the object is never held whole in memory. */
      readonly body: ReadableStream<Uint8Array>;
      readonly sizeBytes: number;
      /** Reduced by {@link downloadContentType}, as for the binary arm. */
      readonly contentType: string;
      readonly filename: string;
    }
  | { readonly status: 204; readonly kind: 'empty' };

export function problem(
  status: number,
  code: string,
  message: string,
  details?: readonly string[],
): FileResult {
  return { status, kind: 'json', body: problemBody(code, message, details) };
}
export function json(status: number, body: unknown): FileResult {
  return { status, kind: 'json', body };
}

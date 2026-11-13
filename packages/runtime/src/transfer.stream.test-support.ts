import { encodeUstar, type StreamTarEntry } from './transfer.js';

export function fileEntry(
  name: string,
  content: Uint8Array,
  size = content.byteLength,
): StreamTarEntry {
  return {
    path: name,
    type: 'file',
    mode: 0o644,
    size,
    open: () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(content);
            controller.close();
          },
        }),
      ),
  };
}

export function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) controller.close();
      else controller.enqueue(bytes.slice(offset, (offset += size)));
    },
  });
}

export function forge(
  archive: Uint8Array,
  edit: (header: Buffer) => void,
  sign = true,
): Uint8Array {
  const copy = Buffer.from(archive);
  const header = copy.subarray(0, 512);
  edit(header);
  if (sign) {
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  }
  return copy;
}

export const smallArchive = encodeUstar([
  { path: 'a.txt', type: 'file', mode: 0o644, data: Buffer.from('hello') },
]);

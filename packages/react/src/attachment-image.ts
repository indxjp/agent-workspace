/**
 * Shrinks a large photo before it is uploaded as a surface attachment (ADR-0146 D7, issue #1308):
 * a phone photo is several MiB and the 10 MiB cap is per file. Anything that is not a JPEG, PNG or
 * WebP, a photo already within {@link MAX_EDGE} px, or a browser without the canvas APIs is sent
 * unchanged. Each keeps its own type, so PNG and WebP transparency survives; JPEG and WebP are
 * encoded at quality 0.85.
 */
const MAX_EDGE = 2048;
const QUALITY = 0.85;

/** `width` x `height` scaled so its long edge is at most `max`; `null` when it already fits. */
export function fitWithin(
  width: number,
  height: number,
  max: number = MAX_EDGE,
): { readonly width: number; readonly height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= max) return null;
  const scale = max / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** `file`, downscaled when it is a large image; otherwise `file` itself. Never rejects. */
export async function prepareAttachment(file: File): Promise<File> {
  if (!/^image\/(?:jpeg|png|webp)$/u.test(file.type)) return file;
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const target = fitWithin(bitmap.width, bitmap.height);
    if (target === null) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, target.width, target.height);
    bitmap.close();
    const { type } = file;
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, QUALITY);
    });
    if (blob === null || blob.size >= file.size) return file;
    return new File([blob], file.name, { type });
  } catch {
    return file;
  }
}

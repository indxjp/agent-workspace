import { describe, expect, it, vi } from 'vitest';

import { fitWithin, prepareAttachment } from './attachment-image.js';

describe('fitWithin', () => {
  it('scales the long edge down to the cap and keeps the ratio', () => {
    expect(fitWithin(4096, 3072)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(1000, 8000, 2000)).toEqual({ width: 250, height: 2000 });
  });

  it('leaves an image within the cap alone', () => {
    expect(fitWithin(2048, 1000)).toBeNull();
    expect(fitWithin(10, 10)).toBeNull();
  });
});

describe('prepareAttachment', () => {
  it('sends a non-image, and an image where there is no canvas, unchanged', async () => {
    const pdf = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    const photo = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    expect(await prepareAttachment(pdf)).toBe(pdf);
    expect(await prepareAttachment(photo)).toBe(photo);
  });

  it('keeps a large WebP as WebP, so its transparency survives', async () => {
    const encoded: string[] = [];
    vi.stubGlobal('createImageBitmap', () =>
      Promise.resolve({ width: 4096, height: 3072, close: () => undefined }),
    );
    vi.stubGlobal('document', {
      createElement: () => ({
        getContext: () => ({ drawImage: () => undefined }),
        toBlob: (done: (blob: Blob) => void, type: string) => {
          encoded.push(type);
          done(new Blob(['s'], { type }));
        },
      }),
    });
    try {
      const prepared = await prepareAttachment(
        new File(['large webp bytes'], 'logo.webp', { type: 'image/webp' }),
      );
      expect(encoded).toEqual(['image/webp']);
      expect(prepared.type).toBe('image/webp');
      expect(prepared.name).toBe('logo.webp');
      expect(prepared.size).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

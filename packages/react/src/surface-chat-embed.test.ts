import { describe, expect, it } from 'vitest';

import {
  requestEmbedClose,
  SURFACE_CLOSE_MESSAGE_TYPE,
  type EmbeddedView,
} from './surface-chat-embed.js';

interface Posted {
  readonly message: unknown;
  readonly targetOrigin: string;
}

function framed(): { readonly view: EmbeddedView; readonly posted: Posted[] } {
  const posted: Posted[] = [];
  const view: EmbeddedView = {
    self: {},
    parent: {
      postMessage(message, targetOrigin) {
        posted.push({ message, targetOrigin });
      },
    },
  };
  return { view, posted };
}

describe('requestEmbedClose (S1-18, #456)', () => {
  it('asks the embedder to close the panel on Escape from inside the frame', () => {
    const { view, posted } = framed();
    expect(requestEmbedClose({ key: 'Escape', defaultPrevented: false }, view)).toBe(true);
    expect(posted).toEqual([{ message: { type: SURFACE_CLOSE_MESSAGE_TYPE }, targetOrigin: '*' }]);
  });

  it('posts nothing for another key, a handled Escape, or a surface that is not framed', () => {
    const { view, posted } = framed();
    expect(requestEmbedClose({ key: 'Enter', defaultPrevented: false }, view)).toBe(false);
    expect(requestEmbedClose({ key: 'Escape', defaultPrevented: true }, view)).toBe(false);
    expect(posted).toEqual([]);

    const top = {
      postMessage(): void {
        throw new Error('a top-level surface posts nothing');
      },
    };
    expect(
      requestEmbedClose({ key: 'Escape', defaultPrevented: false }, { self: top, parent: top }),
    ).toBe(false);
  });
});

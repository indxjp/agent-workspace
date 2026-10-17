/**
 * How the hosted surface talks to the widget loader that embeds it (ADR-0105 slice 1; S1-18,
 * issue #456). Once a visitor clicks into the loader's iframe, keyboard focus is in the surface's
 * own document and the host page never sees an `Escape`. So the surface asks its embedder to close
 * the panel with one fixed message, and the loader (`server/surfaces/loader/render.ts`) acts on it
 * only when it comes from its own frame and from the surface's origin.
 *
 * The message carries a fixed type and nothing else, so it is posted to any embedder (`'*'`): the
 * surface cannot know the host page's origin, and there is nothing in it to protect.
 */

/** The `type` of the message that asks the loader to close the panel. */
export const SURFACE_CLOSE_MESSAGE_TYPE = 'aw-surface-close';

/** The window a surface runs in, as far as asking its embedder to close goes. */
export interface EmbeddedView {
  /** The window itself; a top-level window is its own `parent`. */
  readonly self: unknown;
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
}

/** The part of a key press the close request reads. */
export interface EscapeKey {
  readonly key: string;
  readonly defaultPrevented: boolean;
}

/**
 * Ask the embedder to close the panel when `event` is an unhandled `Escape` and `view` is framed.
 * Returns whether a request was posted; a surface opened as a page of its own posts nothing.
 */
export function requestEmbedClose(event: EscapeKey, view: EmbeddedView): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  if (view.parent === view.self) return false;
  view.parent.postMessage({ type: SURFACE_CLOSE_MESSAGE_TYPE }, '*');
  return true;
}

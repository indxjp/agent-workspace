/**
 * The hosted surface's frame for each layout (ADR-0108 rung ② `layout`; ADR-0105; S1-18, issue
 * #456). The page at `/p/s/<name>` is what the widget loader's iframe shows, so the frame fills
 * whatever the loader placed:
 *
 * - `page`: a centred column at most 760px wide, the surface opened as a page of its own. The
 *   painted root still fills the viewport, so a forced `theme.mode` repaints the whole page and
 *   not only the column (the document's own palette follows the OS);
 * - `dock` and `side`: a full-height panel with a compact header, filling the launcher's panel;
 * - `inline`: a borderless frame filling the iframe placed in the host page's flow.
 *
 * The frame owns three rows around its body: an optional `notice` above the header (the
 * local-runtime banner), the header, and an optional `footer` below the body (the composer slot).
 * For `dock` and `side` the message list scrolls and the notice, the header and the footer never
 * shrink, so the notice's height comes out of the message list and the composer stays in view
 * (issue #558). Three bounds keep that true at any panel height and any disclaimer length:
 *
 * - the message list keeps at least 6rem, so a tall composer never hides the transcript;
 * - the composer row is capped at half the frame and scrolls its own overflow (the disclaimer);
 * - when the rows still do not fit (a frame shorter than notice + header + list + composer, as the
 *   loader's `calc(100vh - 108px)` clamp gives on a short host window), the root scrolls and the
 *   composer row sticks to the bottom edge, so Send stays in view and the notice scrolls away.
 *
 * The frame still draws no message box; the form in the composer slot is `./surface-chat.tsx`'s
 * alone.
 */
import type { ReactNode } from 'react';

import type { SurfaceLayout, SurfaceLocale } from '@indx-workspace/contracts/surfaces';

import type { SurfaceThemeStyle } from './theme.js';

export interface SurfaceFrameProps {
  readonly layout: SurfaceLayout;
  readonly style: SurfaceThemeStyle;
  readonly lang: SurfaceLocale;
  /** The surface's name, carried as `data-surface`. */
  readonly surfaceName: string;
  /** A row above the header, such as the deployment's runtime banner; never scrolls away. */
  readonly notice?: ReactNode;
  readonly header: ReactNode;
  /** The composer area, below the scrolling body; pinned for `dock` and `side` (#558). */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}

/** The surface's root element, laid out for `layout` and painted with `style`. */
export function SurfaceFrame({
  layout,
  style,
  lang,
  surfaceName,
  notice,
  header,
  footer,
  children,
}: SurfaceFrameProps): ReactNode {
  const noticeRow =
    notice === undefined || notice === null ? null : (
      <div className="aw-frame-notice" data-surface-notice="">
        {notice}
      </div>
    );
  const footerRow =
    footer === undefined || footer === null ? null : (
      <div className="aw-frame-footer" data-surface-composer="">
        {footer}
      </div>
    );
  const content = (
    <>
      <div className="aw-frame-header">{header}</div>
      <div className="aw-frame-body">{children}</div>
      {footerRow}
    </>
  );
  return (
    <main
      className="aw-surface"
      style={style}
      lang={lang}
      data-layout={layout}
      data-surface={surfaceName}
    >
      {noticeRow}
      {layout === 'page' ? <div className="aw-frame-column">{content}</div> : content}
    </main>
  );
}

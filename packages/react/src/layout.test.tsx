import { SURFACE_LAYOUTS, type SurfaceLayout } from '@indx-workspace/contracts/surfaces';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SurfaceFrame } from './layout.js';
import { surfaceThemeStyle } from './theme.js';

function frame(layout: SurfaceLayout): string {
  return renderToStaticMarkup(
    <SurfaceFrame
      layout={layout}
      style={surfaceThemeStyle({ colour: '#0a7f5a' })}
      lang="ja"
      surfaceName="main"
      header={<h1>Help</h1>}
    >
      <p>body</p>
    </SurfaceFrame>,
  );
}

describe('SurfaceFrame (S1-18, #456)', () => {
  it('renders each layout with its data-layout, language, name and theme', () => {
    for (const layout of SURFACE_LAYOUTS) {
      const html = frame(layout);
      expect(html).toContain(`data-layout="${layout}"`);
      expect(html).toContain('lang="ja"');
      expect(html).toContain('data-surface="main"');
      expect(html).toContain('--accent:#0a7f5a');
      expect(html).toContain('<h1>Help</h1>');
      expect(html).toContain('<p>body</p>');
    }
  });

  it('wraps the page in its centred column and no other layout', () => {
    expect(frame('page')).toContain('class="aw-frame-column"');
    for (const layout of ['dock', 'side', 'inline'] as const) {
      expect(frame(layout)).not.toContain('aw-frame-column');
    }
  });

  it('paints the whole viewport for page, so a forced theme mode reaches past the column', () => {
    for (const layout of SURFACE_LAYOUTS) {
      const html = renderToStaticMarkup(
        <SurfaceFrame
          layout={layout}
          style={surfaceThemeStyle({ mode: 'dark' })}
          lang="en"
          surfaceName="main"
          header={null}
        >
          {null}
        </SurfaceFrame>,
      );
      const root = /^<main [^>]*>/u.exec(html)?.[0] ?? '';
      expect(root).toContain('color-scheme:dark');
      expect(root).toContain('class="aw-surface"');
    }
  });
});

function framed(layout: SurfaceLayout): string {
  return renderToStaticMarkup(
    <SurfaceFrame
      layout={layout}
      style={surfaceThemeStyle({})}
      lang="en"
      surfaceName="main"
      notice={<p>notice</p>}
      header={<h1>Help</h1>}
      footer={<form>composer</form>}
    >
      <p>body</p>
    </SurfaceFrame>,
  );
}

/** The opening tag of the element right around `marker`'s first occurrence. */
function wrapperOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div ', at);
  return html.slice(open, html.indexOf('>', open) + 1);
}

describe('SurfaceFrame keeps the composer in view (#558)', () => {
  it('pins the notice, the header and the composer around the scrolling body for dock and side', () => {
    for (const layout of ['dock', 'side'] as const) {
      const html = framed(layout);
      const root = /^<main [^>]*>/u.exec(html)?.[0] ?? '';
      expect(root).toContain('data-layout');

      expect(html.indexOf('<p>notice</p>')).toBeLessThan(html.indexOf('<h1>Help</h1>'));
      const notice = wrapperOf(html, '<p>notice</p>');
      expect(notice).toContain('data-surface-notice');
      expect(notice).toContain('aw-frame-notice');
      expect(wrapperOf(html, '<h1>Help</h1>')).toContain('aw-frame-header');

      const body = wrapperOf(html, '<p>body</p>');
      expect(body).toContain('aw-frame-body');

      const bodyStart = html.indexOf(body);
      const bodyEnd = html.indexOf('<p>body</p></div>', bodyStart) + '<p>body</p></div>'.length;
      const composerAt = html.indexOf('data-surface-composer');
      expect(bodyEnd).toBeLessThanOrEqual(composerAt);
      const composer = wrapperOf(html, '<form>composer</form>');
      expect(composer).toContain('data-surface-composer');
      expect(composer).toContain('aw-frame-footer');
    }
  });

  it('treats a null notice or footer as absent', () => {
    for (const layout of SURFACE_LAYOUTS) {
      const html = renderToStaticMarkup(
        <SurfaceFrame
          layout={layout}
          style={surfaceThemeStyle({})}
          lang="en"
          surfaceName="main"
          notice={null}
          header={<h1>Help</h1>}
          footer={null}
        >
          <p>body</p>
        </SurfaceFrame>,
      );
      expect(html).not.toContain('data-surface-notice');
      expect(html).not.toContain('data-surface-composer');
    }
  });

  it('renders notice, header, body and composer in order for page and inline', () => {
    for (const layout of ['page', 'inline'] as const) {
      const html = framed(layout);
      const order = ['<p>notice</p>', '<h1>Help</h1>', '<p>body</p>', '<form>composer</form>'].map(
        (marker) => html.indexOf(marker),
      );
      expect(order.every((index) => index > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(html).toContain('data-surface-notice');
      expect(html).toContain('data-surface-composer');
    }
    expect(framed('inline')).not.toContain('border');
  });

  it('renders no notice or composer wrapper when neither is given', () => {
    for (const layout of SURFACE_LAYOUTS) {
      const html = frame(layout);
      expect(html).not.toContain('data-surface-notice');
      expect(html).not.toContain('data-surface-composer');
    }
  });
});

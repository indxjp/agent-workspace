/**
 * The widget loader as a host page runs it (ADR-0105 slice 1; S1-18, issue #456): the rendered
 * script is evaluated by happy-dom inside a page of the loopback origin, through `<script>`
 * elements exactly as the one tag adds it, and the elements it places are read back.
 */
import { BrowserWindow, Window, type Element } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { renderWidgetLoader, type WidgetLook } from './render';

const ORIGIN = 'http://127.0.0.1:4310';

const LOOK: WidgetLook = {
  colour: '#0a7f5a',
  foreground: '#ffffff',
  radius: 12,
  layout: 'dock',
  launcherLabel: 'Open Help centre',
  frameTitle: 'Help centre',
};

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

/** A host page of the loopback origin that runs scripts and loads no frame. */
function hostPage(): { readonly window: Window; readonly errors: string[] } {
  const window = new Window({
    url: `${ORIGIN}/`,
    settings: {
      enableJavaScriptEvaluation: true,
      enableIframePageLoading: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      suppressCodeGenerationFromStringsWarning: true,
      navigation: { disableChildFrameNavigation: true },
    },
  });
  windows.push(window);
  const errors: string[] = [];
  window.addEventListener('error', (event) => {
    errors.push(event.type);
  });
  window.document.body.innerHTML = '<p id="before">Before</p><div id="slot"></div><p>After</p>';
  return { window, errors };
}

/** Add one `<script>` carrying `code` to `parent`, as the one tag would. */
function addScript(window: Window, code: string, parent: Element = window.document.body): void {
  const script = window.document.createElement('script');
  script.textContent = code;
  parent.appendChild(script);
}

function launchers(window: Window) {
  return window.document.querySelectorAll('[data-aw-surface-launcher]');
}

function frames(window: Window) {
  return window.document.querySelectorAll('iframe[data-aw-surface-frame]');
}

/** One style property of `element` as the page computes it; `''` for no element. */
function css(window: Window, element: Element | undefined, property: string): string {
  return element === undefined ? '' : window.getComputedStyle(element).getPropertyValue(property);
}

/** A CSS colour as `r,g,b`, whether it was written as `#rrggbb` or `rgb(r, g, b)`. */
function rgb(colour: string): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(colour.trim());
  if (hex !== null) {
    return hex
      .slice(1, 4)
      .map((pair) => String(Number.parseInt(pair, 16)))
      .join(',');
  }
  return colour.replace(/^rgba?\(|\)$|\s/gu, '');
}

describe('renderWidgetLoader in a host page (S1-18, #456)', () => {
  it('frames the page with the try query when it is the try page’s loader (#612)', () => {
    const { window, errors } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', LOOK, 'try'));
    expect(errors).toEqual([]);
    expect(frames(window)[0]?.getAttribute('src')).toBe(`${ORIGIN}/p/s/main?environment=local`);
  });

  it('places one launcher and one frame, also when the tag is added twice', () => {
    const { window, errors } = hostPage();
    const code = renderWidgetLoader(ORIGIN, 'main', LOOK);
    addScript(window, code);
    addScript(window, code);

    expect(errors).toEqual([]);
    expect(launchers(window)).toHaveLength(1);
    expect(frames(window)).toHaveLength(1);
    const frame = frames(window)[0];
    const launcher = launchers(window)[0];
    expect(frame?.getAttribute('src')).toBe(`${ORIGIN}/p/s/main`);
    expect(frame?.getAttribute('title')).toBe('Help centre');
    expect(launcher?.tagName).toBe('BUTTON');
    expect(launcher?.getAttribute('type')).toBe('button');
    expect(launcher?.getAttribute('aria-label')).toBe('Open Help centre');
    for (const element of window.document.querySelectorAll('[data-aw-surface]')) {
      expect(element.getAttribute('data-aw-surface')).toBe('main');
    }
    expect(window.document.querySelectorAll('[data-aw-surface]')).toHaveLength(2);
  });

  it('paints the launcher in the surface colour', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', LOOK));
    const launcher = launchers(window)[0];
    if (launcher === undefined) throw new Error('the loader placed a launcher');
    const style = window.getComputedStyle(launcher);
    expect(rgb(style.backgroundColor)).toBe(rgb(LOOK.colour));
    expect(rgb(style.color)).toBe(rgb(LOOK.foreground));
    expect(style.position).toBe('fixed');
  });

  it('opens and closes the frame from the launcher, and closes it on Escape', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', LOOK));
    const launcher = launchers(window)[0];
    const frame = frames(window)[0];
    if (launcher === undefined || frame === undefined) throw new Error('the loader placed both');

    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(css(window, frame, 'display')).toBe('none');
    launcher.dispatchEvent(new window.MouseEvent('click'));
    expect(launcher.getAttribute('aria-expanded')).toBe('true');
    expect(css(window, frame, 'display')).toBe('block');
    launcher.dispatchEvent(new window.MouseEvent('click'));
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(css(window, frame, 'display')).toBe('none');

    launcher.dispatchEvent(new window.MouseEvent('click'));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(css(window, frame, 'display')).toBe('none');
  });

  it('places a dock panel above a round launcher, with the look radius', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', LOOK));
    const launcher = launchers(window)[0];
    const frame = frames(window)[0];
    expect(css(window, launcher, 'border-radius')).toBe('50%');
    expect(css(window, launcher, 'bottom')).toBe('20px');
    expect(css(window, frame, 'position')).toBe('fixed');
    expect(css(window, frame, 'bottom')).toBe('88px');
    expect(css(window, frame, 'border-radius')).toBe('12px');
    expect(css(window, frame, 'width')).toBe('380px');
    expect(css(window, frame, 'height')).toBe('600px');
  });

  it('places a side tab on the right edge and a full-height drawer', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', { ...LOOK, layout: 'side' }));
    const launcher = launchers(window)[0];
    const frame = frames(window)[0];
    expect(css(window, launcher, 'right')).toBe('0px');
    expect(css(window, launcher, 'top')).toBe('50%');
    expect(launcher?.textContent).toBe('Help centre');
    expect(css(window, frame, 'right')).toBe('0px');
    expect(css(window, frame, 'height')).toBe(`${String(window.innerHeight)}px`);
    expect(css(window, frame, 'width')).toBe('420px');
    expect(css(window, frame, 'max-width')).toBe(`${String(window.innerWidth)}px`);
    launcher?.dispatchEvent(new window.MouseEvent('click'));
    expect(css(window, launcher, 'right')).not.toBe('0px');
  });

  it('opens a page surface as a full-viewport overlay', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', { ...LOOK, layout: 'page' }));
    expect(launchers(window)).toHaveLength(1);
    const frame = frames(window)[0];
    expect(css(window, frame, 'width')).toBe(`${String(window.innerWidth)}px`);
    expect(css(window, frame, 'height')).toBe(`${String(window.innerHeight)}px`);
    expect(css(window, frame, 'top')).toBe('0px');
    expect(css(window, frame, 'left')).toBe('0px');
  });

  it('places an inline surface in flow, right after its tag, with no launcher', () => {
    const { window } = hostPage();
    const slot = window.document.getElementById('slot');
    if (slot === null) throw new Error('the host page has a slot');
    slot.innerHTML = '<span id="next">next</span>';
    const code = renderWidgetLoader(ORIGIN, 'main', { ...LOOK, layout: 'inline' });
    const script = window.document.createElement('script');
    script.textContent = code;
    slot.insertBefore(script, slot.firstChild);
    addScript(window, code);

    expect(launchers(window)).toHaveLength(0);
    expect(frames(window)).toHaveLength(1);
    const frame = frames(window)[0];
    expect(script.nextElementSibling).toBe(frame);
    expect(frame?.nextElementSibling?.id).toBe('next');
    expect(css(window, frame, 'width')).toBe('100%');
    expect(css(window, frame, 'height')).toBe('600px');
    expect(css(window, frame, 'position')).toBe('');
  });

  it('places an inline frame in the body when the tag sits in <head>, as React hoists it', () => {
    const { window } = hostPage();
    const code = renderWidgetLoader(ORIGIN, 'main', { ...LOOK, layout: 'inline' });
    addScript(window, code, window.document.head);

    expect(frames(window)).toHaveLength(1);
    const frame = frames(window)[0];
    expect(frame?.parentNode?.nodeName).toBe('BODY');
    expect(window.document.head.querySelector('iframe')).toBeNull();
  });

  it('closes the panel on the close message from its own frame and the surface origin only', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', LOOK));
    const launcher = launchers(window)[0];
    const frame = frames(window)[0];
    if (launcher === undefined || frame === undefined) throw new Error('the loader placed both');
    const source = window.document.querySelector('iframe')?.contentWindow;
    if (!(source instanceof BrowserWindow)) throw new Error('the frame has a same-origin window');
    const close = { type: 'aw-surface-close' };
    const post = (init: { data: unknown; origin: string; source: typeof source }): void => {
      window.dispatchEvent(new window.MessageEvent('message', init));
    };

    launcher.dispatchEvent(new window.MouseEvent('click'));
    post({ data: close, origin: 'https://evil.example', source });
    post({ data: close, origin: ORIGIN, source: window });
    post({ data: { type: 'other' }, origin: ORIGIN, source });
    expect(launcher.getAttribute('aria-expanded')).toBe('true');

    post({ data: close, origin: ORIGIN, source });
    expect(launcher.getAttribute('aria-expanded')).toBe('false');
    expect(css(window, frame, 'display')).toBe('none');
  });

  it('places one widget per surface name on the same page', () => {
    const { window } = hostPage();
    addScript(window, renderWidgetLoader(ORIGIN, 'main', LOOK));
    addScript(window, renderWidgetLoader(ORIGIN, 'billing', LOOK));
    addScript(window, renderWidgetLoader(ORIGIN, 'billing', LOOK));
    expect(launchers(window)).toHaveLength(2);
    expect([...frames(window)].map((frame) => frame.getAttribute('src'))).toEqual([
      `${ORIGIN}/p/s/main`,
      `${ORIGIN}/p/s/billing`,
    ]);
  });

  it('escapes a title that would end the script or the string it sits in', () => {
    const title = 'Help </script><script>alert(1)</script> line para';
    const code = renderWidgetLoader(ORIGIN, 'main', { ...LOOK, frameTitle: title });
    expect(code).not.toContain('</script>');
    expect(code).not.toContain('<');
    expect(code).not.toContain(' ');
    expect(code).not.toContain(' ');
    expect(code).not.toContain('innerHTML');

    const { window, errors } = hostPage();
    addScript(window, code);
    expect(errors).toEqual([]);
    expect(frames(window)[0]?.getAttribute('title')).toBe(title);
    expect(window.document.querySelectorAll('script')).toHaveLength(1);
  });
});

describe('renderWidgetLoader input checks (S1-18, #456)', () => {
  it('refuses an origin that is not a bare http(s) origin', () => {
    for (const origin of [
      'http://127.0.0.1:4310/',
      'http://127.0.0.1:4310/p',
      'ftp://127.0.0.1',
      'javascript:alert(1)',
      'not a url',
      'HTTP://127.0.0.1:4310',
    ]) {
      expect(() => renderWidgetLoader(origin, 'main', LOOK), origin).toThrow(TypeError);
    }
    expect(() => renderWidgetLoader('https://localhost', 'main', LOOK)).not.toThrow();
  });

  it('refuses a name outside the surface grammar and a look outside the contract', () => {
    for (const name of ['Main', '', 'a/b', `x${'y'.repeat(64)}`, "main');alert(1);('"]) {
      expect(() => renderWidgetLoader(ORIGIN, name, LOOK), name).toThrow(TypeError);
    }
    expect(() => renderWidgetLoader(ORIGIN, 'main', { ...LOOK, colour: 'red' })).toThrow(TypeError);
    expect(() => renderWidgetLoader(ORIGIN, 'main', { ...LOOK, foreground: '#fff' })).toThrow(
      TypeError,
    );
    for (const radius of [-1, 33, 1.5, Number.NaN]) {
      expect(() => renderWidgetLoader(ORIGIN, 'main', { ...LOOK, radius }), String(radius)).toThrow(
        TypeError,
      );
    }
  });
});

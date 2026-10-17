/**
 * The one-tag widget loader's script (ADR-0105 slice 1, "one launcher and one iframe"; ADR-0108
 * rung ② `layout`; S1-18, issue #456): what `GET /p/s/<name>/widget.js` serves. A host page adds
 * `<script src="{origin}/p/s/{name}/widget.js" async></script>`, and the script places the
 * surface's launcher and its iframe of `{origin}/p/s/{name}`:
 *
 * - `dock`: a round launcher fixed bottom-right, opening a panel of about 380×600px above it;
 * - `side`: a tab on the right edge, opening a full-height drawer 420px wide (at most the viewport);
 * - `page`: the launcher opens the surface as a full-viewport overlay;
 * - `inline`: one iframe in the page's flow, right after the script tag, and no launcher — there
 *   is nothing to open (the dated ADR-0105 amendment records this deviation). A tag outside
 *   `<body>` — in `<head>`, where React 19 hoists an `async` script — cannot place a visible frame
 *   there, so the frame is appended to `<body>` instead, once the body exists.
 *
 * Every element is added to `<body>`, waiting for `DOMContentLoaded` when the tag runs before the
 * body is parsed. The panel closes on `Escape` in the host page, and on the surface's
 * `{type: 'aw-surface-close'}` message (`@indx-workspace/react`, `surface-chat-embed.ts`) when focus is inside
 * the frame; the message counts only from this loader's own frame and the surface's origin.
 *
 * {@link renderWidgetLoader} is pure. Its inputs are validated (a `TypeError` is a programmer
 * error, never a visitor's), and they reach the script as one JSON literal with `<`, U+2028 and
 * U+2029 escaped, so no value can end the script or the string it sits in. The script builds its
 * elements with `createElement`, `setAttribute`, `textContent` and `style.setProperty` only — no
 * HTML is parsed — and a registry under `Symbol.for('indx.aw.surface-widget')` makes a second
 * evaluation for the same origin and surface a no-op.
 */
import { z } from 'zod';

import { HEX_COLOUR_PATTERN } from '@indx-workspace/contracts/setup';
import { SURFACE_RADIUS_MAX, SurfaceLayoutSchema } from '@indx-workspace/contracts/surfaces';

import { isSurfaceName, TRY_QUERY } from '../public/handlers';
import type { SurfaceMode } from '../public/runtime';

/**
 * What the loader draws with, checked before it reaches the script. Structurally the components'
 * `SurfaceWidgetLook` (`packages/react/src/theme.ts`): the server takes it from the route,
 * never by import.
 */
const WidgetLookSchema = z
  .object({
    colour: z.string().regex(HEX_COLOUR_PATTERN),
    foreground: z.string().regex(HEX_COLOUR_PATTERN),
    radius: z.number().int().min(0).max(SURFACE_RADIUS_MAX),
    layout: SurfaceLayoutSchema,
    launcherLabel: z.string(),
    frameTitle: z.string(),
  })
  .strict()
  .readonly();
export type WidgetLook = z.infer<typeof WidgetLookSchema>;

function checkInputs(origin: string | null, name: string, look: WidgetLook): WidgetLook {
  if (origin !== null) checkOrigin(origin);
  if (!isSurfaceName(name)) {
    throw new TypeError(`not a surface name: ${JSON.stringify(name)}`);
  }
  const checked = WidgetLookSchema.safeParse(look);
  if (!checked.success) {
    throw new TypeError(`the widget look is out of bounds: ${checked.error.message}`);
  }
  return checked.data;
}

function checkOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`the widget origin is not a URL: ${JSON.stringify(origin)}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
    throw new TypeError(`the widget origin is not an http(s) origin: ${JSON.stringify(origin)}`);
  }
}

/** `value` as a JSON literal that is safe inside a script: no `<`, U+2028 or U+2029 survives. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}

/**
 * The loader's body. `__CONFIG__` is replaced by the escaped JSON config; nothing else is
 * interpolated. It is written for every browser a host page may run in: no module syntax, no
 * template literal, and no dependency.
 */
const LOADER_TEMPLATE = `(function () {
  'use strict';
  var config = __CONFIG__;
  if (config.origin === null) config.origin = new URL(document.currentScript.src).origin;
  var key = Symbol.for('indx.aw.surface-widget');
  var registry = window[key];
  if (!(registry instanceof Set)) {
    registry = new Set();
    window[key] = registry;
  }
  var id = config.origin + '/p/s/' + config.name;
  if (registry.has(id)) return;
  registry.add(id);

  var doc = document;
  var script = doc.currentScript;
  var layer = '2147483000';

  function make(tag, attributes, styles) {
    var element = doc.createElement(tag);
    element.setAttribute('data-aw-surface', config.name);
    for (var attribute in attributes) element.setAttribute(attribute, attributes[attribute]);
    for (var property in styles) element.style.setProperty(property, styles[property]);
    return element;
  }

  var frame = make(
    'iframe',
    { 'data-aw-surface-frame': config.name, title: config.frameTitle, src: id + config.query },
    { border: '0', 'color-scheme': 'normal', background: 'transparent' }
  );

  function withBody(place) {
    if (doc.body) place(doc.body);
    else
      doc.addEventListener('DOMContentLoaded', function () {
        place(doc.body || doc.documentElement);
      });
  }

  if (config.layout === 'inline') {
    frame.style.setProperty('display', 'block');
    frame.style.setProperty('width', '100%');
    frame.style.setProperty('height', '600px');
    if (script && script.parentNode && doc.body && doc.body.contains(script)) {
      script.parentNode.insertBefore(frame, script.nextSibling);
    } else {
      withBody(function (body) {
        body.appendChild(frame);
      });
    }
    return;
  }

  var radius = config.radius + 'px';
  var launcherStyles = {
    position: 'fixed',
    'z-index': layer,
    border: '0',
    cursor: 'pointer',
    background: config.colour,
    color: config.foreground,
    font: '600 14px system-ui, sans-serif',
    'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.2)'
  };
  var frameStyles = { position: 'fixed', 'z-index': layer, display: 'none' };
  if (config.layout === 'side') {
    launcherStyles.right = '0';
    launcherStyles.top = '50%';
    launcherStyles.transform = 'translateY(-50%)';
    launcherStyles['writing-mode'] = 'vertical-rl';
    launcherStyles.padding = '12px 8px';
    launcherStyles['border-radius'] = radius + ' 0 0 ' + radius;
    frameStyles.top = '0';
    frameStyles.right = '0';
    frameStyles.width = '420px';
    frameStyles['max-width'] = '100vw';
    frameStyles.height = '100vh';
    frameStyles['box-shadow'] = '-4px 0 24px rgba(0, 0, 0, 0.2)';
  } else {
    launcherStyles.right = '20px';
    launcherStyles.bottom = '20px';
    launcherStyles.width = '56px';
    launcherStyles.height = '56px';
    launcherStyles['border-radius'] = '50%';
    if (config.layout === 'page') {
      frameStyles.top = '0';
      frameStyles.left = '0';
      frameStyles.width = '100vw';
      frameStyles.height = '100vh';
    } else {
      frameStyles.right = '20px';
      frameStyles.bottom = '88px';
      frameStyles.width = '380px';
      frameStyles['max-width'] = 'calc(100vw - 40px)';
      frameStyles.height = '600px';
      frameStyles['max-height'] = 'calc(100vh - 108px)';
      frameStyles['border-radius'] = radius;
      frameStyles['box-shadow'] = '0 8px 32px rgba(0, 0, 0, 0.25)';
    }
  }
  for (var name in frameStyles) frame.style.setProperty(name, frameStyles[name]);

  var launcher = make(
    'button',
    {
      type: 'button',
      'data-aw-surface-launcher': config.name,
      'aria-label': config.launcherLabel,
      'aria-expanded': 'false'
    },
    launcherStyles
  );
  var closedMark = config.layout === 'side' ? config.frameTitle : '\\u2026';
  launcher.textContent = closedMark;

  var open = false;
  function show(next) {
    open = next;
    frame.style.setProperty('display', open ? 'block' : 'none');
    launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    launcher.textContent = open ? '\\u00d7' : closedMark;
    if (config.layout === 'side') {
      launcher.style.setProperty('right', open ? Math.min(420, window.innerWidth) + 'px' : '0');
    }
  }
  launcher.addEventListener('click', function () {
    show(!open);
  });
  doc.addEventListener('keydown', function (event) {
    if (open && event.key === 'Escape') {
      show(false);
      launcher.focus();
    }
  });
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (
      open &&
      event.source === frame.contentWindow &&
      event.origin === config.origin &&
      data !== null &&
      typeof data === 'object' &&
      data.type === 'aw-surface-close'
    ) {
      show(false);
      launcher.focus();
    }
  });

  withBody(function (body) {
    body.appendChild(frame);
    body.appendChild(launcher);
  });
})();
`;

/**
 * The loader for surface `name` served from `origin`, drawn with `look`. A `null` origin is read
 * by the script from its own URL (`document.currentScript.src`) when it runs (issue #622). A `try`
 * loader frames the page with the try query, so its chat is served `local` (issue #612). Throws
 * a `TypeError` on an input no route should pass: an origin that is not a bare http(s) origin, a
 * name outside the surface grammar, or a look outside the contract's bounds.
 */
export function renderWidgetLoader(
  origin: string | null,
  name: string,
  look: WidgetLook,
  mode: SurfaceMode = 'public',
): string {
  const checked = checkInputs(origin, name, look);
  const config = { origin, name, query: mode === 'try' ? `?${TRY_QUERY}` : '', ...checked };
  return LOADER_TEMPLATE.replace('__CONFIG__', () => scriptJson(config));
}

import { JourneyFailure } from './harness-failure.mjs';

/**
 * What the widget renders for an unset `theme.colour` (`SURFACE_DEFAULTS.colour` in
 * `packages/react/src/theme.ts`), and also the brand-colour question's recommended
 * answer (`packages/contracts/src/setup.ts`). A launcher in this colour proves nothing about
 * `surfaces/main.ts`, so the journey answers the question with {@link JOURNEY_BRAND_COLOUR}.
 */
export const DEFAULT_SURFACE_COLOUR = '#2f5fd0';

/** The brand colour the journey types at `npm create`'s question: not the default. */
export const JOURNEY_BRAND_COLOUR = '#c0392b';

const HEX_COLOUR = /^#[0-9a-f]{6}$/u;

/**
 * The brand colour the renderer wrote into `surfaces/main.ts` (C4: `theme.colour`, printed as
 * `colour: '#rrggbb',`), lower-cased.
 *
 * @param {string} text the file's contents
 */
export function colourOfSurfaceSource(text) {
  const match = /^\s*colour:\s*'(#[0-9a-fA-F]{6})',?\s*$/mu.exec(text);
  if (match?.[1] === undefined) {
    throw new JourneyFailure('surfaces/main.ts names no theme colour (colour: #rrggbb)');
  }
  return match[1].toLowerCase();
}

/**
 * The colour `surfaces/main.ts` names is the one the journey answered, and that answer differs from
 * what the widget renders without a theme, so the launcher's colour can tell the two apart.
 *
 * @param {string} fileHex the colour read from `surfaces/main.ts` @param {string} answeredHex
 */
export function assertBrandColour(fileHex, answeredHex) {
  const answered = answeredHex.toLowerCase();
  if (answered === DEFAULT_SURFACE_COLOUR) {
    throw new JourneyFailure(
      `the brand colour ${answeredHex} is the widget's default, so the launcher cannot prove it`,
    );
  }
  if (fileHex.toLowerCase() !== answered) {
    throw new JourneyFailure(
      `surfaces/main.ts names ${fileHex}, not the answered brand colour ${answeredHex}`,
    );
  }
}

/** @param {string} hex a `#rrggbb` colour */
function rgbOf(hex) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

/**
 * The launcher's computed background (`rgb(r, g, b)`, or `rgba(…, 1)`) must be the colour
 * `surfaces/main.ts` names.
 *
 * @param {string} expectedHex @param {string} computedCss
 */
export function assertLauncherColour(expectedHex, computedCss) {
  const expected = expectedHex.toLowerCase();
  if (!HEX_COLOUR.test(expected)) {
    throw new JourneyFailure(`surfaces/main.ts's colour ${expectedHex} is not #rrggbb`);
  }
  const match = /^rgba?\(\s*(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})(?:,\s*(?:1|1\.0+))?\s*\)$/u.exec(
    computedCss,
  );
  const actual = match === null ? null : [match[1], match[2], match[3]].map(Number);
  const wanted = rgbOf(expected);
  if (actual === null || actual.some((channel, index) => channel !== wanted[index])) {
    throw new JourneyFailure(
      `launcher colour ${computedCss} is not surfaces/main.ts's ${expectedHex}`,
    );
  }
}

const AGENT_NAME_LINE = /^ {2}name: '([^'\\]+)',$/mu;

const AGENT_IMPORT_LINE =
  /^import \{ (defineAgent(?:, \w+)*) \} from '(@indx-workspace\/sdk\/define)';$/mu;

const AGENT_ENGINE_LINE = /^ {2}engine: '[^'\\]+',$/mu;

/**
 * The `name` of a rendered `agents/<name>.ts` (`name: '<name>',`).
 *
 * @param {string} source
 */
export function agentNameOfSource(source) {
  const match = AGENT_NAME_LINE.exec(source);
  if (match?.[1] === undefined) throw new JourneyFailure('the agent file names no agent');
  return match[1];
}

/**
 * The rendered agent file moved to engine `pi`, which has no MCP client, with one `mcp()` tool:
 * the definition every engine-capability check must refuse with `engine_capability_unsupported`.
 *
 * @param {string} source a rendered `agents/<name>.ts` @param {string} connector
 */
export function mcpAgentSource(source, connector) {
  if (!AGENT_IMPORT_LINE.test(source) || !AGENT_ENGINE_LINE.test(source)) {
    throw new JourneyFailure('the agent file is not the renderer output (import and engine line)');
  }
  return source
    .replace(AGENT_IMPORT_LINE, "import { $1, mcp } from '$2';")
    .replace(AGENT_ENGINE_LINE, `  engine: 'pi',\n  tools: [mcp('${connector}')],`);
}

/**
 * B3b's hand edit of the rendered agent file: it imports `../tools/orders` and lists it, and asks
 * `permissions: { runCommands: true }`, so the run before the ceiling offers `Bash` and the run
 * under it shows the ceiling took it away. The same anchors as {@link mcpAgentSource}.
 *
 * @param {string} source a rendered `agents/<name>.ts` with no tools and no permissions
 */
export function toolAgentSource(source) {
  if (
    !AGENT_IMPORT_LINE.test(source) ||
    !AGENT_ENGINE_LINE.test(source) ||
    /^ {2}(?:tools|permissions):/mu.test(source)
  ) {
    throw new JourneyFailure(
      'the agent file is not the renderer output without tools (import and engine line)',
    );
  }
  return source
    .replace(AGENT_IMPORT_LINE, "$&\n\nimport ordersTool from '../tools/orders';")
    .replace(
      AGENT_ENGINE_LINE,
      '$&\n  tools: [ordersTool],\n  permissions: { runCommands: true },',
    );
}

const SURFACE_COLOUR_LINE = /^(\s*colour:\s*)'#[0-9a-fA-F]{6}'(,?)$/mu;

/**
 * B2's look change: the rendered `surfaces/main.ts` with its theme colour set to `hex`.
 *
 * @param {string} source a rendered `surfaces/main.ts` @param {string} hex `#rrggbb`
 */
export function withSurfaceColour(source, hex) {
  if (!HEX_COLOUR.test(hex)) throw new JourneyFailure(`${hex} is not a #rrggbb colour`);
  if (!SURFACE_COLOUR_LINE.test(source)) {
    throw new JourneyFailure('surfaces/main.ts names no theme colour (colour: #rrggbb)');
  }
  return source.replace(SURFACE_COLOUR_LINE, `$1'${hex}'$2`);
}

/**
 * The presets of `create --template chat | wiki | crm | desk` (issue #1511): each is the portal
 * template and a small overlay, `templates/presets/<id>/`, over the shared parts it names. Pure
 * data and the values the portal's navigation and theme are rendered with; `./templates.js`
 * renders the files.
 */
import type { RouteFeature } from '@indx-workspace/contracts/features';
import type { SETUP_THEMES } from '@indx-workspace/contracts/setup';

/** The shared parts a preset may include, each a directory `templates/parts/<part>/`. */
export type AppPresetPart = 'recipes';

/** The portal pages a preset's navigation may list. */
export type AppNavItem = 'home' | 'dashboard' | 'wiki' | 'chat' | 'files' | 'runs' | 'recipes';

/** A resource a preset ships, recorded as `resource:<name>` so `aw destroy resource` removes it. */
export interface AppPresetResource {
  /** Its name, as `resources/<name>.ts` and its `app.config.ts` entry spell it. */
  readonly name: string;
  /** Its table and route name: `app/api/<plural>/`. */
  readonly plural: string;
  /** Paths, or directories ending in `/`, it owns beyond its file, routes and pages. */
  readonly owns: readonly string[];
  /** The tag of the migration it adds to the journal, when it carries one. */
  readonly migration?: string;
  /**
   * The `name:type` fields its list, detail and new pages are generated with, when the preset
   * ships them: the pages `aw generate resource` writes, from the same template.
   */
  readonly pages?: readonly string[];
}

/** One preset of {@link APP_PRESETS}. */
export interface AppPreset {
  /** The shared parts it includes, rendered after the portal template in this order. */
  readonly parts: readonly AppPresetPart[];
  /** Its overlay, `templates/presets/<directory>/`, rendered last. */
  readonly directory: 'chat' | 'wiki' | 'crm' | 'desk';
  /** The paths an earlier layer writes that this preset writes on purpose; any other is refused. */
  readonly replaces: readonly string[];
  /** The route the app opens on. */
  readonly home: string;
  /** The navigation's entries, in order. */
  readonly nav: readonly AppNavItem[];
  /** The `setup.theme` answer when `--theme` is not given. */
  readonly theme: (typeof SETUP_THEMES)[number];
  /** Theme tokens beyond the portal's locale and radius, as `app/theme.ts` lines. */
  readonly tokens: Readonly<Record<string, string | number>>;
  /** The resources it ships, in `app.config.ts` order. */
  readonly resources: readonly AppPresetResource[];
  /** A `page/<kind>` generator template it renders as a layer, recorded as `page:<name>`. */
  readonly page?: { readonly name: string; readonly kind: 'dashboard' };
}

/** The portal's own navigation, which `create --template portal` writes. */
const PORTAL_NAV: readonly AppNavItem[] = ['home', 'chat', 'files', 'runs'];

/** The presets by template id. */
export const APP_PRESETS: Readonly<Record<'chat' | 'wiki' | 'crm' | 'desk', AppPreset>> =
  Object.freeze({
    chat: {
      parts: ['recipes'],
      directory: 'chat',
      replaces: ['app/page.tsx'],
      home: '/',
      nav: [...PORTAL_NAV, 'recipes'],
      theme: 'blank',
      tokens: {},
      resources: [],
    },
    wiki: {
      parts: ['recipes'],
      directory: 'wiki',
      replaces: [],
      home: '/',
      nav: ['home', 'wiki', 'chat', 'files', 'runs', 'recipes'],
      theme: 'blank',
      tokens: {},
      resources: [
        { name: 'space', plural: 'spaces', owns: [], pages: ['name:text(120)'] },
        { name: 'page', plural: 'pages', owns: ['app/wiki/'], migration: '0003_wiki' },
      ],
    },
    crm: {
      parts: ['recipes'],
      directory: 'crm',
      replaces: [],
      home: '/',
      nav: [...PORTAL_NAV, 'recipes'],
      theme: 'blank',
      tokens: { colour: '#0f766e', density: 'compact' },
      resources: [],
    },
    desk: {
      parts: ['recipes'],
      directory: 'desk',
      replaces: ['app/page.tsx'],
      home: '/dashboard',
      nav: ['dashboard', 'chat', 'files', 'runs', 'recipes'],
      theme: 'blank',
      tokens: {},
      resources: [],
      page: { name: 'dashboard', kind: 'dashboard' },
    },
  });

interface NavEntry {
  readonly href: string;
  readonly feature: RouteFeature;
  readonly en: string;
  readonly ja: string;
}

const NAV_ENTRIES: Readonly<Record<AppNavItem, NavEntry>> = {
  home: { href: '/', feature: 'core', en: 'Home', ja: 'ホーム' },
  dashboard: { href: '/dashboard', feature: 'runs', en: 'Dashboard', ja: 'ダッシュボード' },
  wiki: { href: '/wiki', feature: 'core', en: 'Wiki', ja: 'ウィキ' },
  chat: { href: '/chat', feature: 'chat', en: 'Chat', ja: 'チャット' },
  files: { href: '/files', feature: 'files', en: 'Files', ja: 'ファイル' },
  runs: { href: '/runs', feature: 'runs', en: 'Runs', ja: '実行' },
  recipes: { href: '/recipes', feature: 'runs', en: 'Recipes', ja: 'レシピ' },
};

/** `nav: { … },` at four spaces, on one line while it fits in 100 columns. */
function labelsLine(nav: readonly AppNavItem[], locale: 'en' | 'ja'): string {
  const pairs = nav.map((id) => `${id}: '${NAV_ENTRIES[id][locale]}'`);
  const line = `    nav: { ${pairs.join(', ')} },`;
  return line.length <= 100
    ? line
    : `    nav: {\n${pairs.map((pair) => `      ${pair},\n`).join('')}    },`;
}

/**
 * The values the portal's `app/nav.ts`, `app/strings.ts` and `app/theme.ts` are rendered with:
 * the portal's own for `undefined`, which render it byte for byte as before the presets.
 */
export function portalValues(preset: AppPreset | undefined): Readonly<Record<string, string>> {
  const nav = preset?.nav ?? PORTAL_NAV;
  const tokens = Object.entries(preset?.tokens ?? {});
  return Object.freeze({
    navIds: nav.map((id) => `'${id}'`).join(' | '),
    navEntries: nav
      .map((id) => {
        const entry = NAV_ENTRIES[id];
        return `  { id: '${id}', href: '${entry.href}', feature: '${entry.feature}' },\n`;
      })
      .join(''),
    navEn: labelsLine(nav, 'en'),
    navJa: labelsLine(nav, 'ja'),
    themeTokens: tokens
      .map(
        ([key, value]) =>
          `  ${key}: ${typeof value === 'number' ? String(value) : `'${value}'`},\n`,
      )
      .join(''),
    home: preset?.home ?? '/',
  });
}

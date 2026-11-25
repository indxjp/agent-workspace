// The marketing site's Agent Store sections, rendered from the store catalog when the site is built,
// so no page types an entry, a count or a line count. A page marks a slot with
// `<!-- data:<name> --><!-- /data:<name> -->`; the build replaces what is between the markers with
// that slot in the page's language. The store's address is STORE_ORIGIN, here and nowhere else.
import {
  AREAS,
  CATALOG,
  COUNTS,
  CUSTOMIZE_CONTROLS,
  entryView,
  FEATURED,
  PUBLIC_REPOSITORY_URL,
} from '../../examples/store/catalog/index.ts';
import { LINE_COUNTS } from '../../examples/store/catalog/line-counts.generated.ts';

/** Where the store is served. It is a preview until its production domain is decided. */
export const STORE_ORIGIN = 'https://store-staging.indx.jp';

/**
 * @typedef {'en' | 'ja'} Lang
 * @typedef {{ readonly ja: string, readonly en: string }} Pair
 * @typedef {import('../../examples/store/catalog/index.ts').CatalogEntry} CatalogEntry
 * @typedef {import('../../examples/store/catalog/index.ts').LiveEntry} LiveEntry
 * @typedef {import('../../examples/store/catalog/index.ts').CustomizeControl} CustomizeControl
 * @typedef {LiveEntry['safety'][number]} SafetyProperty
 * @typedef {{
 *   readonly catalog: readonly CatalogEntry[],
 *   readonly counts: { readonly total: number, readonly live: number, readonly areas: number },
 *   readonly areas: readonly { readonly id: string, readonly name: Pair }[],
 *   readonly controls: readonly CustomizeControl[],
 *   readonly featured: LiveEntry,
 *   readonly view: (entry: CatalogEntry) => { readonly flow: { readonly ja: readonly string[], readonly en: readonly string[] }, readonly connects: readonly string[], readonly customize: readonly CustomizeControl[] },
 *   readonly repository: string,
 *   readonly lineCounts: Readonly<Record<string, { readonly handwritten: number, readonly budget: number }>>,
 * }} StoreData
 */

/** @type {StoreData} */
export const STORE_DATA = {
  catalog: CATALOG,
  counts: COUNTS,
  areas: AREAS,
  controls: CUSTOMIZE_CONTROLS,
  featured: FEATURED,
  view: entryView,
  repository: PUBLIC_REPOSITORY_URL,
  lineCounts: LINE_COUNTS,
};

/** The words of a Customize control, as the store's own tab names it. */
export const CONTROL_LABELS = /** @type {const} */ ({
  companyName: { en: 'Company name', ja: '会社名' },
  approvalRule: { en: 'Approval rule', ja: '承認ルール' },
  tone: { en: 'Tone', ja: '口調' },
  language: { en: 'Reply language', ja: '返信の言語' },
  connection: { en: 'System to connect', ja: 'つなぐシステム' },
});

/** What each safety property of a live entry means for the person who runs it. */
export const SAFETY_LABELS = /** @type {const} */ ({
  person: {
    en: 'Acts only within the asking person’s access',
    ja: '頼んだ人の権限の範囲でだけ動く',
  },
  approval: { en: 'Writes can wait for a person’s approval', ja: '書き込みは人の承認を待てる' },
  structured: {
    en: 'Returns structured output your systems can read',
    ja: 'システムが読める構造化データで返す',
  },
  trigger: {
    en: 'Starts from an event, not only a chat',
    ja: 'チャットだけでなくイベントで起動する',
  },
  files: { en: 'Reads only the folders it is granted', ja: '許可したフォルダだけを読む' },
});

const WORDS = /** @type {const} */ ({
  live: { en: 'Live', ja: '公開中' },
  liveCount: { en: 'live', ja: '件公開中' },
  onShelf: { en: 'on the shelf', ja: '件掲載' },
  try: { en: 'Try on sample data', ja: 'サンプルデータで試す' },
  sample: { en: 'Sample data', ja: 'サンプルデータ' },
  more: { en: 'See this area in the Agent Store', ja: 'この分野を Agent Store で見る' },
  coming: { en: 'more on the way', ja: '件を準備中' },
  does: { en: 'What it does', ja: 'できること' },
  moment: { en: 'What you will see in the demo', ja: 'デモで見られること' },
  reads: { en: 'What it reads', ja: '読むもの' },
  connects: { en: 'Systems it connects to', ja: 'つなぐシステム' },
  behaves: { en: 'How it behaves', ja: 'ふるまい' },
  customize: { en: 'What you can customize', ja: 'カスタマイズできる項目' },
  source: { en: 'Source', ja: 'ソース' },
  sourceLink: { en: 'Read it on GitHub', ja: 'GitHub で読む' },
  open: { en: 'Open the Agent Store (preview)', ja: 'Agent Store を開く（プレビュー）' },
  get: { en: 'Try it', ja: '試す' },
  handwritten: { en: 'handwritten lines', ja: '行（手書き）' },
  budget: { en: 'budget', ja: '上限' },
  generated: { en: 'The SDK generates the rest.', ja: '残りは SDK が生成します。' },
});

/** @param {string} text */
const escape = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** @param {Pair} pair @param {Lang} lang */
const say = (pair, lang) => escape(pair[lang]);

/**
 * A store address; the English site opens the store in English.
 * @param {string} path @param {Lang} lang
 */
export function storeUrl(path, lang) {
  if (lang === 'ja') return `${STORE_ORIGIN}${path}`;
  return `${STORE_ORIGIN}${path}${path.includes('?') ? '&' : '?'}lang=en`;
}

/** @param {readonly CatalogEntry[]} entries @returns {LiveEntry[]} */
const liveOf = (entries) =>
  /** @type {LiveEntry[]} */ (entries.filter((entry) => entry.status === 'live'));

/**
 * The app icon of an entry: its area's colour and the first character of its name.
 * @param {CatalogEntry} entry @param {Lang} lang
 */
function icon(entry, lang) {
  const mark = Array.from(entry.name[lang])[0] ?? '';
  return `<span class="app-ic area-${escape(entry.area)}" aria-hidden="true">${escape(mark)}</span>`;
}

/** @param {LiveEntry} entry @param {Lang} lang */
function card(entry, lang) {
  return [
    `<a class="app-card" href="${storeUrl(`/agents/${entry.slug}`, lang)}">`,
    `<span class="app-top">${icon(entry, lang)}<span class="app-name"><b>${say(entry.name, lang)}</b><span class="badge badge-ok">${say(WORDS.live, lang)}</span></span></span>`,
    `<span class="app-sum">${say(entry.summary, lang)}</span>`,
    `<span class="app-meta"><span>${say(WORDS.sample, lang)}: ${say(entry.demo.data, lang)}</span><span class="app-get">${say(WORDS.get, lang)} →</span></span>`,
    '</a>',
  ].join('');
}

/**
 * The shelves: a tab per area, each with its live entries as app cards.
 * @param {StoreData} data @param {Lang} lang
 */
function shelf(data, lang) {
  const live = liveOf(data.catalog);
  const areas = data.areas.filter((area) => live.some((entry) => entry.area === area.id));
  const tabs = areas.map((area, index) => {
    const count = live.filter((entry) => entry.area === area.id).length;
    return `<button type="button" role="tab" id="shelf-tab-${area.id}" aria-controls="shelf-${area.id}" aria-selected="${String(index === 0)}"${index === 0 ? '' : ' tabindex="-1"'}>${say(area.name, lang)}<span class="n">${String(count)}</span></button>`;
  });
  const panels = areas.map((area, index) => {
    const inArea = data.catalog.filter((entry) => entry.area === area.id);
    const shown = liveOf(inArea);
    const coming = inArea.length - shown.length;
    const more =
      coming > 0
        ? `<a class="app-card app-more" href="${storeUrl(`/?cat=${area.id}`, lang)}"><b>+${String(coming)}</b><span>${lang === 'ja' ? `${String(coming)}${say(WORDS.coming, lang)}` : `${String(coming)} ${say(WORDS.coming, lang)}`}</span><span class="app-get">${say(WORDS.more, lang)} →</span></a>`
        : '';
    return `<div class="shelf-panel${index === 0 ? ' on' : ''}" id="shelf-${area.id}" role="tabpanel" aria-labelledby="shelf-tab-${area.id}"><div class="app-grid">${shown.map((entry) => card(entry, lang)).join('')}${more}</div></div>`;
  });
  return [
    '<div class="shelf" data-tabs>',
    `<div class="shelf-tabs" role="tablist" aria-label="${lang === 'ja' ? '業務の分野' : 'Business areas'}">${tabs.join('')}</div>`,
    ...panels,
    '</div>',
  ].join('\n');
}

/**
 * Four live entries for the hero: the featured one, then the first live entry of each next area.
 * @param {StoreData} data @param {Lang} lang
 */
function picks(data, lang) {
  const live = liveOf(data.catalog);
  /** @type {LiveEntry[]} */
  const chosen = [data.featured];
  for (const area of data.areas) {
    const first = live.find((entry) => entry.area === area.id);
    if (chosen.length < 4 && first !== undefined && !chosen.some((entry) => entry.area === area.id))
      chosen.push(first);
  }
  return `<div class="app-stack">${chosen.map((entry) => card(entry, lang)).join('')}</div>`;
}

/**
 * The featured entry as a listing: what it does, reads, connects to and may change, what a buyer
 * can customize, and where its source is.
 * @param {StoreData} data @param {Lang} lang
 */
function listing(data, lang) {
  const entry = data.featured;
  const view = data.view(entry);
  const area = data.areas.find(({ id }) => id === entry.area);
  /** @param {readonly string[]} items */
  const chips = (items) =>
    `<ul class="chip-list">${items.map((item) => `<li class="chip">${escape(item)}</li>`).join('')}</ul>`;
  const rows = [
    [WORDS.does, `<p>${say(entry.summary, lang)}</p>`],
    [WORDS.moment, `<p>${say(entry.demo.moment, lang)}</p>`],
    [WORDS.reads, chips(view.flow[lang])],
    [WORDS.connects, chips(view.connects)],
    [
      WORDS.behaves,
      `<ul class="ticks">${entry.safety.map((property) => `<li>${say(SAFETY_LABELS[property], lang)}</li>`).join('')}</ul>`,
    ],
    [WORDS.customize, chips(view.customize.map((control) => CONTROL_LABELS[control][lang]))],
    [
      WORDS.source,
      `<p><code>${escape(entry.source)}</code> · <a href="${escape(`${data.repository}/tree/main/${entry.source}`)}">${say(WORDS.sourceLink, lang)}</a></p>`,
    ],
  ];
  return [
    '<article class="listing">',
    `<header class="listing-head">${icon(entry, lang)}<div><span class="small">${area === undefined ? '' : say(area.name, lang)}</span><h3>${say(entry.name, lang)}</h3><span class="small">${say(WORDS.sample, lang)}: ${say(entry.demo.data, lang)}</span></div><a class="btn btn-action" href="${storeUrl(`/agents/${entry.slug}`, lang)}">${say(WORDS.get, lang)}</a></header>`,
    `<dl class="listing-rows">${rows.map(([label, body]) => `<div><dt>${say(/** @type {Pair} */ (label), lang)}</dt><dd>${String(body)}</dd></div>`).join('')}</dl>`,
    '</article>',
  ].join('\n');
}

/**
 * The example apps' handwritten lines against their budgets, as the apps benchmark measures them.
 * @param {StoreData} data @param {Lang} lang
 */
function lineCounts(data, lang) {
  const rows = Object.entries(data.lineCounts).map(([id, count]) => {
    const entry = data.catalog.find((candidate) => candidate.source === `examples/${id}`);
    const name = entry === undefined ? escape(id) : say(entry.name, lang);
    const share = Math.min(100, Math.round((count.handwritten / count.budget) * 100));
    const numbers = `<b>${String(count.handwritten)}</b> ${say(WORDS.handwritten, lang)} · ${say(WORDS.budget, lang)} ${String(count.budget)}`;
    return `<li><a href="${escape(`${data.repository}/tree/main/examples/${id}`)}"><span class="lc-name">${name}<code>examples/${escape(id)}</code></span><span class="lc-bar" aria-hidden="true"><i style="width:${String(share)}%"></i></span><span class="lc-n">${numbers}</span></a></li>`;
  });
  return `<ul class="lc">${rows.join('')}</ul>\n<p class="small">${say(WORDS.generated, lang)}</p>`;
}

/** @param {StoreData} data */
const handwritten = (data) => Object.values(data.lineCounts).map((count) => count.handwritten);

/**
 * @param {StoreData} data @param {Lang} lang
 * @returns {Readonly<Record<string, () => string>>}
 */
function renderers(data, lang) {
  return {
    'store-live': () => String(data.counts.live),
    'store-total': () => String(data.counts.total),
    'store-areas': () => String(data.counts.areas),
    'line-counts-min': () => String(Math.min(...handwritten(data))),
    'line-counts-max': () => String(Math.max(...handwritten(data))),
    'store-controls': () =>
      data.controls
        .map((control) => `<span class="chip">${say(CONTROL_LABELS[control], lang)}</span>`)
        .join(' '),
    'store-shelf': () => shelf(data, lang),
    'store-picks': () => picks(data, lang),
    'store-listing': () => listing(data, lang),
    'store-link': () =>
      `<a class="btn btn-action btn-lg" href="${storeUrl('/', lang)}">${say(WORDS.open, lang)}</a>`,
    'line-counts': () => lineCounts(data, lang),
  };
}

/** The slot names a page may use. */
export const SLOT_NAMES = Object.freeze(Object.keys(renderers(STORE_DATA, 'en')));

/**
 * Fills every data slot of a page in `lang`.
 * @param {string} html @param {Lang} lang @param {StoreData} [data]
 * @returns {string}
 */
export function renderSlots(html, lang, data = STORE_DATA) {
  const render = renderers(data, lang);
  return html.replace(
    /<!-- data:([a-z-]+) -->[\s\S]*?<!-- \/data:\1 -->/gu,
    (_, /** @type {string} */ name) => {
      const slot = render[name];
      if (slot === undefined) throw new Error(`unknown data slot: ${name}`);
      return `<!-- data:${name} -->${slot()}<!-- /data:${name} -->`;
    },
  );
}

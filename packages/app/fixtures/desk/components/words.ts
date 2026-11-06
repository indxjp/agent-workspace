import type { AppLocale } from '@indx-workspace/app/react';

/** The language a page is drawn in: `?lang=ja` is Japanese, anything else English. */
export function localeOf(lang: string | readonly string[] | undefined): AppLocale {
  return lang === 'ja' ? 'ja' : 'en';
}

/** The desk's own words, beside the app kit's. */
export interface DeskWords {
  readonly boardHeading: string;
  readonly recipesHeading: string;
  readonly recipeRunHeading: string;
  readonly dashboardHeading: string;
  readonly channelHeading: string;
  readonly wikiHeading: string;
  readonly wikiChoose: string;
  readonly agents: { readonly summarise: string; readonly triage: string; readonly writer: string };
  readonly approval: {
    readonly heading: string;
    readonly tool: string;
    readonly call: string;
    readonly approve: string;
    readonly reject: string;
  };
}

const WORDS: Readonly<Record<AppLocale, DeskWords>> = {
  en: {
    boardHeading: 'Tickets',
    recipesHeading: 'Recipes',
    recipeRunHeading: 'Recipe run',
    dashboardHeading: 'Dashboard',
    channelHeading: 'Team chat',
    wikiHeading: 'Knowledge base',
    wikiChoose: 'Choose a page in the tree.',
    agents: { summarise: 'Summarise', triage: 'Triage', writer: 'Writer' },
    approval: {
      heading: 'The agent asks to make this change',
      tool: 'Tool',
      call: 'Change',
      approve: 'Approve',
      reject: 'Reject',
    },
  },
  ja: {
    boardHeading: 'チケット',
    recipesHeading: 'レシピ',
    recipeRunHeading: 'レシピの実行',
    dashboardHeading: 'ダッシュボード',
    channelHeading: 'チームチャット',
    wikiHeading: 'ナレッジベース',
    wikiChoose: 'ツリーからページを選んでください。',
    agents: { summarise: '要約', triage: 'トリアージ', writer: 'ライター' },
    approval: {
      heading: 'エージェントが次の変更の承認を求めています',
      tool: 'ツール',
      call: '変更内容',
      approve: '承認',
      reject: '却下',
    },
  },
};

/** The desk's words in `locale`. */
export function deskWords(locale: AppLocale): DeskWords {
  return WORDS[locale];
}

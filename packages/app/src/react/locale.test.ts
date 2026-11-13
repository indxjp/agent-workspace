import { SURFACE_LOCALES } from '@indx-workspace/contracts/surfaces';
import { describe, expect, it } from 'vitest';

import { appStrings, problemMessage } from './locale.js';

function keysOf(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'object' && child !== null
      ? keysOf(child as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('appStrings (#1508)', () => {
  it('has the same keys in every locale, nested ones included', () => {
    const keys = SURFACE_LOCALES.map((locale) => keysOf(appStrings(locale)).sort());
    for (const each of keys) expect(each).toEqual(keys[0]);
  });

  it('localises Japanese, rather than repeating English', () => {
    const en = appStrings('en');
    const ja = appStrings('ja');
    for (const key of keysOf(en)) {
      const english: unknown = key
        .split('.')
        .reduce<unknown>((at, part) => Reflect.get(Object(at), part), en);
      const japanese: unknown = key
        .split('.')
        .reduce<unknown>((at, part) => Reflect.get(Object(at), part), ja);
      if (typeof english === 'function' && typeof japanese === 'function') {
        if (key === 'listLabel') continue; // the app's own plural, in either language
        const said: unknown = Reflect.apply(japanese, undefined, ['x']);
        expect(said, key).not.toBe(Reflect.apply(english, undefined, ['x']));
      } else if (key !== 'noValue') {
        expect(japanese, key).not.toBe(english);
      }
    }
    expect(en.cardCount(1)).toBe('1 card');
    expect(en.cardCount(3)).toBe('3 cards');
    expect(ja.cardCount(3)).toBe('3 件');
    expect(ja.boardLabel('状態')).toBe('状態別のボード');
  });
});

describe('problemMessage (#1508)', () => {
  it('names the codes a person can act on and reads every other code as a generic retry', () => {
    const en = appStrings('en');
    expect(problemMessage(en, 'forbidden')).toBe(en.problems.forbidden);
    expect(problemMessage(en, 'unauthenticated')).toContain('Sign in again');
    expect(problemMessage(en, 'transport_failed')).toBe(en.problems.transport_failed);
    expect(problemMessage(en, 'internal_error')).toBe(en.problems.other);
    expect(problemMessage(appStrings('ja'), 'resource_not_found')).toContain('レコード');
  });

  it("names the agent panel's refusals (#1509)", () => {
    const en = appStrings('en');
    expect(problemMessage(en, 'session_busy')).toBe(en.agentPanel.problems.session_busy);
    expect(problemMessage(en, 'agent_not_offered')).toBe(en.agentPanel.problems.agent_not_offered);
    expect(problemMessage(appStrings('ja'), 'stream_lost')).toContain('接続');
  });
});

describe('the recipe strings (#1514)', () => {
  it("names the recipe routes' refusals in both languages", () => {
    const en = appStrings('en');
    expect(problemMessage(en, 'approval_expired')).toBe(en.recipes.problems.approval_expired);
    expect(problemMessage(en, 'recipe_step_not_awaiting_approval')).toContain('no longer');
    expect(problemMessage(appStrings('ja'), 'approval_already_decided')).toContain('判断');
    expect(en.recipes.stepChanged('classify', 'Completed')).toBe('Step classify: Completed.');
    expect(appStrings('ja').recipes.approveLabel('classify')).toBe('ステップ classify を承認');
  });
});

describe('the page strings (#1521)', () => {
  it("names the page routes' refusals by code in both languages", () => {
    const en = appStrings('en');
    expect(problemMessage(en, 'page_conflict')).toBe(en.pages.problems.page_conflict);
    expect(problemMessage(en, 'page_cycle')).toBe(en.pages.problems.page_cycle);
    expect(problemMessage(en, 'revision_not_found')).toBe(en.pages.problems.revision_not_found);
    expect(problemMessage(appStrings('ja'), 'page_has_children')).toContain('ページ');
    expect(en.pages.blockTextLabel(2, 'Quote')).toBe('Block 2 text (Quote)');
    expect(appStrings('ja').pages.rewriteWith('ライター')).toBe('ライターで書き換え');
  });
});

import { FEATURE_IDS } from '@indx-workspace/contracts/features';
import { describe, expect, it } from 'vitest';

import { NAVIGATION } from '../shell/navigation';
import {
  FEATURES_REFUSAL_CODES,
  featureLabelList,
  featuresRefusalText,
  featuresStrings,
} from './features-messages';

const en = featuresStrings('en');
const ja = featuresStrings('ja');

describe('features messages', () => {
  it('names every feature in both languages, differently', () => {
    for (const id of FEATURE_IDS) {
      expect(en.labels[id].trim(), id).not.toBe('');
      expect(ja.labels[id].trim(), id).not.toBe('');
      expect(ja.labels[id], id).not.toBe(en.labels[id]);
    }
  });

  it('reuses the navigation label for each feature with its own entry, except chat', () => {
    for (const item of NAVIGATION.flatMap((group) => group.items)) {
      if (item.feature === 'core' || item.feature === 'chat') continue;
      expect(en.labels[item.feature]).toBe(item.label);
    }
    expect(en.labels.sharing).toBe('Shared links');
    expect(en.labels.chat).toBe('Chat');
  });

  it('has words for every refusal code in both languages, and a fallback for any other', () => {
    for (const code of FEATURES_REFUSAL_CODES) {
      expect(featuresRefusalText(code, en)).toBe(en.refusals[code]);
      expect(ja.refusals[code], code).not.toBe(en.refusals[code]);
    }
    expect(featuresRefusalText('feature_disabled', en)).toBe(en.unavailable);
    expect(featuresRefusalText('toString', en)).toBe(en.unavailable);
    expect(featuresRefusalText('nope', ja)).toBe(ja.unavailable);
  });

  it('joins labels as each language writes a list', () => {
    expect(featureLabelList(['evaluations', 'triggers'], en)).toBe('Evaluations, Triggers');
    expect(featureLabelList(['evaluations', 'triggers'], ja)).toBe('評価、トリガー');
  });

  it('prints the switched-off sentence the journey looks for', () => {
    expect(en.offHeading(en.labels.files)).toBe('Files is switched off for this workspace.');
    expect(en.offAskOwner('Acme Corp')).toBe('Ask an Owner of Acme Corp.');
  });
});

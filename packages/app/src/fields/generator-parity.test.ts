import {
  GENERATOR_FIELD_TYPES,
  parseFieldSpec,
  type GeneratorFieldType,
} from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { RESERVED_FIELD_NAMES } from '../resource.js';
import * as builders from './index.js';

// `aw generate resource` writes fields with the SDK's grammar, which cannot import the app kit;
// these keep its closed lists equal to the builders and reserved names the app kit has.
describe('the generator field grammar', () => {
  it('lists exactly the field builders, each named as the type it makes', () => {
    const exported = Object.entries(builders)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort();

    expect([...GENERATOR_FIELD_TYPES].sort()).toEqual(exported);
  });

  it('writes fields whose builder makes that type', () => {
    // A key per generator type, checked by the compiler, so a new type needs a builder here.
    const make: Record<GeneratorFieldType, () => { readonly type: string }> = {
      text: () => builders.text(),
      richText: () => builders.richText(),
      number: () => builders.number(),
      money: () => builders.money({ currency: 'JPY' }),
      bool: () => builders.bool(),
      date: () => builders.date(),
      dateTime: () => builders.dateTime(),
      enumOf: () => builders.enumOf(['a']),
      person: () => builders.person(),
      ref: () => builders.ref('ticket'),
      files: () => builders.files(),
      tags: () => builders.tags(),
    };
    for (const type of GENERATOR_FIELD_TYPES) expect(make[type]().type).toBe(type);
  });

  it('refuses every reserved field name the app kit refuses', () => {
    for (const name of RESERVED_FIELD_NAMES) {
      expect(() => parseFieldSpec(`${name}:text`)).toThrow(/is reserved/u);
    }
  });
});

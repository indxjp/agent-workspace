import { describe, expect, it } from 'vitest';

import { BUILTIN_SKILL_NAMES } from '@indx-workspace/contracts/skills';

import { DefinitionError, builtinSkill, defineAgent, skill } from './index.js';

describe('builtinSkill()', () => {
  it('is the same frozen reference as skill() for every built-in name', () => {
    for (const name of BUILTIN_SKILL_NAMES) {
      const reference = builtinSkill(name);
      expect(reference).toStrictEqual(skill(name));
      expect(Object.isFrozen(reference)).toBe(true);
    }
  });

  it('refuses a name that is not built in, naming the allowed ones', () => {
    const attempt = (): void => {
      Reflect.apply(builtinSkill, undefined, ['my-own-skill']);
    };
    expect(attempt).toThrow(DefinitionError);
    expect(attempt).toThrow(/builtinSkill\(\).*"my-own-skill".*office-reader/u);
  });

  it('puts the name into the definition resources', () => {
    const agent = defineAgent({
      name: 'reader',
      instructions: 'Read documents.',
      skills: [builtinSkill('office-reader')],
    });
    expect(agent.skills).toStrictEqual([{ name: 'office-reader' }]);
  });
});

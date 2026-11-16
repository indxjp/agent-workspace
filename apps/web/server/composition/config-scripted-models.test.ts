import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { scriptedModelsOption } from './config';

describe('scriptedModelsOption (refactoring part 03, step 5)', () => {
  it('offers no scripted models when AW_SCRIPTED_MODELS_DIR is unset', () => {
    expect(scriptedModelsOption({})).toEqual({});
  });

  it('offers the folder named, in the local posture', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scripted-option-'));
    const option = scriptedModelsOption({
      AW_SCRIPTED_MODELS_DIR: dir,
      AW_DEPLOYMENT_POSTURE: 'local',
      HOST: '127.0.0.1',
    });
    expect(option.scripted?.isScripted('scripted:any')).toBe(true);
  });

  it('throws outside the local posture, so start-up fails rather than serving a test tool', () => {
    expect(() =>
      scriptedModelsOption({
        AW_SCRIPTED_MODELS_DIR: '/tmp/x',
        AW_DEPLOYMENT_POSTURE: 'production',
      }),
    ).toThrow(/only works in the local posture/u);
  });
});

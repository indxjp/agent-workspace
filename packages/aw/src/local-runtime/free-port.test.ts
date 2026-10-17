import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { parseProjectFile, renderProjectFiles } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { freeWebPort } from './environment.js';

function project(pinned = false) {
  const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  const text = file?.contents ?? '';
  return parseProjectFile(
    pinned ? text.replace('    cloud: local\n', '    cloud: local\n    port: 3070\n') : text,
  );
}

/** A probe that finds exactly `taken` busy. */
const busy =
  (...taken: number[]) =>
  (port: number) =>
    Promise.resolve(!taken.includes(port));

describe('freeWebPort (issue #692)', () => {
  it('keeps the default ports when all four are free', async () => {
    expect(await freeWebPort(project(), {}, busy())).toBeNull();
  });

  it('moves the whole set when any one of the four is taken, and names the first taken', async () => {
    expect(await freeWebPort(project(), {}, busy(3000))).toEqual({ port: 3001, busy: 3000 });
    expect(await freeWebPort(project(), {}, busy(4000))).toEqual({ port: 3001, busy: 4000 });
    // 3001 itself is free, but its gateway 4001 is not.
    expect(await freeWebPort(project(), {}, busy(25_432, 4001))).toEqual({
      port: 3002,
      busy: 25_432,
    });
  });

  it('leaves a service port that is set to the runtime', async () => {
    expect(await freeWebPort(project(), { AW_DATABASE_PORT: '25500' }, busy(3000))).toBeNull();
  });

  it('leaves a service port that is set but blank to the runtime', async () => {
    expect(await freeWebPort(project(), { AW_DATABASE_PORT: '' }, busy(3000))).toBeNull();
  });

  it('does not probe the PostgreSQL port when DATABASE_URL is set', async () => {
    const env = { DATABASE_URL: 'postgres://db.example/aw' };
    expect(await freeWebPort(project(), env, busy(25_432))).toBeNull();
    expect(await freeWebPort(project(), env, busy(3000))).toEqual({ port: 3001, busy: 3000 });
  });

  it('never moves a pinned port: a busy one stays the runtime refusal', async () => {
    expect(await freeWebPort(project(true), {}, busy(3070))).toBeNull();
  });
});

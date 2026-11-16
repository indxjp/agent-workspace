import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deployProjectEnvironment } from './project.js';
import { temporary, deploy } from './project.fixture.test-support.js';
export function defineOwnershipCases(): void {
  it('refuses a second project of the same name the first one deployed state for (BH061-028)', async () => {
    const first = await mkdtemp(path.join(os.tmpdir(), 'aw-project-a-'));
    const second = await mkdtemp(path.join(os.tmpdir(), 'aw-project-b-'));
    temporary.push(first, second);
    const { options, run } = await deploy({ projectDirectory: first });
    await run();
    const owner = path.join(path.dirname(options.stateDirectory), 'project-directory');
    expect((await readFile(owner, 'utf8')).trim()).toBe(path.resolve(first));

    // The same project again is its own state.
    await deployProjectEnvironment(options);
    const other = deployProjectEnvironment({ ...options, projectDirectory: second });

    await expect(other).rejects.toThrow(`belongs to the project at ${path.resolve(first)}`);
    await expect(other).rejects.toThrow(owner);
  });
}

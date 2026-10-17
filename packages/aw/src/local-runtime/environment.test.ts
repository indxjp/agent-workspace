import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { parseProjectFile, renderProjectFiles } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { localStartMessage } from './environment.js';

function projectNaming(driver: string) {
  const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  if (file === undefined) throw new Error('renderProjectFiles rendered nothing');
  return parseProjectFile(
    file.contents.replace(
      '    cloud: local\n',
      `    cloud: local\n    runtime:\n      default: ${driver}\n`,
    ),
  );
}

describe('localStartMessage runtime driver', () => {
  it('still starts a project that names sandbox-runtime (#818)', () => {
    const start = localStartMessage(projectNaming('sandbox-runtime'), '/work/demo');
    expect(start.environment.runtimeDriver).toBe('sandbox-runtime');
  });

  it('refuses a driver the local runtime cannot provision', () => {
    expect(() => localStartMessage(projectNaming('kubernetes'), '/work/demo')).toThrow(
      /cannot run the kubernetes driver locally/u,
    );
  });
});

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

/** The recommended project, with `extra` written as top-level keys before `environments:`. */
function projectWith(extra: string) {
  const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'demo' });
  if (file === undefined) throw new Error('renderProjectFiles rendered nothing');
  if (!file.contents.includes('\nenvironments:\n')) throw new Error('no environments key');
  return parseProjectFile(file.contents.replace('\nenvironments:\n', `\n${extra}environments:\n`));
}

describe('localStartMessage features (ADR-0160 D5, issue #1495)', () => {
  it('sends no features for a file without them, so the start message is unchanged', () => {
    const start = localStartMessage(projectWith(''), '/work/demo');
    expect(start.environment).toEqual({
      port: 3000,
      bootstrapAdmin: 'admin@localhost.test',
      modelSecrets: ['ANTHROPIC_API_KEY'],
    });
    expect(start.environment).not.toHaveProperty('features');
  });

  it("sends the file's features, in file order", () => {
    const start = localStartMessage(projectWith('features: [files, chat, runs]\n'), '/work/demo');
    expect(start.environment.features).toEqual(['files', 'chat', 'runs']);
  });
});

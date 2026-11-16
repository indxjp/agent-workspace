import { describe, expect, it } from 'vitest';
import { sessionWorkspacePaths } from './env.js';
import { CONFIG_DIRECTORY } from './env.test-support.js';

describe('sessionWorkspacePaths — §25 isolation, proven on distinct values, not read off the code', () => {
  it('two sessions under one workspace root get two distinct cwds and configDirs', () => {
    const a = sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', CONFIG_DIRECTORY);
    const b = sessionWorkspacePaths('/workspace/agent-1', 'session-bbb', CONFIG_DIRECTORY);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.configDir.startsWith(a.cwd)).toBe(true);
    expect(b.configDir.startsWith(b.cwd)).toBe(true);
  });

  it('refuses a session id shaped like a path-traversal, an absolute path, or empty', () => {
    for (const bad of ['../escape', '..', '/etc/passwd', 'C:\\Windows', '', 'a/b', 'a b']) {
      expect(() => sessionWorkspacePaths('/workspace/agent-1', bad, CONFIG_DIRECTORY)).toThrow(
        /sessionWorkspacePaths/,
      );
    }
  });

  it('nests the engine configuration directory the caller named, and refuses one that is a path', () => {
    expect(
      sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', CONFIG_DIRECTORY).configDir,
    ).toBe('/workspace/agent-1/session-aaa/.claude');
    // A second engine's directory, to prove the name is not this package's decision.
    expect(
      sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', '.openai-agents').configDir,
    ).toBe('/workspace/agent-1/session-aaa/.openai-agents');
    for (const bad of ['', 'a/b', 'a\\b', '..']) {
      expect(() => sessionWorkspacePaths('/workspace/agent-1', 'session-aaa', bad)).toThrow(
        /protectedConfigDirectory/,
      );
    }
  });
});

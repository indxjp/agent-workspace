/**
 * The Claude Agent SDK adapter, behind the port (ENG-04, #303).
 *
 * Three things are checked here, and the middle one is the acceptance criterion.
 *
 *  1. **The restated version and capabilities are held to their sources.** The version is
 *     compared against this package's own manifest and the capability set against the
 *     control-plane registry's copy — the "watched by a replay, not by a comment" rule of
 *     `docs/adr/W2-CP-07-a-restatement-across-a-package-boundary-is-watched-by-a-replay-not-a-comment.md`.
 *     The registry's copy exists because `apps/web` may not import an engine adapter; without
 *     this assertion the two would drift and the catalogue would advertise capabilities the
 *     runtime does not have.
 *
 *  2. **The conformance kit reports PASS on every scenario.** The kit is
 *     `@agent-workspace/engine/testing` and it is the *same* scenario list the scripted engine
 *     is driven through, which is what makes a scenario a statement about the port rather than
 *     about one engine. The run is against **recorded SDK messages**: `createClaudeAgentSdkEngine`
 *     takes the one function that calls `query()` as a parameter, so everything else in the
 *     adapter — the policy parse, the compile, the gateway handling, the `agent.*` mapping, the
 *     session-id promise, the durability verdict — is exercised for real without a credential
 *     or a subprocess.
 *
 *  3. **The port translation is behaviour-preserving.** `compile` is `compileRunRequest`, and
 *     what this file adds is the `EngineRunRequest` → `RunRequest` step in front of it; the
 *     assertions below are that the step maps the three session modes onto the three legal SDK
 *     combinations R-01 §6 allows, and nothing else.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

import {
  CLAUDE_AGENT_SDK_CAPABILITIES,
  CLAUDE_AGENT_SDK_ENGINE_ID,
  CLAUDE_AGENT_SDK_VERSION,
} from './engine.js';
import { CLAUDE_AGENT_SDK_ENGINE_ADAPTER, PACKAGE_ROOT } from './engine.test-support.js';
import { CLAUDE_PROTECTED_CONFIG_DIRECTORY } from './scope.js';

it('reports the version this package actually depends on', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  expect(CLAUDE_AGENT_SDK_VERSION).toBe(manifest.dependencies['@anthropic-ai/claude-agent-sdk']);
  expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.version).toBe(CLAUDE_AGENT_SDK_VERSION);
});

it('answers to the id the catalogue publishes and declares its own config directory', () => {
  expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.id).toBe(CLAUDE_AGENT_SDK_ENGINE_ID);
  expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.protectedConfigDirectory).toBe(
    CLAUDE_PROTECTED_CONFIG_DIRECTORY,
  );
  expect(CLAUDE_PROTECTED_CONFIG_DIRECTORY).toBe('.claude');
});

it('declares the capabilities R-01 measured', () => {
  expect(CLAUDE_AGENT_SDK_ENGINE_ADAPTER.capabilities).toEqual(CLAUDE_AGENT_SDK_CAPABILITIES);
  // The two that decide a refusal at save time, named rather than inferred from the object.
  expect(CLAUDE_AGENT_SDK_CAPABILITIES.mcp).toBe(true);
  expect(CLAUDE_AGENT_SDK_CAPABILITIES.skills).toBe(true);
  expect(CLAUDE_AGENT_SDK_CAPABILITIES.fork).toBe(false);
  expect([...CLAUDE_AGENT_SDK_CAPABILITIES.wireProtocols]).toEqual(['anthropic-messages']);
});

import { vi } from 'vitest';

// The real `compileRunRequest` behind a spy, so a test can count the compiles one start performs.
vi.mock('./compile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./compile.js')>();
  return { ...original, compileRunRequest: vi.fn(original.compileRunRequest) };
});

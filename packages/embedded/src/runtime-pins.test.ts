/**
 * #364 (ADR-0082's amendment): the published `@indx-workspace/cli` restates facts of the
 * private `packages/runtime` instead of importing it, because a published package must not name
 * that package's scope. This package is the one that sees both, so it holds each restatement to
 * its source and none can drift.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { type RuntimeDriverId } from '@agent-workspace/runtime/driver';
import {
  DOCKER_COMPOSE_PROJECT_LABEL,
  DOCKER_SANDBOX_LABEL,
} from '@agent-workspace/runtime/driver/docker';
import { engineImageEnvName } from '@agent-workspace/runtime/engine-images';
import {
  CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY,
  COMPOSE_PROJECT_LABEL,
  SANDBOX_LABEL,
  type RuntimeDriverId as CliRuntimeDriverId,
} from '@indx-workspace/cli';

describe('the CLI restates the runtime, and matches it', () => {
  it('names the Claude engine image variable exactly as the runtime parses it', () => {
    expect(CLAUDE_AGENT_SDK_RUNTIME_IMAGE_KEY).toBe(engineImageEnvName('claude-agent-sdk'));
  });

  it('spells every runtime driver id the runtime does, and no other', () => {
    expectTypeOf<CliRuntimeDriverId>().toEqualTypeOf<RuntimeDriverId>();
  });

  it('finds sandboxes for `agent-workspace stop` by the labels the Docker driver writes (#394)', () => {
    expect(SANDBOX_LABEL).toBe(DOCKER_SANDBOX_LABEL);
    expect(COMPOSE_PROJECT_LABEL).toBe(DOCKER_COMPOSE_PROJECT_LABEL);
  });
});

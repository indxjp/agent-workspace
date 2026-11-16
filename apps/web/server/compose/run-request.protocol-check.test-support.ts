import { afterEach, describe, expect, it } from 'vitest';

import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
} from '../engines/registry';
import { DomainError } from '../errors';
import { publicRunFailure } from '../runs/failures';

import { buildRunRequestFor } from './run-request';
import { GATEWAY, SETTINGS, launchContext, rowRunAgent } from './run-request.fixture.test-support';
export function registerProtocolCheckTests() {
  describe("buildRunRequestFor's protocol check (ENG-04)", () => {
    afterEach(() => clearEnginesRegisteredForTests());

    it('refuses with a typed engine_model_protocol_unsupported whose sentence becomes the run failure', async () => {
      // Every provider answers `anthropic-messages`, so the built-in descriptor can never reach
      // the refusal. Replace it with one that speaks only the Responses dialect, which the gateway
      // does not serve for an `anthropic` connection.
      const builtIn = registeredEngine('claude-agent-sdk');
      if (builtIn === null) throw new Error('the built-in engine is not registered');
      // `installed` is the deployment's image map since ENG-07, not a field a descriptor carries.
      registerEngineForTests({
        id: builtIn.id,
        displayName: builtIn.displayName,
        version: builtIn.version,
        capabilities: { ...builtIn.capabilities, wireProtocols: ['openai-responses'] },
      });
      const { context, agents } = await launchContext();

      const refusal: unknown = await buildRunRequestFor({
        context,
        runAgent: await rowRunAgent(agents, context),
        settings: SETTINGS,
        gateway: GATEWAY,
        modelProvider: 'anthropic',
      }).then(
        () => null,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(DomainError);
      const domain = refusal as DomainError;
      expect(domain.code).toBe('engine_model_protocol_unsupported');
      expect(domain.publicMessage).toMatch(/^engine_model_protocol_unsupported: /u);
      expect(domain.publicMessage).toContain("'anthropic' model connection");
      // What the launcher writes to the run record, through the same function it calls.
      expect(
        publicRunFailure(refusal, {
          operation: 'prepare-request',
          publicMessage: 'The run request could not be prepared.',
          log: () => undefined,
        }),
      ).toBe(domain.publicMessage);
    });

    it('composes normally when the engine speaks a dialect the gateway serves for the provider', async () => {
      const { context, agents } = await launchContext();
      const request = await buildRunRequestFor({
        context,
        runAgent: await rowRunAgent(agents, context),
        settings: SETTINGS,
        gateway: GATEWAY,
        modelProvider: 'anthropic',
      });
      expect(request.engine).toBe('claude-agent-sdk');
    });
  });
}

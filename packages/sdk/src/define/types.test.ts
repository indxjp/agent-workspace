import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { SecretReference } from '@indx-workspace/contracts/secret-reference';
import type { SurfaceDefinitionInput } from '@indx-workspace/contracts/surfaces';

import type { DefineAgentInputSchema } from './agent.js';
import type {
  DefineAgentInput,
  DefineLimits,
  DefinePermissions,
  DefineTool,
  DefinedSecret,
  EngineSettings,
  ModelReference,
  OpenApiTool,
  OpenApiToolDefinition,
  OpenApiToolInput,
  PostgresTool,
  PostgresToolDefinition,
  PostgresToolInput,
  ToolDefinition,
  defineAgent,
  defineSurface,
  openapiTool,
  postgresTool,
  secret,
  toAgentVersionBody,
  toolDefinitionsOf,
} from './index.js';

describe('define types', () => {
  it('has exactly the agent keys', () => {
    expectTypeOf<keyof DefineAgentInput>().toEqualTypeOf<
      | 'name'
      | 'description'
      | 'subagents'
      | 'knowledge'
      | 'instructions'
      | 'model'
      | 'engine'
      | 'permissions'
      | 'tools'
      | 'skills'
      | 'files'
      | 'limits'
    >();
    // An unknown key such as `icon` is therefore an excess-property type error.
    expectTypeOf<'icon' extends keyof DefineAgentInput ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<
      'openapiTool' extends keyof DefineAgentInput ? true : false
    >().toEqualTypeOf<false>();
  });

  it('takes closed object types, so an unknown key in a literal is an excess-property error', () => {
    // TypeScript reports an excess property in an object literal only against a parameter type
    // with a closed key set: exactly the declared input, with no index signature at any level.
    expectTypeOf<Parameters<typeof defineAgent>[0]>().toEqualTypeOf<DefineAgentInput>();
    expectTypeOf<Parameters<typeof defineSurface>[0]>().toEqualTypeOf<SurfaceDefinitionInput>();
    expectTypeOf<string extends keyof DefineAgentInput ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<string extends keyof DefinePermissions ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<string extends keyof DefineLimits ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<
      string extends keyof SurfaceDefinitionInput ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      'description' extends keyof SurfaceDefinitionInput ? true : false
    >().toEqualTypeOf<false>();
  });

  it('has exact nested key sets', () => {
    expectTypeOf<keyof DefinePermissions>().toEqualTypeOf<
      'readFiles' | 'writeFiles' | 'runCommands' | 'unrestrictedNetwork'
    >();
    expectTypeOf<keyof DefineLimits>().toEqualTypeOf<'maxTurns' | 'maxBudgetUsd'>();
    expectTypeOf<keyof Exclude<ModelReference, string>>().toEqualTypeOf<'connection' | 'id'>();
    expectTypeOf<keyof Extract<EngineSettings, { id: 'claude-agent-sdk' }>>().toEqualTypeOf<
      'id' | 'autoApprove' | 'requireApproval' | 'handoff'
    >();
    expectTypeOf<keyof Extract<EngineSettings, { id: 'openai-agents' }>>().toEqualTypeOf<
      'id' | 'reasoningEffort' | 'parallelToolCalls'
    >();
    expectTypeOf<keyof Extract<EngineSettings, { id: 'pi' }>>().toEqualTypeOf<
      'id' | 'thinkingLevel'
    >();
    expectTypeOf<keyof Extract<EngineSettings, { id: 'mastra' }>>().toEqualTypeOf<
      'id' | 'toolCallConcurrency'
    >();
  });

  it('takes the contract surface input and returns the contract version body', () => {
    expectTypeOf<Parameters<typeof defineSurface>[0]>().toEqualTypeOf<SurfaceDefinitionInput>();
    expectTypeOf<ReturnType<typeof toAgentVersionBody>>().toEqualTypeOf<AgentVersionBody>();
  });

  it('takes closed tool inputs, with readOnly the type true', () => {
    expectTypeOf<Parameters<typeof openapiTool>[0]>().toEqualTypeOf<OpenApiToolInput>();
    expectTypeOf<Parameters<typeof postgresTool>[0]>().toEqualTypeOf<PostgresToolInput>();
    expectTypeOf<keyof OpenApiToolInput>().toEqualTypeOf<
      'name' | 'spec' | 'allow' | 'auth' | 'identity' | 'baseUrl'
    >();
    expectTypeOf<keyof PostgresToolInput>().toEqualTypeOf<
      'name' | 'url' | 'readOnly' | 'tables' | 'maxRows'
    >();
    expectTypeOf<string extends keyof OpenApiToolInput ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<string extends keyof PostgresToolInput ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'document' extends keyof OpenApiToolInput ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<
      'credential' extends keyof PostgresToolInput ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<PostgresToolInput['readOnly']>().toEqualTypeOf<true>();
    expectTypeOf<PostgresToolInput['url']>().toEqualTypeOf<SecretReference>();
    expectTypeOf<ReturnType<typeof secret>>().toEqualTypeOf<DefinedSecret>();
    expectTypeOf<DefinedSecret>().toExtend<SecretReference>();
  });

  it('takes any of the three tool kinds in tools', () => {
    expectTypeOf<NonNullable<DefineAgentInput['tools']>[number]>().toEqualTypeOf<DefineTool>();
    expectTypeOf<OpenApiTool>().toExtend<DefineTool>();
    expectTypeOf<PostgresTool>().toExtend<DefineTool>();
    expectTypeOf<ReturnType<typeof toolDefinitionsOf>>().toEqualTypeOf<readonly ToolDefinition[]>();
    expectTypeOf<PostgresToolDefinition['readOnly']>().toEqualTypeOf<true>();
    expectTypeOf<OpenApiToolDefinition['auth']>().toEqualTypeOf<
      'none' | 'bearer' | { readonly header: string }
    >();
  });

  it('has a runtime schema whose input is the public interface', () => {
    expectTypeOf<z.input<typeof DefineAgentInputSchema>>().toEqualTypeOf<DefineAgentInput>();
  });
});

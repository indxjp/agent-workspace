/**
 * The engine wire contract lives in `@indx-workspace/contracts/engines`, the package the SDK and
 * every external consumer validate against. This module is the application's import seam, exactly
 * as `contracts/agents.ts` is for agents: browser code imports `contracts/engines` and never the
 * server's registry, which is a Node module and a deployment fact rather than a wire one.
 */
export {
  ENGINE_IDS,
  ENGINE_PROBLEM_CODES,
  EngineDescriptorSchema,
  EngineListResponseSchema,
  WIRE_PROTOCOLS,
  type EngineCapabilities,
  type EngineDescriptor,
  type EngineId,
  type EngineListResponse,
} from '@indx-workspace/contracts/engines';

/**
 * `@indx-workspace/sdk/events` — the consumer side of `GET /api/runs/:id/events`.
 *
 * Separate from the root entry so a browser bundle that only renders a stream it was handed does
 * not carry the HTTP client, and so the application's own components can adopt the parser first.
 */
export { parseSseFrame, readSseFrames, splitSseFrames, type SseFrame } from './sse.js';
export { classifyRunEventFrame, type RunEventFrame } from './run-events.js';
export {
  assistantResponseFromAgentEvent,
  toAgentEvent,
  type AgentEvent,
  type AgentMalformedFrame,
  type AgentMessageDeltaFrame,
  type AgentMessageFrame,
  type AgentNativeFrame,
  type AgentResultFrame,
  type AgentSessionFrame,
  type AgentToolCallFrame,
  type AgentToolResultFrame,
  type AgentUsageFrame,
  type AssistantResponse,
} from './agent-event.js';

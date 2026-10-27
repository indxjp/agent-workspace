/**
 * The engine adapter modules `src/engines.ts` loads, as the runner's **emit build** sees them
 * (ENG-09, #308; ADR-0074 "images").
 *
 * A runtime image carries exactly one adapter (ADR-0073 D1), so when `runtime.Dockerfile` builds
 * this application the other adapters' packages are not in the build context and their specifiers
 * resolve to nothing. These declarations are what the emit build (`tsconfig.build.json`, and only
 * it) type-checks those specifiers against: each module is the one export the registry reads,
 * the adapter's factory, typed `unknown`, because `readEngineExport` checks it at run time and answers
 * `engine_not_installed` for a module that is missing or malformed. The type-checking view
 * (`tsconfig.json`) does not include this file, so the workspace type-check still resolves the
 * real packages.
 */
declare module '@agent-workspace/engine-claude-agent-sdk' {
  export const createClaudeAgentSdkEngine: unknown;
}

declare module '@agent-workspace/engine-openai-agents' {
  export const createOpenAiAgentsEngine: unknown;
}

declare module '@agent-workspace/engine-pi' {
  export const createPiEngine: unknown;
}

declare module '@agent-workspace/engine-mastra' {
  export const createMastraEngine: unknown;
}

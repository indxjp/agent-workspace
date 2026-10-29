/**
 * The engine adapter modules `src/engines.ts` loads, as the runner's **emit build** sees them
 * (ENG-09, #308; ADR-0074 "images").
 *
 * A runtime image carries exactly one adapter (ADR-0073 D1), so when `runtime.Dockerfile` builds
 * this application the other adapters' packages are not in the build context and their specifiers
 * resolve to nothing. This module is what the emit build (`tsconfig.build.json`, and only it)
 * type-checks those specifiers against: `paths` there maps each of the four to this file, so the
 * real adapter packages never enter the emit program, whatever a build context or the package
 * manager has linked. Each export is an adapter's factory, typed `unknown`, because
 * `readEngineExport` checks it at run time and answers `engine_not_installed` for a module that is
 * missing or malformed. The type-checking view (`tsconfig.json`) does not map them, so the
 * workspace type-check still resolves the real packages.
 *
 * A module rather than `declare module` blocks: an ambient declaration only types a specifier, and
 * the compiler still adds a package it resolves to the program. The control-plane image's build
 * resolved the adapters' sources that way through the root `node_modules` links, and compiled
 * whichever had its dependencies installed.
 */
export declare const createClaudeAgentSdkEngine: unknown;
export declare const createOpenAiAgentsEngine: unknown;
export declare const createPiEngine: unknown;
export declare const createMastraEngine: unknown;

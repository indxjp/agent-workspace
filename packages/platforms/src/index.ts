/**
 * `@indx-workspace/platforms` — the `PlatformTarget` port, the verdict model and the registry of
 * platform translators (ADR-0133 D6-D8). Pure: no file system, network or process access. The
 * conformance kit is at `@indx-workspace/platforms/testing`, not here, so importing the port does
 * not pull `node:fs` and a sample project into a bundle.
 */
export type * from './port.js';
export * from './paths.js';
export * from './compile.js';
export * from './registry.js';
export * from './report.js';

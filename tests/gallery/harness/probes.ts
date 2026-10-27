/**
 * Gap probes: executable statements that a capability is still missing.
 *
 * Each probe asks the published contracts or the SDK whether the capability exists and answers
 * `true` when it does. `../probes.test.ts` asserts every probe answers `false`. The day the SDK
 * gains one, its probe flips, that test fails, and the failure names the benchmarks citing it: a
 * gap the gallery reports cannot outlive the gap itself. Probes read only public surfaces —
 * `@indx-workspace/contracts`, `@indx-workspace/sdk` and its `/define` and `/testing` subpaths —
 * because those are what a developer building a use case can rely on.
 */
import { ProjectConnectorSchema } from '@indx-workspace/contracts/project-file';

export interface Probe {
  /** What the capability is, phrased so "… is still absent" reads as the test title. */
  readonly title: string;
  /** Where to look when the probe flips. */
  readonly where: string;
  readonly present: () => boolean | Promise<boolean>;
}

export const PROBES = {
  'project-file-stdio': {
    title: 'a stdio MCP connector declared in agent-workspace.yaml',
    where: 'packages/contracts/src/project-file.ts (ProjectConnectorSchema)',
    present: () =>
      ProjectConnectorSchema.safeParse({ url: 'https://mcp.example.co.jp/mcp', transport: 'stdio' })
        .success,
  },
} as const satisfies Readonly<Record<string, Probe>>;

export type ProbeId = keyof typeof PROBES;

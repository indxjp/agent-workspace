/**
 * `describeUseCase(slug, { definitions, flows })`: the three offline tiers of one use case (SSOT
 * §5.1), one call in `<slug>.test.ts`.
 *
 * - **Contract.** The project loads the way `aw check` loads it (`loadGalleryProject`:
 *   `toAgentVersionBody` and the server's schema), its evals have the four kinds and the promotion
 *   bar, the catalog entry agrees with the source, no agent auto-approves `run_skill_script`
 *   while one of its scripts could write (ADR-0167 D5, #2388), and every folder an agent is granted
 *   is named from the slug, so two entries never share one.
 * - **Moment.** When the entry has a committed recording, `judgeMoment` passes on it in both
 *   languages; a live entry without one fails, a coming-soon entry has none yet.
 * - **Flow.** Each listed flow runs against the gallery's scripted workspace (real SDK client, real
 *   tools, scripted model decisions), which `context.workspace` builds.
 *
 * `definitions` are the default exports of `agents/*.ts` and `surfaces/*.ts`, imported statically
 * by the test: the repository's import-boundary gate refuses a computed `import()`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import type { CatalogEntry } from '../../examples/store/catalog/define.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import {
  judgeMoment,
  recordingFor,
  type Recording,
} from '../../examples/store/catalog/recording.ts';
import { RECORDINGS } from '../../examples/store/catalog/recordings.generated.ts';
import {
  loadGalleryProject,
  type GalleryProject,
  type ProjectDefinitions,
} from '../../tests/gallery/harness/project.ts';
import { scriptedWorkspace } from '../../tests/gallery/harness/scripted-workspace.ts';
import { runAndRead } from '../../tests/gallery/shared/run-answer.ts';
import { filesOf } from '../../tests/apps/handwritten.ts';
import { isSkippedInUseCase, MEASURED_CODE } from './budget.ts';
import {
  builtinImportProblems,
  catalogEntryProblems,
  CONTRACT_TESTS,
  evalProblems,
  folderProblems,
  unattendedWriteProblems,
} from './contract.ts';

const USE_CASES_DIR = fileURLToPath(new URL('..', import.meta.url));
const LANGS = ['ja', 'en'] as const;
/** The files the contract tier itself loads and so runs: the project file and the definitions. */
const DEFINITION = /^(?:agent-workspace\.yaml|(?:agents|surfaces)\/[^/]+\.ts)$/u;

/**
 * What a flow is handed: the loaded project, the scripted workspace to run it against, and the
 * gallery's `runAndRead` (start a run, follow it, read its answer and tool calls).
 */
interface FlowContext {
  readonly project: GalleryProject;
  readonly workspace: typeof scriptedWorkspace;
  readonly runAndRead: typeof runAndRead;
}

/** One flow: a named path through the use case's handwritten code. */
interface UseCaseFlow {
  readonly name: string;
  readonly run: (context: FlowContext) => Promise<void> | void;
}

export interface UseCaseOptions {
  readonly definitions: ProjectDefinitions;
  readonly flows?: readonly UseCaseFlow[];
  /** The use case's folder; `use-cases/<slug>` by default. */
  readonly dir?: string;
  /** The store catalog; the real one by default. */
  readonly catalog?: readonly CatalogEntry[];
  /** The committed recordings; the real ones by default. */
  readonly recordings?: readonly Recording[];
}

export function describeUseCase(slug: string, options: UseCaseOptions): void {
  const dir = options.dir ?? path.join(USE_CASES_DIR, slug);
  const catalog = options.catalog ?? CATALOG;
  const recordings = options.recordings ?? RECORDINGS;
  const entry = catalog.find((candidate) => candidate.slug === slug);

  describe(slug, () => {
    let project: GalleryProject;
    beforeAll(async () => {
      project = await loadGalleryProject(dir, options.definitions);
    });

    describe('contract', () => {
      it(CONTRACT_TESTS.loads, () => {
        expect(project.agents.map((agent) => agent.definition.name)).toContain(slug);
      });

      it(CONTRACT_TESTS.evals, () => {
        const agent = project.agents.find((candidate) => candidate.definition.name === slug);
        const bar = project.project.policy?.promotion?.minEvalScore;
        expect(evalProblems(slug, agent?.evals ?? null, bar)).toEqual([]);
      });

      it(CONTRACT_TESTS.catalog, () => {
        const source = {
          dir,
          name: project.project.name,
          agents: project.agents.map((agent) => agent.definition),
        };
        expect(catalogEntryProblems(slug, source, catalog)).toEqual([]);
      });

      it(CONTRACT_TESTS.writes, () => {
        expect(unattendedWriteProblems(project.agents.map((agent) => agent.body))).toEqual([]);
      });

      it(CONTRACT_TESTS.imports, () => {
        expect(
          builtinImportProblems(
            dir,
            project.agents.map((agent) => agent.body),
          ),
        ).toEqual([]);
      });

      it(CONTRACT_TESTS.folders, () => {
        expect(
          folderProblems(
            slug,
            project.agents.map((agent) => agent.definition),
          ),
        ).toEqual([]);
      });
    });

    describe('moment', () => {
      if (entry?.status !== 'live') {
        it('has no recording yet: the entry is coming soon', () => {
          expect(entry?.status).toBe('soon');
          expect(recordings.filter((recording) => recording.slug === slug)).toEqual([]);
        });
        return;
      }
      for (const lang of LANGS) {
        it(`replays its ${lang} recording and the moment happens`, () => {
          const recording = recordingFor(recordings, slug, lang);
          expect(recording, `${slug} ${lang}: no recording`).not.toBeNull();
          expect(entry.demo.check, `${slug}: no demo.check`).toBeDefined();
          if (recording === null || entry.demo.check === undefined) return;
          expect(judgeMoment(recording.turn, entry.demo.check)).toEqual({ pass: true });
        });
      }
    });

    describe('flows', () => {
      const flows = options.flows ?? [];
      if (flows.length === 0) {
        it('lists no flow, so it has no code beyond the definitions the contract loads', async () => {
          const code = (await filesOf(dir)).filter(
            (file) =>
              MEASURED_CODE.test(file) && !isSkippedInUseCase(file) && !DEFINITION.test(file),
          );
          expect(code, `${slug}: list a flow that runs each of these`).toEqual([]);
        });
      }
      for (const flow of flows) {
        it(flow.name, async () => {
          await flow.run({ project, workspace: scriptedWorkspace, runAndRead });
        });
      }
    });
  });
}

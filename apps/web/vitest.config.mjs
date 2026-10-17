/**
 * The `apps/web` Vitest project.
 *
 * It exists for one reason. `apps/web/tsconfig.json` sets `"jsx": "preserve"` because Next.js
 * compiles the JSX itself, and Vite reads that setting and refuses to transform a `.tsx` file it
 * has been told to leave alone — so a test that imports a component fails at parse time with
 * "invalid JS syntax", before a single assertion runs. This tells Vite to compile JSX with the
 * automatic runtime **for tests only**; `next build` still reads `tsconfig.json` and is unaffected.
 *
 * Without it W1-UI-03's acceptance criterion — "a test asserts the home route renders it after the
 * first message" — cannot be executed at all, and a criterion that cannot run is not a gate.
 * See docs/adr/W1-UI-03-the-web-project-can-load-its-own-components-in-a-test.md.
 *
 * ## `env`, and why a test process is a *configured* deployment
 *
 * Since ENG-07 (#306) the control plane decides which engines it offers from the `engine → image`
 * map in its environment (`server/engines/images.ts`), which is read once at module load. A test
 * process with no such variable is a deployment that offers no engine at all, so `installed` would
 * be `false` everywhere and every run would be refused `422 engine_not_installed` — a true answer
 * to a question almost no suite here is asking.
 *
 * So this process is given the one image `compose.yaml` gives a developer, and it is the *same*
 * value: `agent-workspace/runtime:dev`. A suite that is asking about the map — the `engine-images`
 * replay, `server/engines/images.test.ts`, the uninstalled-engine refusal in `server/runs/api.test.ts`
 * — installs its own with `configureEngineImagesForTests` and says so, rather than inheriting one
 * silently. That is the ADR-0029 shape: the default is what a working deployment has, and the
 * counter-example is written down where it is tested.
 *
 * Nothing else is set. The root `vitest.config.ts` supplies the project list; a project config
 * that redeclared it would be a second place for collection rules to disagree.
 *
 * The extension is `.mjs` and not `.ts` on purpose: `apps/web/package.json` has no `"type":
 * "module"` (Next.js reads that manifest), so a `.ts` config is loaded as CommonJS and Vite warns
 * about ESM syntax in it.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    env: { AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-workspace/runtime:dev' },
  },
});

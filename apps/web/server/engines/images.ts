/**
 * Which engines this deployment has a runtime image for (ENG-07, #306).
 *
 * ADR-0073 D2: *"A deployment chooses which engines it offers by which images it configures."* This
 * module is where that configuration is read, and it is the **only** place: `GET /api/engines`'
 * `installed` and the run route's `422 engine_not_installed` are two readings of one map, so a
 * catalogue that says an engine is installed and a run route that refuses it cannot both be right.
 *
 * ## Why parsing happens once, at module load
 *
 * A malformed map must stop the control plane from coming up, not produce a run that fails an hour
 * later in a sandbox nobody is watching. `ENGINE_IMAGES` is therefore evaluated when this module is
 * first imported, and a malformed environment throws out of that evaluation — which Next.js reports
 * as a start-up failure. That is ADR-0015's *"a check that cannot run must fail, not fall through"*,
 * and it is the behaviour the `engine-images` family's T1 theorem states.
 *
 * The refusal's message names configuration **keys and never values**
 * (`packages/runtime`'s `parseEngineImageMap`): a start-up error is read out loud and in log
 * aggregators, and an image reference carries a registry host and usually a project id.
 *
 * ## Why the parser is imported rather than written here
 *
 * `apps/runner`'s manager reads the same variables to decide which image to start a container from.
 * Two parsers is two chances to disagree about what
 * `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` means, and the disagreement would show up as a
 * run the catalogue promised and the sandbox refused. `packages/runtime` owns the grammar; this
 * module owns the catalogue it is checked against.
 */
import { ENGINE_IDS } from '@indx-workspace/contracts/engines';
import { readDeploymentPosture } from '@agent-workspace/core/posture';
import { readEngineImageMap, type EngineImageMap } from '@agent-workspace/runtime';

interface GlobalEngineImages {
  __agentWorkspaceEngineImages__?: EngineImageMap;
}

const globalImages = globalThis as typeof globalThis & GlobalEngineImages;

/**
 * The image a development control plane assumes for `claude-agent-sdk` when nothing is configured.
 *
 * The same tag `compose.yaml` gives the runner manager and `../composition/services.ts` already
 * falls back to for its runtime fingerprint. It applies **only under the local deployment posture
 * and only when the environment configures no engine image at all**, so `pnpm dev` on a fresh
 * checkout, and a production build started with `AW_DEPLOYMENT_POSTURE=local`, keep starting
 * Claude runs; a production-posture control plane has no such default and offers exactly the
 * engines its environment names (ADR-0073 D7). The posture is `@agent-workspace/core/posture`'s
 * `readDeploymentPosture` (contract C2): unset, it follows `NODE_ENV` as before.
 */
export const DEVELOPMENT_ENGINE_IMAGES: EngineImageMap = new Map([
  ['claude-agent-sdk', 'agent-workspace/runtime:dev'],
]);

/**
 * Parse the control plane's `engine → image` map out of an environment, or throw.
 *
 * The control plane checks the **shape** of every value and never its digest, in production or
 * out. It never starts a container and never hands this string to a driver: it reads the map only
 * to answer `installed` and the run route's `422 engine_not_installed`, and whether a value is
 * pinned changes neither answer. The digest gate belongs where the value is consumed, and it is
 * there — `engineImagesFor`'s `requireDigest` in `apps/runner/src/manager-start.ts` and every
 * driver's `assertDigestPinnedEngineImages` at construction (ADR-0073 D5). Requiring it here too
 * would refuse the shipped `compose.yaml`, whose `web` container is `NODE_ENV=production` (the
 * `Dockerfile`'s `web` target) and whose default is the locally built `agent-workspace/runtime:dev`.
 *
 * A malformed map throws `EngineImageConfigurationError`, whose message names keys and never values.
 * An invalid deployment posture throws `DeploymentPostureError`.
 */
export function readConfiguredEngineImages(
  env: Readonly<Record<string, string | undefined>>,
): EngineImageMap {
  const production = readDeploymentPosture(env) === 'production';
  const images = readEngineImageMap(env, {
    knownEngineIds: ENGINE_IDS,
    requireDigest: false,
    source: 'control-plane environment',
  });
  return images.size === 0 && !production ? DEVELOPMENT_ENGINE_IMAGES : images;
}

const CONFIGURED_ENGINE_IMAGES: EngineImageMap = readConfiguredEngineImages(process.env);

/**
 * Every engine this deployment configured an image for.
 *
 * A test may install its own map with {@link configureEngineImagesForTests}; the shape is
 * `registry.ts`'s `registerEngineForTests`, a global rather than an injected dependency, so a route
 * test can drive a deployment that lacks an engine without threading configuration through every
 * handler signature.
 */
export function configuredEngineImages(): EngineImageMap {
  return globalImages.__agentWorkspaceEngineImages__ ?? CONFIGURED_ENGINE_IMAGES;
}

/**
 * Does this deployment offer `engineId`? The single question `installed` and the run refusal both
 * ask.
 *
 * `local` is deliberately not special-cased here. A `local` runtime runs the agent in the runner's
 * own process and loads whatever adapters the workspace has installed, so it has no image to
 * configure — and a deployment that offers `local` still has to say which engines it offers, or
 * `GET /api/engines` would report a catalogue no driver can serve. ADR-0073 D7 records the
 * consequence: a development deployment sets `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`
 * (or the legacy `RUNTIME_IMAGE`) to the development tag, which `compose.yaml` already does.
 */
export function engineIsInstalled(engineId: string): boolean {
  return configuredEngineImages().has(engineId);
}

/** The sentence a `422 engine_not_installed` carries. Names no image reference. */
export function engineNotInstalledMessage(engineId: string): string {
  const configured = [...configuredEngineImages().keys()].sort();
  return (
    `this deployment has no runtime image for engine ${JSON.stringify(engineId)}, so no sandbox can ` +
    `carry its adapter and no run can be started on it. Engines this deployment offers: ` +
    `${configured.length === 0 ? '(none)' : configured.join(', ')}.`
  );
}

/** Install a map, for tests only. Call {@link clearEngineImagesConfiguredForTests} afterwards. */
export function configureEngineImagesForTests(images: EngineImageMap): void {
  globalImages.__agentWorkspaceEngineImages__ = images;
}

/** Undo every {@link configureEngineImagesForTests}. Call it in `afterEach`. */
export function clearEngineImagesConfiguredForTests(): void {
  delete globalImages.__agentWorkspaceEngineImages__;
}

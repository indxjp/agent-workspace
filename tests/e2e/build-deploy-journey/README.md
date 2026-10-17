# Build-to-deploy journey (issue #801)

A fresh developer goes from `npm create` to a chat turn on a deployment, with the tool run in the
tool sandbox behind the egress proxy:

1. `npm create @indx-workspace@latest demo -- --yes --theme support` against a throwaway Verdaccio
   that serves this checkout's packed packages.
2. A code tool that declares one secret and one allowed host (`tools/get-order.ts`, taken from
   `../tool-sandbox.e2e.mjs`), a promotion bar (`policy.promotion.minEvalScore: 1`), and
   `aw eval run --min-score 1` against `scripted:support-journey` (`scripts/support-journey.json`,
   `AW_SCRIPTED_MODELS_DIR`) with no provider key in the environment, not even a placeholder.
3. `aw deploy production` (single-vm, Docker driver) on this host, with the `@indx-workspace/cli`
   that `npm create` installed, `aw push`, one chat turn that calls the tool, then the gate: with
   one failing case `aw eval run --min-score 1` fails and `aw promote` is refused
   (`production refused`); without it the eval passes and `aw promote` moves production.

Run: `pnpm build && node tests/e2e/build-deploy-journey/journey.e2e.mjs`. It needs Docker with
Compose and Buildx, `openssl` and `npm`, and removes every runtime container on the daemon, so use
a disposable one. CI: the `build-deploy-journey` job of `.github/workflows/journey-live.yml`.

## Known seams

- The deployment answers through the fake Anthropic API, not the scripted model: only the `local`
  posture accepts a scripted model, and a deployment is not in it.
- The single-vm template does not wire the tool sandbox yet (tool host and proxy images, the
  internal `tool-sandbox` network, `RUNTIME_PROXY_BYPASS`). `journey.e2e.mjs` writes that as a
  `compose.override.yaml` next to the deployment's `compose.yaml`; delete `composeOverride` once
  the template carries it.
- The tool-host and egress-proxy images are digest-pinned references into the throwaway registry,
  which the runner demands in production.
- It does not repeat the bearer-in-container checks of `../tool-sandbox.e2e.mjs`.

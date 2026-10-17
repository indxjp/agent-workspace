'use client';

/**
 * The workspace-wide model default — issue #130's Minimum implementation: "Workspace default on
 * the existing `apps/web/app/(shell)/admin/settings` screen — not a new workspace settings
 * screen." This card is mounted there (`admin/settings/page.tsx`) and is deliberately read-only.
 *
 * `workspaces.defaultModelConnectionId`/`defaultModel` (issue #129) are real columns — every run's
 * resolution already falls through to them (`apps/web/instrumentation-node.ts`'s
 * `getWorkspaceModelDefault` call) — but nothing in this repository exposes them over HTTP. Unlike
 * the project layer (`../projects/model.ts`'s header), there is no PATCH route this task could send
 * a request to even optimistically: `apps/web/app/api/workspaces/**` does not exist yet (`W9-WS-119`,
 * a later wave), and the two globs that could carry a narrower route —
 * `apps/web/app/api/models/**`/`apps/web/server/models/**` (`W9-MODEL-129`) and
 * `apps/web/instrumentation-node.ts` (this wave's exclusively-assigned shared file for
 * `W9-PROJ-125`, per the wave plan's Shared-files table) — are both outside what this task may
 * touch. See `docs/adr/W9-MODEL-130-workspace-default-has-no-write-api-in-this-wave.md` for the
 * full reasoning and the declared gap (G-9).
 *
 * So this card does what every other unconfigured subsystem in this application already does for a
 * capability that is not wired up (`models-screen.tsx`'s own "No providers are configured yet",
 * `AgentModelSection`'s `catalogState.kind === 'failed'` message): it says so, plainly, rather than
 * accepting a click that would not actually save anything.
 */
export function WorkspaceModelDefaultCard() {
  return (
    <section
      className="rounded-(--radius) border border-border bg-surface p-4"
      aria-labelledby="workspace-model-default-heading"
    >
      <h2 id="workspace-model-default-heading" className="mb-1 text-[15px] font-semibold">
        Workspace default model
      </h2>
      <p className="text-[13px] text-muted">
        The last rung of the resolution ladder, below the project default and the agent override.
        Setting it from this screen is not available yet — this deployment has no API route to
        change it, only to read it during a run. Until one lands, unset it stays{' '}
        <code>not set</code>, and a run with no project or agent default configured is refused with
        the reason named at the layer that failed, rather than silently guessing.
      </p>
    </section>
  );
}

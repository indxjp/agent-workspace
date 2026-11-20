---
title: Risks and debt
evidence: [.dependency-cruiser-known-violations.json, tests/architecture-rules.test.ts:541-586, apps/web/server/application-context.ts:15-51, apps/web/server/features/console.ts:15-16, apps/web/server/client-identity.ts:8, apps/web/server/runs/api.ts:64, apps/web/server/oauth/store.ts:17, apps/web/server/files/file-path-policy.ts:2, packages/contracts/src/agents.ts:1, docs/architecture.md:704-713, eslint-suppressions.json]
---

### The server's contexts form one cycle

`jevlint architecture check --static` reports a single component cycle through `composition`,
`server-kernel` and every server context. Part of it is by design: `application-context.ts` imports a
type from every domain (lines 15-39) and every domain reads `applicationContext()`. The rest is debt:
imports against the context order in `contexts.json`.

| From | Into (upstream rule broken) | Examples |
| --- | --- | --- |
| `execution` | `agent-authoring`, `integrations` | `apps/web/server/runs/api.ts:64`, `apps/web/server/runs/environment.ts:32`, `apps/web/server/runs/transcription.ts:11` |
| `storage-sharing` | `agent-authoring`, `execution` | `apps/web/server/files/file-path-policy.ts:2`, `apps/web/server/shares/http.ts:1`, `apps/web/server/shares/session-snapshot/snapshot.ts:4` |
| `identity` | `agent-authoring`, `execution`, `integrations` | `apps/web/server/oauth/store.ts:17`, `apps/web/server/setup/runtime-detection.ts:1`, `apps/web/server/oauth/resource.ts:6` |
| `server-kernel` | `identity`, `execution`, `storage-sharing`, `composition` | `apps/web/server/audit/api.ts:25`, `apps/web/server/pagination/list-cursor.ts:21`, `apps/web/server/http/rate-limit.ts:26`, `apps/web/server/features/console.ts:15` |

These match the repository's own ceilings (`context-*-imports-only-upstream` 31 in all,
`shared-kernel-imports-no-context` 5). Two kernel imports are not in that baseline because the
repository's map does not cover root files: `apps/web/server/features/console.ts:15` (into `application-context.ts`)
and `apps/web/server/client-identity.ts:8` (into `auth/session`).

### Hubs

`jevlint architecture plan` ranks the contracts barrels (`agents.ts`, `agent-versions.ts`,
`project-file.ts`, `surfaces.ts`, `setup.ts`) as hubs used by up to 16 components. They are deliberate
public surfaces listed by name, so a change to one fans out to every client; the API reports in
`docs/10-product/sdk/api/` make that visible. In `packages/core`, repositories such as `agents.ts`,
`agent-versions.ts` and `directory.ts` are hubs inside `persistence`.

### Persistence outside stores

31 files in `apps/web/server` still name `core/db` outside a `store.ts`
(`domain-does-not-import-persistence`). This SSOT cannot check it, because the rule is per file
inside a component; it is the checklist item `only-stores-name-persistence`.

### Layer exceptions this SSOT accepts

- `sandbox-tools` sits in the delivery layer because the tool host imports the tool-host contract
  type from `@indx-workspace/aw/tools/host` (`packages/tool-host/src/intake.ts:25`).
- `agent-authoring` imports `gateway` (evaluations) and `sdk` (the Builder's definition), so the
  control plane depends on two packages beside `core`.

### Hard to change

- `apps/web/server/runs/api.ts` is named as the largest unit still due to be split
  (`docs/architecture.md:706`).
- Interrupt is per replica (issue #261), and there is no run-attempt row or renewable launch lease.
- Runner, gateway and web each have bare durations and direct clock calls counted by
  `pnpm durations:check` and `pnpm clock:check`.
- Test code is mixed into source folders (`*.test-support.ts`, `*.contract.ts`, conformance suites,
  acceptance harnesses); this SSOT ignores them by pattern, so a production file with such a name
  would be missed.

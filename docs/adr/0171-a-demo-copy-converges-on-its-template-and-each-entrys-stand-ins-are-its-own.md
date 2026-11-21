# ADR-0171 — A demo copy converges on its template, and each entry's stand-ins are its own

Status: accepted
Date: 2026-11-21
Decided by: the implementing agent of the verification-fill fix (issue #2407, the Agent Store 100-use-case programme, tracker #2383), on the Owner's delegation for the programme
Scope: `apps/web/server/demo/provision/template-copy.ts`, `template-copy-connectors.ts`, `template-copy-files.ts`, `template-copy-skills.ts`, and `apps/web/server/skills/workspace-skills.ts` (`WorkspaceSkills.publish`)

## Context

A visitor's demo copy and the real-model verification workspace (R1, `PUT /api/demo/verification/{id}`)
are made by one copier (`copyFor` in `template-copy.ts`). Two things about it broke R1 on staging,
where one verification workspace holds every seeded entry:

- **A repeat copy kept what an earlier copy made.** An agent, a skill and a stand-in were found by
  name and kept as they were; only the policy, the caps and the sandbox were applied again. The
  staging workspace was filled on 2026-11-16, before the template seed learned to declare the
  connector tools of most entries and to gate the quotation's openapi writes. Every later fill kept
  the old stand-ins, which offered one `send` tool, so R1 found `searchDefects`, `check_authority`,
  `list_members`, `ticket_update` and `message_list` missing and `createQuote` not waiting for
  approval. A change to a skill, a sample file or a stand-in's records was never carried either.
- **Two entries that name the same connector shared one stand-in.** A stand-in was found by its
  name, so the second entry got the first entry's tools and records: the customer inquiry agent ran
  on the sales assistant's `crm` stand-in. A visitor who tried both entries in one demo workspace
  had the same problem.

The visitor path never showed the first problem only because a visitor's workspace is new.

## Decision

### D1 — Every copy brings the earlier copy to the template as it is now

A repeat copy finds an agent, a skill and a stand-in by name, as before, and makes it what a first
copy would make now, in place, so its id, its grant and its sessions stay:

- the agent gets the template's instructions and permissions (internet always off) and its
  assignments are replaced with the files, skills and stand-ins just copied; the policy, caps and
  sandbox are applied as before;
- a skill whose files differ from the template's is published with the template's files
  (`WorkspaceSkills.publish`, the `POST /api/skills/:name/revisions` sequence), so every agent it
  is assigned to follows them;
- a stand-in whose command or arguments differ from what the template makes now is updated. What
  happens to the approved writes a records stand-in has kept (ADR-0169 D3) is D2;
- a sample file the template has and the workspace does not is copied.

A copy whose template has not changed writes nothing: no skill revision, no stand-in update.
Comparing content, not a stored version, also carries a change to the copier itself (the stand-in's
source) into a copy made before it.

### D2 — What earlier runs left: kept for a visitor, reset for verification

This is the one deliberate difference between the two paths, and it covers two things a run can
leave behind.

- **Sample files.** A visitor's demo keeps a sample file an earlier copy left (its runs may have
  written it; it is the visitor's). The verification workspace resets it to the template's bytes
  (`replace: true`).
- **Kept approved writes.** In a visitor's demo, a refresh carries the approved calls a records
  stand-in keeps into its new state, as long as the new stand-in still records their write. They are
  read from the row whatever release's stand-in source it runs, so neither a template change that
  keeps the write nor a deploy that changes `records-server.ts` drops them. A template that no longer
  records the write drops its calls, since nothing could answer them. In the verification workspace
  every refill clears them, unchanged template included.

Both resets make R1 repeatable: a run starts from what the deployment seeded, not from what an
earlier run wrote. Without them, an entry whose moment is an approved write (the onboarding agent's
`create_task`) would find every task already made after two dispatches, rightly create none, and fail
its `approval` check.

### D3 — A stand-in belongs to one entry

The copy names an entry's stand-in after the template's connector, unless that name is held by a
connector that is not a stand-in or by a stand-in an agent of another entry is assigned. Then it is
named `<connector>-<entry>` (the tool keys become `mcp__<connector>-<entry>__<tool>`). Ownership is
read from the assignments, so the names are stable across refills in the same entry order. Tool rules
and approval gates follow the stand-in by id (`policy-remap.ts`), the approved-write recorder finds a
stand-in by its name or id (ADR-0169 D3), and the real-model harness matches a tool by the part after
`__`, so neither is affected by the longer name. A connector under the name a copy would use that is
not a stand-in (one a person added) is never overwritten: the copy fails instead.

Amended 2026-11-21 (R1 run 44891928173): as first shipped, only the tool rules (`base`,
`autoApprove`, `deny`) followed the stand-in. The approval gates (`requireApproval`) stayed on the
template connector's name, so a renamed stand-in's write (the incident entry's `create_task` on
`tracker-incident`) matched no gate and ran without a person's approval. The copy now writes every
gate on the stand-in's id, whether the template wrote it on the connector's name or its id, and
compose points a gate on a connector's id at that connector's key in the run, as it does for tool
rules.

A workspace an earlier release filled holds one stand-in two entries share. The first refill after
this change gives it to the entry copied first (the fill copies in slug order) and makes the other
entry a new `<connector>-<entry>` stand-in, once. Approved writes the other entry had kept in the
shared stand-in are not carried to its new one.

### D4 — What one workspace still cannot hold

A folder and a skill are found by path and name. Two entries granted the same folder path share it
and each sees the other's sample files there (today `manuals`, held by maintenance troubleshooting
and manual search, and the empty `drafts` scratch folder); two entries that held one file path or one
carried skill name with different content would overwrite each other on every fill, and two agents
with one name would be one copy. `tests/store/seed/seed.test.ts` refuses the last three for the
entries the deploy seeds, so a change that would introduce one fails before it reaches staging. A
file a template drops stays in the workspace (another entry may hold it), and an agent a template
renames leaves its old copy behind; neither is run by R1, which finds each entry's agent by name.

## Consequences

- A refill after any deploy now runs every entry's current template, and the deploy's own refresh
  step (`store-deploy.yml`, "Refresh the staging verification workspace") is what refills staging;
  a new, empty verification workspace is no longer needed after a template change.
- A visitor who signs in again for an entry whose template changed since gets the new agent, skills
  and stand-ins in place; their sample files and their agent's sessions stay.
- In a workspace that holds two entries with one connector name, the second entry's tool names carry
  the `-<entry>` suffix; a visitor sees the same names a verification run sees.
- The skills domain gains `WorkspaceSkills.publish`, a second caller of the revision publish
  sequence; no route changes.

## Alternatives considered

- **Store the template's version on the copy** and replace everything when it changes. It needs a
  place to keep the version and misses a change to the copier; comparing what is there with what the
  template makes needs neither.
- **Delete the copy and make it again.** A skill cannot be removed while another entry's agent holds
  it, a visitor would lose their sessions, and the approved writes of an unchanged stand-in would go.
- **One verification workspace per entry.** It would hold every entry exactly as a visitor's demo
  does, shared folders included, but needs a workspace, a key and a secret per entry and a harness
  that switches between them. The shared-folder difference (D4) does not change what R1 judges; if
  it ever does, one workspace per conflict group is the smallest step.
- **Merge two entries' stand-ins into one.** Each entry would be offered the other's tools and
  records, which is what broke the customer inquiry agent.

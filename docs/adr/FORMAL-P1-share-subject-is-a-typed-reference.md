# ADR-FORMAL-P1-share-subject-is-a-typed-reference — A share's subject is one typed, tenant-paired reference per subject type

Status: proposed
Date: 2026-09-23
Decided by: formal specification programme, unit P1-synthesis (`er-synthesis`); needs Owner ratification
Scope: `packages/core/src/db/schema/shares.ts`, `apps/web/server/shares/core/service.ts`, `apps/web/server/composition/register.ts`

## Context

`shares.subject_id` is polymorphic text with no foreign key. `subjectOwnership` answers `unknown`
for agents, skills and ids it cannot find, and an Owner's or Admin's grant allows `unknown`, so a
share can name a missing subject, a subject of the wrong type or another workspace's row
(publication finding 6). It is the only reference between tenant-carrying rows that the database
does not pair. No data crosses a tenant today, because the label and snapshot are client-authored
(RF-103), but a server-owned snapshot would read the subject by id.
`AgentWorkspace.Theorems.Refinement.ErSynthesis` shows three states today's schema admits and the
target refuses: `diverges_at_a_dangling_subject`, `diverges_at_a_cross_workspace_subject` and
`diverges_at_a_wrongly_typed_subject`.

## Decision

Replace `subject_id` by four nullable columns, `subject_agent_id`, `subject_session_id`,
`subject_project_id` and `subject_skill_id`, each with a tenant-paired key
`(subject_<type>_id, workspace_id) → <type>s (id, workspace_id) ON DELETE CASCADE`, and the check
`shares_subject_matches_type` (exactly the column the subject type names is set). Deleting a subject
deletes its shares.

## Alternatives considered

- **Resolve the subject in `publish` only (RF-103).** Closes today's path but not another writer's;
  the database still admits the states above.
- **`ON DELETE SET NULL` instead of `CASCADE`.** Keeps a share with no subject, which then serves
  nothing; revocation is the documented way to end a share.
- **One `subject_id uuid` plus a trigger per type.** Keeps one column but moves the constraint out
  of the declarative schema, where `tenancy.test.ts` cannot see it.

## Consequences

- `target_share_subject_stays_in_workspace` proves that in the target a share's subject is exactly
  one row of its type, in the share's workspace.
- The migration moves each id to its type's column (`AgentWorkspace.Er.Refinement.splitSubject`);
  rows whose subject is missing or foreign must be revoked first, and the migration reports them.
- `NON_REFERENCE_ID_COLUMNS` loses `shares.subject_id` (`AgentWorkspace.Er.Target.nonReferenceIdColumns`).

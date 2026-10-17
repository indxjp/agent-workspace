# Run-token and transcript security controls

## Run-token lifetime and revocation

Provider tokens are signed, registered by token ID, and bound to one workspace, run, session,
agent, and model connection. The gateway verifies the signature, expiry, registration/revocation
state, live run state, and every bound resource before resolving a provider credential.

Workspace owners and admins can revoke one token or every active token for a run with:

```http
POST /api/runs/:runId
Content-Type: application/json

{"tokenId":"<token UUID>"}
```

Use `{}` (or `{"tokenId":null}`) to revoke all active tokens for the run. Terminal run transitions
also revoke all remaining tokens in the same database transaction.

The Agent SDK subprocess receives its auth environment only once, at spawn time; the parent runner
cannot safely replace that value in an already-running process. Until a runner-local authenticated
refresh proxy is introduced, the control plane enforces a hard run lifetime at 90% of the configured
gateway token TTL. At that deadline it aborts the runner stream, sends an interrupt, records the run
as failed, and atomically revokes its tokens. Thus a run cannot remain active while using an expired
credential.

## Transcript authorization and lifecycle

Browser transcript requests are limited to sessions owned by the current user. Workspace owners
and admins may inspect or delete any workspace session; builders and viewers may not access another
user's session.

Runner transcript requests use the same per-run signed token as the model gateway. The control
plane checks that its workspace, run, session, and agent still agree with durable rows, and then
checks the requested transcript path and declared project key against the signed session/workspace.
No workspace-selection header or deployment-wide mirror bearer is accepted.

`session_transcripts` is tenant-paired to `sessions` with `ON DELETE CASCADE`; deleting a platform
session therefore removes its main transcript, subagent transcript heads, and all message rows.

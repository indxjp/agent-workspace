# @indx-workspace/contracts

The wire contracts of the Agent Workspace control-plane API, as [Zod](https://zod.dev) schemas
with derived TypeScript types. This is the package a client validates responses against and a
server tests its serializers against; `@indx-workspace/sdk` is built on it.

Its one dependency is `zod` 4, declared as a peer so the schemas share your project's zod
instance — no database, no framework, no Node API — so it can be imported from a browser bundle,
a Node service, or an edge runtime.

## Entry points

| Import                                       | Contents                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `@indx-workspace/contracts`                  | `ApiProblemSchema` (the one error envelope), `COMMON_PROBLEM_CODES`, `UuidSchema`, `IsoDateTimeSchema`                                       |
| `@indx-workspace/contracts/agents`           | `AgentResourceSchema`, permissions, resource assignments, list envelope, input types                                                         |
| `@indx-workspace/contracts/runs`             | `RunResourceSchema`, `StartRunRequestSchema`, `StartRunResponseSchema`, `RunListResponseSchema`, enums and bounds                            |
| `@indx-workspace/contracts/run-events`       | The `GET /api/runs/:id/events` vocabulary: control frames, `run.status`, relayed event names, frame `data` schemas                           |
| `@indx-workspace/contracts/sessions`         | `SessionResourceSchema`, envelopes, `UpdateSessionPatch`                                                                                     |
| `@indx-workspace/contracts/projects`         | `ProjectResourceSchema`, envelopes, `ProjectSessionResponseSchema`, input types                                                              |
| `@indx-workspace/contracts/workspaces`       | `WorkspaceResourceSchema`, `WorkspaceMembershipViewSchema`, envelopes, input types                                                           |
| `@indx-workspace/contracts/team`             | `MEMBERSHIP_ROLES`, `MembershipResourceSchema`, list envelope                                                                                |
| `@indx-workspace/contracts/invitations`      | `InvitationResourceSchema`, `IssuedInvitationResponseSchema`, list envelope                                                                  |
| `@indx-workspace/contracts/project-file`     | `ProjectDocumentSchema` (`agent-workspace.yaml` v2: engine, models, connectors, policy), `readProjectDocument`, `DeploymentDocumentV1Schema` |
| `@indx-workspace/contracts/setup`            | `SETUP_QUESTIONS`, `SETUP_THEMES`, `THEME_RECOMMENDATIONS`, `setupQuestionApplies`, the answer schemas, `withRecommendedAnswers`             |
| `@indx-workspace/contracts/local-runtime`    | The local runtime IPC messages: `LocalRuntimeMessageSchema`, the per-direction unions, `start` policy and `withheld`                         |
| `@indx-workspace/contracts/policy-ceiling`   | `ProjectPolicySchema` (the project policy ceiling), `policyWidenings`, `meetPolicyCeiling`, `PolicyWidening`                                 |
| `@indx-workspace/contracts/secret-reference` | `SecretReferenceSchema` (`{ secret: NAME }`, never a value), `SecretNameSchema`, `RESERVED_SECRET_NAMES`, `isReservedSecretName`             |
| `@indx-workspace/contracts/surfaces`         | `SurfaceDefinitionSchema` (rung 1 look and rung 2 layout and parts), `SurfaceThemeSchema`, `SurfacePartsSchema`, enums and bounds            |
| `@indx-workspace/contracts/agent-versions`   | `AgentVersionBodySchema`, version draft, resource, pointer and list schemas, create-from-version, `AGENT_VERSION_PROBLEM_CODES`              |
| `@indx-workspace/contracts/connectors`       | `ConnectorResourceSchema` (kinds `mcp`, `openapi`, `postgres`), `connectorKindOf`, body caps per kind, MCP inputs                            |
| `@indx-workspace/contracts/tool-connectors`  | Tool connector create bodies, `allow` rules, `selectAllowedOperations`, `toolServerKey`, `connectorServerKey`, `GATEWAY_TOOL_ROUTE`, `GATEWAY_TOOL_SANDBOX_ROUTE`                              |
| `@indx-workspace/contracts/feedback`         | `RunFeedbackRequestSchema` (`{ rating: 'up' \| 'down', comment? }`, C19), `RUN_FEEDBACK_RATINGS`, `RUN_FEEDBACK_COMMENT_MAX_LENGTH`          |
| `@indx-workspace/contracts/evaluations`      | `EvalCaseFileSchema` (`evals/<agent>.yaml`), `CreateEvaluationRequestSchema`, `EvaluationResourceSchema`, `EVALUATION_PROBLEM_CODES`         |
| `@indx-workspace/contracts/features`         | `FEATURE_IDS`, `FeatureId`, `ROUTE_FEATURES`, `RouteFeature`: what can be switched off (ADR-0160)                                            |

## Reading a response

```ts title="illustrative" claim="illustrative"
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { RunResourceSchema } from '@indx-workspace/contracts/runs';

const response = await fetch(`${baseUrl}/api/runs/${runId}`, {
  headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
});
const body: unknown = await response.json();
if (!response.ok) {
  const { error } = ApiProblemSchema.parse(body);
  throw new Error(`${String(response.status)} ${error.code}: ${error.message}`);
}
const { run } = z.object({ run: RunResourceSchema }).parse(body);
```

## Rules the schemas follow

- Owned resources are `.strict()`: an unknown key is drift, not data. A control-plane release
  that adds a response field ships a new minor of this package; pin the version to the release
  you deploy against.
- Dates are ISO-8601 strings; ids are UUIDs; money is a decimal string; `bigint` never appears.
- Request **input** shapes (`CreateAgentInput`, `ProjectPatchInput`, …) are types, not schemas:
  the server validates them and answers field-specific problems.
- Nothing here carries a credential. A response that would (an API key at mint time, an
  invitation token) is documented as shown-once on its own schema.

The design, the migration plan and the feature map are in the repository's `docs/sdk/`.

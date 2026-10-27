/**
 * `@indx-workspace/contracts` — the wire contracts of the Agent Workspace control-plane API.
 *
 * This root entry carries only the cross-cutting foundations every domain shares: identifiers, the
 * error envelope and the contracts version. Each domain is its own subpath (`@indx-workspace/contracts/runs`, …) so a
 * consumer that validates one resource does not load every schema in the platform.
 *
 * Nothing here depends on a database, a framework, or a runtime other than `zod`; the package is
 * importable from a browser, a Node service, and an edge runtime alike.
 */
export { IsoDateTimeSchema, UUID_PATTERN, UuidSchema, isUuid } from './identifiers.js';
export {
  ApiProblemBareCodeSchema,
  ApiProblemDetailSchema,
  ApiProblemSchema,
  COMMON_PROBLEM_CODES,
  IN_USE_REFERRER_KINDS,
  formatInUseReferrer,
  parseInUseReferrers,
  type ApiProblem,
  type CommonProblemCode,
  type InUseReferrer,
  type InUseReferrerKind,
} from './problem.js';
export {
  McpHttpServerConfigSchema,
  McpServerConfigSchema,
  McpServerRecordSchema,
  McpSseServerConfigSchema,
  McpStdioServerConfigSchema,
  McpToolPolicySchema,
  type McpServerRecord,
  type McpToolPolicy,
} from './mcp-server-config.js';
export {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
  CONTRACTS_VERSION_PROBLEM_CODES,
  judgeContractsVersion,
  parseContractsVersion,
  type ContractsVersion,
  type ContractsVersionProblemCode,
  type ContractsVersionVerdict,
  type ServedContractsRange,
} from './version.js';

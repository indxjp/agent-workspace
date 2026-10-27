import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';

import type { AgentRecord } from '../../../agents/contract';
import type { AuthorizationPort } from '../../ports';
import { createAuthorization } from './production';

/** What a test may say about an agent beyond its owner. */
type Stored = Pick<AgentRecord, 'ownerPrincipalId' | 'name' | 'builtin' | 'createdByAgent'>;
export type MemoryAgentOptions = Partial<Omit<Stored, 'ownerPrincipalId'>> & {
  /** Version bodies by number. */
  readonly versions?: Readonly<Record<number, AgentVersionBody>>;
};

/** Agents and grants held in maps, answered by the same RBAC rule production applies. */
export class MemoryAuthorization implements AuthorizationPort {
  private readonly agents = new Map<string, Stored>();
  private readonly bodies = new Map<string, AgentVersionBody>();
  private readonly grants = new Set<string>();
  private readonly delegate: AuthorizationPort;

  constructor(ceiling: ProjectPolicy | null = null) {
    this.delegate = createAuthorization({
      agents: {
        forWorkspace: (workspaceId) => ({
          get: (id) => {
            const agent = this.agents.get(`${workspaceId}/${id}`);
            return Promise.resolve(agent === undefined ? null : { id, ...agent });
          },
        }),
      },
      versions: {
        forWorkspace: (workspaceId) =>
          Promise.resolve({
            find: (agentId, number) => {
              const body = this.bodies.get(`${workspaceId}/${agentId}/${String(number)}`);
              return Promise.resolve(body === undefined ? null : { body });
            },
          }),
      },
      ceiling,
      grants: {
        forWorkspace: (workspaceId) => ({
          hasGrant: (agentId, userId) =>
            Promise.resolve(this.grants.has(`${workspaceId}/${agentId}/${userId}`)),
        }),
      },
    });
  }

  addAgent(
    workspaceId: string,
    ownerPrincipalId: string,
    { name, versions = {}, ...rest }: MemoryAgentOptions = {},
  ): string {
    const id = crypto.randomUUID();
    this.agents.set(`${workspaceId}/${id}`, {
      ownerPrincipalId,
      name: name ?? `agent-${id}`,
      ...rest,
    });
    for (const [number, body] of Object.entries(versions)) {
      this.bodies.set(`${workspaceId}/${id}/${number}`, body);
    }
    return id;
  }

  addGrant(workspaceId: string, agentId: string, userId: string): void {
    this.grants.add(`${workspaceId}/${agentId}/${userId}`);
  }

  access: AuthorizationPort['access'] = (ctx, kind, agentId) =>
    this.delegate.access(ctx, kind, agentId);

  creator: AuthorizationPort['creator'] = (ctx) => this.delegate.creator(ctx);

  target: AuthorizationPort['target'] = (ctx, agentId, version) =>
    this.delegate.target(ctx, agentId, version);
}

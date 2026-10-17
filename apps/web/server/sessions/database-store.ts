import type {
  SessionTranscriptRepository,
  SessionTranscriptRepositoryProvider,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';

import type {
  TranscriptEntry,
  TranscriptKey,
  TranscriptSessionListing,
  TranscriptStore,
} from './transcript';

/** Adapter from the web session mirror port to the tenant-scoped PostgreSQL repository. */
export class DatabaseTranscriptStore implements TranscriptStore {
  public constructor(
    private readonly repositories: SessionTranscriptRepositoryProvider,
    private readonly scopes: WorkspaceScopeResolver,
  ) {}

  async #repository(projectKey: string): Promise<SessionTranscriptRepository | null> {
    const scope = await this.scopes.forWorkspaceId(projectKey);
    return scope === null ? null : this.repositories.forScope(scope);
  }

  async append(key: TranscriptKey, entries: readonly TranscriptEntry[]): Promise<void> {
    const repository = await this.#repository(key.projectKey);
    if (repository === null) throw new Error(`no workspace has projectKey ${key.projectKey}`);
    await repository.append(key, entries);
  }

  async load(key: TranscriptKey): Promise<TranscriptEntry[] | null> {
    const repository = await this.#repository(key.projectKey);
    if (repository === null) return null;
    const entries = await repository.load(key);
    return entries === null ? null : (entries as TranscriptEntry[]);
  }

  async listSessions(projectKey: string): Promise<TranscriptSessionListing[]> {
    const repository = await this.#repository(projectKey);
    if (repository === null) return [];
    return [...(await repository.listSessions(projectKey))];
  }

  async delete(key: TranscriptKey): Promise<void> {
    const repository = await this.#repository(key.projectKey);
    if (repository !== null) await repository.delete(key);
  }

  async listSubkeys(key: {
    readonly projectKey: string;
    readonly sessionId: string;
  }): Promise<string[]> {
    const repository = await this.#repository(key.projectKey);
    if (repository === null) return [];
    return [...(await repository.listSubkeys(key))];
  }

  /** Retention-only operation; transcript deletion remains distinct from session archival. */
  async purgeBefore(projectKey: string, before: Date): Promise<number> {
    const repository = await this.#repository(projectKey);
    return repository === null ? 0 : repository.purgeBefore(before);
  }
}

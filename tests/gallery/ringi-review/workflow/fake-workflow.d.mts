export interface FakeWorkflow {
  readonly url: string;
  readonly requests: { method: string; path: string }[];
  readonly comments: { ringiId: string; revision: number; body: string; by: string }[];
  close(): Promise<void>;
}
export function startFakeWorkflow(options: {
  token: string;
  /** What verifies the caller's `x-aw-identity` header. */
  identity: { key: string | readonly string[]; audience: string; workspace: string };
  port?: number;
  accessFile?: string;
}): Promise<FakeWorkflow>;

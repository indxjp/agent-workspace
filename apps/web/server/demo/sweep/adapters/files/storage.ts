import type { DemoWorkspaceFiles } from '../../ports';

/** The part of the storage service (`storage/service-contract.ts`) the deletion of a demo workspace reads. */
export interface DemoStorage<Area extends string = string> {
  list(
    ctx: { readonly workspaceId: string },
    area: Area,
    folder: string,
    page?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<{
    readonly rows: readonly { readonly path: string }[];
    readonly cursor: string | null;
  }>;
  remove(
    ctx: { readonly workspaceId: string },
    area: Area,
    path: string,
    opts: { readonly recursive: boolean },
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }>;
}

/** Files per catalog page while the workspace's files are listed. */
const LIST_PAGE_SIZE = 200;

/**
 * The production {@link DemoWorkspaceFiles}: every file of every storage area in `areas` (the
 * composition root names them, because the demo domain does not reach object storage itself) is listed from the
 * catalog and removed through the storage service, which deletes the object and then its row. No
 * actor is given, so the removal is a system action and writes no audit row of its own: the
 * workspace's audit log goes with the workspace. A file that is already gone is not an error.
 */
export function createDemoWorkspaceFiles<Area extends string>(
  storage: DemoStorage<Area>,
  areas: readonly Area[],
): DemoWorkspaceFiles {
  return {
    async removeAll(workspaceId) {
      const ctx = { workspaceId };
      for (const area of areas) {
        const paths: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await storage.list(ctx, area, '', {
            limit: LIST_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          });
          paths.push(...page.rows.map((row) => row.path));
          cursor = page.cursor ?? undefined;
        } while (cursor !== undefined);
        for (const path of paths) {
          const removed = await storage.remove(ctx, area, path, { recursive: false });
          if (!removed.ok && removed.code !== 'not_found') {
            throw new Error(`could not remove a demo workspace file (${removed.code})`);
          }
        }
      }
    },
  };
}

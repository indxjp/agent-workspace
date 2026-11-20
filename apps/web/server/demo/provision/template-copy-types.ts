import type { CatalogFile } from './catalog-rows';

/** Who a template copy is made for, in the visitor's (or verification) workspace. */
export interface Visitor {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
}

/** A template workspace with its catalog rows read once for the whole copy. */
export interface TemplateSource {
  readonly workspaceId: string;
  readonly rows: readonly CatalogFile[];
}

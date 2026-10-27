import type { CatalogEntry, CatalogPort } from '../../ports';
import { readableKinds } from './access';

export class MemoryCatalog implements CatalogPort {
  constructor(private readonly entries: readonly CatalogEntry[]) {}

  list: CatalogPort['list'] = (ctx, kinds) => {
    if (ctx.caller.kind === 'none') return Promise.resolve([]);
    const readable = readableKinds(ctx.caller.principal.role, kinds);
    return Promise.resolve(
      readable.flatMap((kind) => this.entries.filter((entry) => entry.kind === kind)),
    );
  };
}

/**
 * The app's resource stores over one Drizzle database: one store per resource, a `definePages`
 * resource's being its page store, each publishing a write on the channels bound to its resource
 * in the write's transaction (#1519) and telling `onCommitted` once it is committed (#1513).
 * `appRuntime` serves its routes and agent tools from them and `serveRecipes` its recipes' `store`
 * (ADR-0164), so a write means the same thing whichever of them makes it.
 */
import { pageStoreOf } from '../db/page-store.js';
import type { OnCommitted, ResourceStore } from '../db/port.js';
import { storeOf, type AppDatabase } from '../db/store.js';
import { isPageResource } from '../pages/define-pages.js';
import type { DefinedResource, FieldMap } from '../resource.js';
import { publishBoundWrite } from './channel-bindings.js';

/** The store of `resource`, the same one on every call. */
export type StoreLookup = <F extends FieldMap>(resource: DefinedResource<F>) => ResourceStore<F>;

/** The per-resource store lookup over `build`: one store per resource, built on first use. */
export function storesBuiltBy(build: (resource: DefinedResource) => ResourceStore): StoreLookup {
  const stores = new WeakMap<DefinedResource, ResourceStore>();
  return <F extends FieldMap>(resource: DefinedResource<F>): ResourceStore<F> => {
    const key = resource as unknown as DefinedResource;
    let store = stores.get(key);
    if (store === undefined) {
      store = build(key);
      stores.set(key, store);
    }
    return store as unknown as ResourceStore<F>;
  };
}

/** What {@link appStoresOf} takes. */
export interface AppStoresOptions {
  readonly db: AppDatabase;
  /** The app's name key; its data lives in the schema `app_<name>`. */
  readonly appName: string;
  /** Told about each committed write: the recipes' `notifyRecipes`. */
  readonly onCommitted: OnCommitted;
}

/** The stores of the app's resources over `options.db`. */
export function appStoresOf(options: AppStoresOptions): StoreLookup {
  const storeOptions = {
    db: options.db,
    appName: options.appName,
    afterWrite: publishBoundWrite,
    onCommitted: options.onCommitted,
  };
  return storesBuiltBy((resource) =>
    isPageResource(resource)
      ? pageStoreOf(resource, storeOptions)
      : storeOf(resource, storeOptions),
  );
}

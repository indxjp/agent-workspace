import type { ModelDiscovery } from '../models/discovery';
import type { ModelsStoreProvider } from '../models/store';

/** Models capability shared by the setup workflow and run composition. */
export type InstalledModelsApi = {
  readonly models: ModelsStoreProvider;
  readonly discover: ModelDiscovery;
};

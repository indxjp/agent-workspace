import type { KubernetesObject } from '@kubernetes/client-node';

export type KubernetesResource = KubernetesObject & {
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
  };
  readonly spec?: unknown;
  readonly status?: unknown;
};

export interface KubernetesResourceClient {
  create(resource: KubernetesResource, fieldManager?: string): Promise<KubernetesResource>;
  delete(resource: KubernetesResource): Promise<unknown>;
  /** Needed only by shared-namespace mode, to learn the gateway Service's ClusterIP. */
  read?(resource: KubernetesResource): Promise<KubernetesResource>;
}

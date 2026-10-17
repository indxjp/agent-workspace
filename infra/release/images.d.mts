export type ReleaseImage = {
  name: string;
  dockerfile: string;
  target: string;
  engine: string | null;
  engineVersion: string | null;
};

export const RELEASE_IMAGES_FILE: string;
export const IMAGE_NAMESPACE: string;

export function readReleaseImages(root?: string): {
  registry: string;
  version: string;
  images: Record<string, string>;
};

export function releasePlan(root?: string): ReleaseImage[];

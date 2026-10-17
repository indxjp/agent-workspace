import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'PT-U5-PLATFORM-EXPORTS-968',
    resource: 'agents',
    sub: 'platform-exports',
    because:
      'An export compiles one stored version of an agent, so it inherits the parent agent authorization exactly as the versions sub-resource does: Builder on its own agents, Admin on any, Viewer none.',
  },
  {
    owner: 'PT-U5-PLATFORM-EXPORTS-968',
    resource: 'agents',
    sub: 'platform-archives',
    because:
      'The archive is the same export as a tar, so it carries the same authorization as platform-exports.',
  },
];

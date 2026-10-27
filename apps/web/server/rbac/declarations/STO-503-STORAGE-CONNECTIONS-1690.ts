import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    resource: 'storage-connections',
    sub: 'credential',
    because:
      'rotating the credential of a storage connection is a write on that connection, the same §21 width as editing it: Owner and Admin manage it, no other role does.',
  },
  {
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    resource: 'storage-connections',
    sub: 'test',
    because:
      'testing a storage connection lists one page of an allowed folder and changes nothing, so it is a read on that connection: every role that may look at a connection (Owner, Admin, Builder) may test it, and a Viewer may not.',
  },
  {
    owner: 'STO-503-STORAGE-CONNECTIONS-1690',
    resource: 'storage-connections',
    sub: 'browse',
    because:
      'browsing a storage connection lists a folder its allowedPrefixes name, a read on that connection (Q-22): Owner, Admin and Builder may browse, a Viewer may not.',
  },
];

import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'SDK-19-PRESIGNED-FILES-251',
    resource: 'files',
    sub: 'upload-urls',
    because:
      '§21 lets a Builder create and edit files they own and an Admin any file, and a presigned upload URL is the permission to write that file, so it inherits the parent files write grant exactly as POST /api/files does.',
  },
  {
    owner: 'SDK-19-PRESIGNED-FILES-251',
    resource: 'files',
    sub: 'upload-complete',
    because:
      '§21 lets a Builder create and edit files they own and an Admin any file, and completing an upload is the permission to write that file, so it inherits the parent files write grant exactly as POST /api/files does.',
  },
  {
    owner: 'SDK-19-PRESIGNED-FILES-251',
    resource: 'files',
    sub: 'download-urls',
    because:
      '§21 gives every role read access to the files it may see, and a presigned download URL is the permission to read that file, so it inherits the parent files read grant exactly as GET /api/files/:id does.',
  },
];

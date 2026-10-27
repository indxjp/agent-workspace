import type { ScreenDeclaration } from '../inventory-support.js';

export const screens: readonly ScreenDeclaration[] = [
  {
    mockup: 'ui/storage.html',
    owner: 'STO-508',
    status: 'shipped',
    route: '/admin/storage',
    page: 'apps/web/app/(shell)/admin/storage/page.tsx',
  },
  {
    mockup: 'ui/storage-new.html',
    owner: 'STO-508',
    status: 'shipped',
    route: '/admin/storage/new',
    page: 'apps/web/app/(shell)/admin/storage/new/page.tsx',
  },
  {
    mockup: 'ui/storage-edit.html',
    owner: 'STO-508',
    status: 'shipped',
    route: '/admin/storage/:id',
    page: 'apps/web/app/(shell)/admin/storage/[id]/page.tsx',
  },
];

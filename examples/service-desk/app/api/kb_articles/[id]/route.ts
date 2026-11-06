import kb_article from '@/resources/kb_article';
import { resourceItemRoutes } from '@indx-workspace/app/server';
export const { GET, PATCH, DELETE } = resourceItemRoutes(kb_article);

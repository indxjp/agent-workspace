import contact from '@/resources/contact';
import { resourceItemRoutes } from '@indx-workspace/app/server';
export const { GET, PATCH, DELETE } = resourceItemRoutes(contact);

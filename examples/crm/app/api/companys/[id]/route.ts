import company from '@/resources/company';
import { resourceItemRoutes } from '@indx-workspace/app/server';
export const { GET, PATCH, DELETE } = resourceItemRoutes(company);

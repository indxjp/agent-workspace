import { readDeclarationFiles } from './inventory-support.js';
import type { RouteDeclaration } from './inventory-support.js';
import { trackedRouteFiles, routeSurface } from './route-files.js';
import { ROUTE_DECLARATIONS, expectedRoutes } from './route-declaration-reader.js';

export const routeFiles = trackedRouteFiles();

export const actual = routeSurface(routeFiles);

export const declarationFiles = readDeclarationFiles(ROUTE_DECLARATIONS, 'routes');

export const EXPECTED_ROUTES: readonly RouteDeclaration[] = expectedRoutes();

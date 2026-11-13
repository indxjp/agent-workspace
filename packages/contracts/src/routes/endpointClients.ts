import type { ApiRoute } from './definition.js';
import { created, json, ok } from './definition.js';
export const endpointClientsRoutes: readonly ApiRoute[] = [
  // ADR-0134 — endpoint clients and their endpoint-scoped API keys
  {
    method: 'GET',
    path: '/api/endpoint-clients',
    operationId: 'endpointClients.list',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'List endpoint clients',
    success: ok(json('EndpointClientListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/endpoint-clients',
    operationId: 'endpointClients.create',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Create an endpoint client for an MCP project or an A2A agent',
    request: json('CreateEndpointClientRequestSchema'),
    success: created(json('EndpointClientResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/endpoint-clients/:id',
    operationId: 'endpointClients.get',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Read one endpoint client',
    success: ok(json('EndpointClientResponseSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/endpoint-clients/:id',
    operationId: 'endpointClients.update',
    tag: 'endpointClients',
    feature: 'core',
    summary: "Change an endpoint client's agents or tool allow-list",
    request: json('UpdateEndpointClientRequestSchema'),
    success: ok(json('EndpointClientResponseSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/endpoint-clients/:id',
    operationId: 'endpointClients.revoke',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Revoke an endpoint client and every key bound to it',
    success: ok(json('EndpointClientResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/endpoint-clients/:id/keys',
    operationId: 'endpointClients.mintKey',
    tag: 'endpointClients',
    feature: 'core',
    summary: 'Mint an endpoint-scoped API key; the secret is returned once',
    request: json('MintEndpointKeyRequestSchema'),
    success: created(json('MintedApiKeyResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/endpoint-clients/:id/secret',
    operationId: 'endpointClients.rotateSecret',
    tag: 'endpointClients',
    feature: 'core',
    summary: "Rotate an endpoint client's OAuth client secret; the secret is returned once",
    success: created(json('RotateEndpointClientSecretResponseSchema')),
  },
];

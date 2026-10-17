import { openapiTool } from '@indx-workspace/sdk/define';

// An API tool: the gateway calls the HTTP API described by `fake-api/openapi.json` for the agent.
// Point `spec` at your own OpenAPI document (a file in this project or an https URL) and add
// `auth: secret('YOUR_TOKEN')` when the API needs a credential.
export default openapiTool({
  name: 'orders',
  spec: 'fake-api/openapi.json',
  allow: ['GET /**'],
});

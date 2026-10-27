import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The maintenance system's write API. `aw push` reads `apis/maintenance.openapi.json` and registers
 * the one operation `allow` names, `logResolution` (`POST /resolutions`); the platform's tool
 * gateway calls the system with `MAINTENANCE_TOKEN`, which never enters the run. `identity` opts the
 * tool in to the signed caller assertion, so the system records the signed-in technician, never a
 * name the model passes, and refuses a machine on a line that technician does not work on.
 * `logResolution` is a write, so it is implicitly `requireApproval`: the run pauses and the record
 * is written only for the call a person approved, with the symptom, cause and action they saw. The
 * machine, line and field checks are the system's own rules and stay in the system.
 */
export const maintenance = openapiTool({
  name: 'maintenance',
  spec: 'apis/maintenance.openapi.json',
  auth: secret('MAINTENANCE_TOKEN'),
  identity: secret('MAINTENANCE_IDENTITY_SECRET'),
  allow: ['operationId:logResolution'],
});

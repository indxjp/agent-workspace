# Vendor fixture provenance

## `gemini-register-a2a-example.json`

- Status: **verbatim** from
  https://docs.cloud.google.com/gemini/enterprise/docs/register-and-manage-an-a2a-agent (page footer
  "Last updated 2026-10-09 UTC"), retrieved 2026-10-11.
- What is verbatim: the body between `-d '` and the closing `'` of the first `curl` example under
  "Register your A2A agent" (the `agents.create` call). The page's raw HTML was fetched, the markup
  of that block was stripped and its HTML entities decoded; the result is byte-for-byte equal to
  this file (570 bytes, trailing newline included). The shell quoting around the body is not part
  of the file.
- Request URL on the page: `https://ENDPOINT_LOCATION-discoveryengine.googleapis.com/v1alpha/projects/PROJECT_ID/locations/LOCATION/collections/default_collection/engines/APP_ID/assistants/default_assistant/agents`.
- The placeholder is **`PROJECT_ID`, not `PROJECT_NUMBER`**, in both the URL and
  `authorizationConfig.agentAuthorization` (`projects/PROJECT_ID/locations/LOCATION/authorizations/AUTH_ID`).
  The page defines it as "the ID of your project." That is what `projectId` in the options means.

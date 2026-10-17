# Ten-step operator walk-through

## 1. Deploy the template.

Surface: `terminal` · Target: `W7-CLI-03 startup`  
Success: The startup summary says the service is ready.  
Timing: Start ____ Stop ____  
Confusion: `C01`

Follow the deployment prompt until it reports that startup is complete.

## 2. Open the browser.

Surface: `browser` · Target: `W7-CLI-03 first-run URL`  
Success: The sign-in or first-run page is visible.  
Timing: Start ____ Stop ____  
Confusion: `C02`

Open the address shown by the startup summary.

## 3. Add the company's model/API connection.

Surface: `screen` · Target: `/admin/models/new`  
Success: The new connection appears in Models with its provider and verification state.  
Timing: Start ____ Stop ____  
Confusion: `C03`

Open Models, choose Add provider, enter the supplied connection details, and save.

## 4. Upload files.

Surface: `screen` · Target: `/files`  
Success: The chosen file appears with its name and size.  
Timing: Start ____ Stop ____  
Confusion: `C04`

Open Files, choose Upload, select the supplied sample, and finish the upload.

## 5. Add or select Skills.

Surface: `screen` · Target: `/skills`  
Success: The selected skill is shown as available.  
Timing: Start ____ Stop ____  
Confusion: `C05`

Open Skills and add or select the supplied skill.

## 6. Add MCP connectors.

Surface: `screen` · Target: `/connectors`  
Success: The connector appears with a visible connection-test result.  
Timing: Start ____ Stop ____  
Confusion: `C06`

Open Connectors, add the supplied connector, and use Test connection.

## 7. Select a sandbox.

Surface: `screen` · Target: `/admin/runtimes`  
Success: The selected runtime shows its capability and verification badges.  
Timing: Start ____ Stop ____  
Confusion: `C07`

Open Runtimes and select an available sandbox.

## 8. Configure basic permissions.

Surface: `screen` · Target: `/agents/new`  
Success: The agent summary shows the selected permission set.  
Timing: Start ____ Stop ____  
Confusion: `C08`

In the new-agent flow, choose the supplied basic permission set.

## 9. Click "Deploy Agent."

Surface: `screen` · Target: `/agents/new`  
Success: The new agent appears in Agents without an error banner.  
Timing: Start ____ Stop ____  
Confusion: `C09`

Review the summary and choose Deploy Agent.

## 10. Start using the agent.

Surface: `screen` · Target: `/`  
Success: A response or a specific credential-bound error streams into the conversation.  
Timing: Start ____ Stop ____  
Confusion: `C10`

Select the new agent, send the supplied message, and watch the result.

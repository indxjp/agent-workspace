/**
 * Which workspace may be served as a demo template. A template is found by its slug
 * (`demo-template-<entry>`). That prefix is reserved (`POST /api/workspaces` refuses it, see
 * `isDemoTemplateWorkspaceSlug`), and this check is the second guard behind it. A workspace is a template of this deployment only when every one of
 * its members is a system account of the deployment: an address in {@link DEMO_TEMPLATE_OWNER_DOMAIN}.
 *
 * That domain is reserved by RFC 6761 (`.invalid` never resolves), so no mail reaches it and the
 * identity provider cannot assert it for a person. The deployment's seeding step
 * (`PUT /api/demo/templates/{entry}`, `seed.ts`) creates the template with such an account as its
 * only member; a workspace with a member outside the domain is not served.
 */
import type { DirectoryRoot } from '../../identity';

/** The reserved domain of the deployment's own template-owner accounts. */
export const DEMO_TEMPLATE_OWNER_DOMAIN = 'demo-templates.invalid';

/** Whether `email` is a template-owner account. */
export function isTemplateOwnerEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${DEMO_TEMPLATE_OWNER_DOMAIN}`);
}

/**
 * Whether the workspace is a template the deployment made: it has members, and all of them are
 * template-owner accounts.
 */
export async function isDeploymentTemplate(
  directory: Pick<DirectoryRoot, 'forWorkspace'>,
  workspaceId: string,
): Promise<boolean> {
  const members = await directory.forWorkspace(workspaceId).listMemberships();
  return members.length > 0 && members.every((member) => isTemplateOwnerEmail(member.email));
}

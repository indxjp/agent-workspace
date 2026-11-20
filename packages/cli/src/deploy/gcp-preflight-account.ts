/** The checks of the person's Google Cloud account and project: sign-in, project, billing and APIs. */
import {
  ACCOUNT_SIGN_IN,
  check,
  enableCommand,
  type Gcloud,
  type GcpPreflightCheck,
} from './gcp-preflight-check.ts';
import { REQUIRED_GCP_APIS } from './gcp-preflight-permissions.ts';

const SIGN_IN = 'gcloud auth application-default login';

/**
 * Terraform uses the Application Default Credentials; every gcloud command here (and the state
 * bucket's) uses gcloud's own account. A laptop needs both logins, so each has its own check.
 */
export async function checkSignIn(
  gcloud: Gcloud,
): Promise<{ readonly checks: readonly GcpPreflightCheck[]; readonly accountSignedIn: boolean }> {
  const adc = await gcloud(['auth', 'application-default', 'print-access-token']);
  const account = await gcloud(['auth', 'print-access-token']);
  return {
    accountSignedIn: account.ok,
    checks: [
      adc.ok
        ? check('sign-in', 'You are signed in to Google Cloud', 'ok')
        : check('sign-in', 'You are not signed in to Google Cloud', 'fail', SIGN_IN),
      account.ok
        ? check('gcloud-account', 'The gcloud command line has an active account', 'ok')
        : check(
            'gcloud-account',
            'The gcloud command line has no active account',
            'fail',
            ACCOUNT_SIGN_IN,
          ),
    ],
  };
}

export async function checkProject(
  gcloud: Gcloud,
  project: string,
  accountSignedIn: boolean,
): Promise<{ readonly check: GcpPreflightCheck; readonly number: string | undefined }> {
  const result = await gcloud(['projects', 'describe', project, '--format=value(projectNumber)']);
  const number = result.ok ? result.stdout.trim() : '';
  if (number === '' && !accountSignedIn) {
    return {
      number: undefined,
      check: check(
        'project',
        `Could not look up your Google Cloud project ${project} because gcloud has no active account`,
        'fail',
        ACCOUNT_SIGN_IN,
      ),
    };
  }
  return number === ''
    ? {
        number: undefined,
        check: check(
          'project',
          `Your Google Cloud project ${project} was not found or is not visible to you`,
          'fail',
          `gcloud projects create ${project}`,
        ),
      }
    : {
        number,
        check: check(
          'project',
          `Your Google Cloud project ${project} exists (number ${number})`,
          'ok',
        ),
      };
}

export async function checkBilling(gcloud: Gcloud, project: string): Promise<GcpPreflightCheck> {
  const result = await gcloud([
    'billing',
    'projects',
    'describe',
    project,
    '--format=value(billingEnabled)',
  ]);
  const answer = result.ok ? result.stdout.trim() : undefined;
  if (answer === 'True') {
    return check('billing', 'Billing is enabled on your Google Cloud project', 'ok');
  }
  if (answer === 'False') {
    return check(
      'billing',
      'Billing is not enabled on your Google Cloud project',
      'fail',
      `https://console.cloud.google.com/billing/linkedaccount?project=${project}`,
    );
  }
  return check('billing', 'Could not check whether billing is enabled', 'warn');
}

export async function checkApis(
  gcloud: Gcloud,
  project: string,
): Promise<{ readonly check: GcpPreflightCheck; readonly missing: readonly string[] }> {
  const result = await gcloud([
    'services',
    'list',
    '--enabled',
    '--project',
    project,
    '--format=value(config.name)',
  ]);
  if (!result.ok) {
    return {
      missing: [],
      check: check(
        'apis',
        'Could not list the enabled Google Cloud APIs',
        'warn',
        `gcloud services list --enabled --project ${project}`,
      ),
    };
  }
  const enabled = new Set(result.stdout.split('\n').map((line) => line.trim()));
  const missing = REQUIRED_GCP_APIS.filter((api) => !enabled.has(api));
  if (missing.length === 0) {
    return {
      missing,
      check: check('apis', 'Every Google Cloud API the deploy needs is enabled', 'ok'),
    };
  }
  return {
    missing,
    check: check(
      'apis',
      `${String(missing.length)} Google Cloud API(s) still need enabling: ${missing.join(', ')}`,
      'warn',
      enableCommand(missing, project),
    ),
  };
}

# Runbook: the Google Cloud Run install

For the person who runs a deployment made by `aw deploy production` with a `gcp` block (see
[Google Cloud Run](../deploy/gcp-cloudrun.md)). Each section is a task with commands to paste.

Throughout, `<name>` is the project name cut to 19 characters (the prefix of every resource),
`<project>` is your Google Cloud project id and `<region>` is `gcp.region`. The services are
`<name>-web`, `<name>-gateway` and `<name>-runner-mgr`.

## Upgrade

Install the newer CLI, then run the same command you deployed with:

```sh
npm install --global @indx-workspace/cli@latest
aw deploy production --yes
aw deploy status production
```

The new CLI carries the new release images and the new Terraform module; `aw deploy` copies the
images by digest and applies the difference. Migrations run in the web start command, before the
server starts. If a migration fails, the new web revision never becomes ready and Cloud Run keeps
sending traffic to the previous revision; read the failure with
`gcloud run services logs read <name>-web --region <region> --project <project> --limit 50`, fix the
cause and run `aw deploy production --yes` again.

`aw deploy status production` shows the versions in the state, whether each service's latest
revision is ready, the data protection and whether a plan has changes (see
[Alerts and dashboard](#alerts-and-dashboard) for what to watch afterwards).

## Roll back to the previous revision

List the revisions of a service, newest first, and send all traffic to the one you want:

```sh
gcloud run revisions list --service <name>-web --region <region> --project <project>
gcloud run services update-traffic <name>-web --to-revisions=<previous-revision>=100 \
  --region <region> --project <project>
```

The same two commands work for `<name>-gateway` and `<name>-runner-mgr`. A rollback moves traffic
only; it does not undo a database migration, so a revision older than the schema may not run. The
next `aw deploy production --yes` restores the revision Terraform manages (the latest one), so
treat a rollback as a stop-gap until you have fixed forward or pinned an older CLI.

## Restore Cloud SQL

The instance `<name>-pg` keeps 14 automatic backups and point-in-time recovery from 7 days of
transaction logs. The module owns the instance and the `database-url` secret that points at it, so
the supported way back is a restore into the same instance. **This overwrites everything in the
database with the state of the backup or the chosen time, and stops the instance while it runs.**
Check first which data you would lose.

From a backup:

```sh
gcloud sql backups list --instance <name>-pg --project <project>
gcloud sql backups restore <backup-id> --restore-instance <name>-pg --project <project>
```

To look at an earlier state without touching the live database, clone to a point in time. The clone
is a separate instance that the module does not manage; read from it (export what you need, then
import it into `<name>-pg`) and delete it when done:

```sh
gcloud sql instances clone <name>-pg <name>-pg-restore \
  --point-in-time 2026-01-31T09:30:00Z --project <project>
gcloud sql instances delete <name>-pg-restore --project <project>
```

`--point-in-time` is an RFC 3339 time in UTC, inside the 7-day window. Pointing the services at a
clone is not supported, because the connection secret belongs to the module and the next deploy
would put it back. After a restore into `<name>-pg`, run `aw deploy status production`.

## Rotate the master key and the KMS key

Secret Manager encrypts the application master key under the Cloud KMS key `master-key-cmek` in the
key ring `<name>-secrets`. Google Cloud rotates that key every 90 days on its own
(`rotation_period` is `7776000s`). To rotate it now:

```sh
gcloud kms keys versions create --key master-key-cmek --keyring <name>-secrets \
  --location <region> --project <project> --primary
```

Rotating the primary KMS version changes the wrapping key for new secret versions without changing
the application's 32-byte plaintext or its persisted fingerprint (ADR-0059). The application master
key itself is therefore not rotated by KMS rotation. Do not destroy old key versions while a secret
version still depends on them.

## Rotate the single sign-on client secret

Applies when you set `gcp.oidc`. Add a new version of the secret:

```sh
printf '%s' "$NEW_SECRET" | gcloud secrets versions add <name>-oidc-client-secret \
  --data-file=- --project <project>
```

The web service reads this one secret at the version `latest`, while every other secret is pinned
to the version the module wrote. Cloud Run resolves `latest` when an instance starts, so running
instances keep the old value until they are replaced. A plain `aw deploy production --yes` on an
unchanged project makes no new revision, so it does not replace them. To start a new revision now,
change something harmless on the service and let the next deploy put it back:

```sh
gcloud run services update <name>-web --update-labels rotated=$(date +%Y%m%d) \
  --region <region> --project <project>
```

`aw deploy production --yes` asks for the client secret again only when the issuer or client id in
`agent-workspace.yaml` changed. Disable the old secret version once the new revision serves:
`gcloud secrets versions disable <version> --secret <name>-oidc-client-secret --project <project>`.

Every other secret is pinned to the version the module wrote, so a version added by hand is not read
until the module itself writes a new one.

## Reap leaked sandbox services

Each sandbox is a Cloud Run service named `rt-<id>`, deleted when its session ends. A crash can
leave one behind, and it costs money while it exists. List every sandbox service in the project with
the service account it runs as:

```sh
gcloud run services list --project <project> \
  --filter='metadata.labels.agent-workspace-runtime=cloud-run-service' \
  --format='value(metadata.name,spec.template.spec.serviceAccountName)'
```

Keep the ones that belong to this install: their service account is
`<name>-runtime@<project>.iam.gserviceaccount.com`. Another install in the same project uses its
own prefix. Check that no running session needs a service before you delete it:

```sh
gcloud run services delete rt-<id> --region <region> --project <project> --quiet
```

The alert "live sandboxes above N" is the signal (20 for `small`, 100 for `standard`). The count
covers every `rt-` service in the project, not only this install's.

## Recreate a deleted service

The runner manager holds `roles/run.developer` so it can create and delete sandboxes. An IAM
condition limits what it can create to services named `rt-`, but Cloud Run does not evaluate the
condition on delete: the runner manager can delete `<name>-web` or `<name>-gateway`, for example if
it is compromised. The data in Cloud SQL and the buckets is not reachable through this role. If a
service is gone, run the same deploy again; it creates the missing service from the state:

```sh
aw deploy production --yes
aw deploy status production
```

## Set a budget

Nothing in the deployment caps spend. Create a Cloud Billing budget with alerts yourself:

```sh
gcloud billing budgets create --billing-account <billing-account-id> \
  --display-name "<name> monthly" --budget-amount 500USD \
  --filter-projects projects/<project> \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0
```

A budget alerts; it does not stop spending. The stack costs money even when nobody uses it:
a shared-core Cloud SQL instance (`small`; `standard` is larger and highly available), one warm web
instance, and the gateway's internal load balancer forwarding rule, billed at list price (about
US$0.025 an hour) while the stack exists. Check
[Google's load balancing pricing](https://cloud.google.com/vpc/network-pricing#lb) and the
[Cloud Run](https://cloud.google.com/run/pricing) and
[Cloud SQL](https://cloud.google.com/sql/pricing) pages for your region. Model usage is billed by
Vertex AI on top.

## Alerts and dashboard

Four log-based metrics and one dashboard named `<name>` (Monitoring, Dashboards) always exist. Set
`gcp.alertsEmail` to add an email notification channel, one alert policy per signal below and an
uptime check of `/api/readyz` on the web app (there is none with `iap: true`, because IAP answers an
unauthenticated probe with a redirect).

| Alert                       | It means                                                       | First check                                                                       |
| --------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| web 5xx responses           | The web app answered 5 or more server errors in 5 minutes      | `gcloud run services logs read <name>-web --region <region> --project <project>`  |
| gateway 5xx responses       | The model gateway answered server errors                       | The same for `<name>-gateway`; then check the revision with `aw deploy status`    |
| gateway upstream errors     | The model provider answered 429 or 5xx, or a request failed    | The provider quota (Vertex AI quota page) and the gateway logs                    |
| runner manager failures     | The manager logged failed requests: sandboxes may not start    | Logs of `<name>-runner-mgr`; sandbox limits and the runtime image                 |
| Cloud SQL CPU above 90%     | The database is saturated for 15 minutes                       | Cloud SQL Query insights; consider `size: standard`                               |
| Cloud SQL disk above 85%    | The disk is nearly full                                        | Table sizes; run `gcloud sql instances describe <name>-pg`                        |
| live sandboxes above N      | More `rt-` services than the size preset expects, project-wide | [Reap leaked sandbox services](#reap-leaked-sandbox-services)                     |
| web readiness probe failing | `/api/readyz` fails from outside                               | `aw deploy status production`, then the web logs; the database may be unreachable |

`aw deploy status production` is the quickest overall check: it exits 0 when every service is ready
and nothing has drifted, and 3 when Terraform would change something.

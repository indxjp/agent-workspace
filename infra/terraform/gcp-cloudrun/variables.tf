variable "project_id" {
  description = "Existing GCP project in which the stack is created."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a valid GCP project id."
  }
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "name" {
  description = "Short lowercase resource prefix. Kept distinct from any other stack sharing this project."
  type        = string
  default     = "agent-workspace"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}[a-z0-9]$", var.name))
    error_message = "name must be a short lowercase resource prefix."
  }
  validation {
    # rt- names the runner manager's sandboxes, which its create/delete grant matches by name and
    # its invoke grant (rt-) and the gateway's (rt-tool-) by host: a stack named rt-... would put
    # web, the gateway and the apps inside those grants.
    condition     = !startswith(var.name, "rt-")
    error_message = "name must not start with rt-, the prefix of the runner manager's sandbox services."
  }
}

variable "bootstrap_admin_email" {
  description = "The first workspace owner's sign-in identity (spec §37 BOOTSTRAP_ADMIN)."
  type        = string
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.bootstrap_admin_email))
    error_message = "bootstrap_admin_email must be a valid email address."
  }
}

variable "images" {
  description = "The images this stack runs, pinned by immutable OCI digest. See docs/deploy/gcp-cloudrun.md for how each is built. egress_proxy is needed only with sandbox_internet and tool_host only for code-tool sandboxes; both stay empty otherwise."
  type = object({
    web          = string
    gateway      = string
    runner       = string
    runtime      = string
    egress_proxy = optional(string, "")
    tool_host    = optional(string, "")
  })
  validation {
    condition = alltrue([
      for name, reference in var.images :
      (contains(["egress_proxy", "tool_host"], name) && reference == "") ||
      (can(regex("@sha256:[0-9a-f]{64}$", reference)) && !endswith(reference, "sha256:0000000000000000000000000000000000000000000000000000000000000000"))
    ])
    error_message = "all images must be non-placeholder sha256 digest references (egress_proxy and tool_host may be empty); mutable tags are refused."
  }
}

variable "sandbox_internet" {
  description = "gcp.sandboxInternet: give sandboxes internet through an egress proxy VM (Cloud NAT, no external IP) that enforces each run's allowlist. Needs images.egress_proxy and a module-created network. False (the default) creates nothing and sandboxes keep no route out but the gateway."
  type        = bool
  default     = false
}

variable "deployment_policy" {
  description = "The project's policy ceiling as JSON (web's AW_DEPLOYMENT_POLICY), rendered by aw deploy from agent-workspace.yaml. Empty means no ceiling."
  type        = string
  default     = ""
  validation {
    condition     = var.deployment_policy == "" || can(jsondecode(var.deployment_policy))
    error_message = "deployment_policy must be empty or JSON."
  }
}

variable "deployment_features" {
  description = "The project's features as comma-separated ids (web's AW_DEPLOYMENT_FEATURES, ADR-0160 D5), rendered by aw deploy from agent-workspace.yaml. Empty installs every feature."
  type        = string
  default     = ""
  validation {
    condition     = can(regex("^([a-z]+(,[a-z]+)*)?$", var.deployment_features))
    error_message = "deployment_features must be empty or comma-separated lower-case feature ids."
  }
}

variable "public_url" {
  description = "web's AW_PUBLIC_URL: the https origin (no path) A2A agent cards (ADR-0135) and the OAuth issuer use, rendered by aw deploy. Empty leaves it unset."
  type        = string
  default     = ""
  validation {
    condition     = var.public_url == "" || can(regex("^https://[^/?#@]+$", var.public_url))
    error_message = "public_url must be empty or an https origin with no path, query or credentials."
  }
}

variable "storage_signed_upload_max_bytes" {
  description = "web's AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES: the largest signed upload in bytes. Null leaves it unset and the server default applies."
  type        = number
  default     = null
  validation {
    # A conditional, not ||: Terraform before 1.12 evaluates both sides of ||, and floor(null) fails.
    condition     = var.storage_signed_upload_max_bytes == null ? true : (var.storage_signed_upload_max_bytes >= 1 && floor(var.storage_signed_upload_max_bytes) == var.storage_signed_upload_max_bytes)
    error_message = "storage_signed_upload_max_bytes must be null or a whole number of bytes of at least 1."
  }
}

variable "size" {
  description = "Deployment size. small = shared-core Cloud SQL, zonal, min 0 instances on gateway and runner manager, web min 1. standard = db-custom-2-7680, REGIONAL high availability, min 1 instance everywhere."
  type        = string
  default     = "small"
  validation {
    condition     = contains(["small", "standard"], var.size)
    error_message = "size must be \"small\" or \"standard\"."
  }
}

variable "data_protection" {
  description = "Protects Cloud SQL, both buckets and the three long-lived Cloud Run services from deletion. False only for disposable test stacks; aw deploy destroy needs it false, deployed first."
  type        = bool
  default     = true
}

variable "web_max_instance_count" {
  type    = number
  default = 3
}

variable "runtime_timeout_seconds" {
  description = "Per-session Cloud Run runtime service request timeout ceiling (also this driver's maxSessionSeconds)."
  type        = number
  default     = 3600
}

variable "gateway_pricing_json" {
  description = "Immutable versioned provider:model price catalogue consumed by the gateway (spec §37 GATEWAY_PRICING_JSON)."
  type        = string
  default     = <<-JSON
    {"version":"2026-09-10","models":{
      "anthropic:claude-sonnet-5":{"inputUsdPerMillion":"2.00","outputUsdPerMillion":"10.00","cacheReadUsdPerMillion":"0.20","cacheCreationUsdPerMillion":"2.50"},
      "anthropic:claude-opus-5":{"inputUsdPerMillion":"5.00","outputUsdPerMillion":"25.00","cacheReadUsdPerMillion":"0.50","cacheCreationUsdPerMillion":"6.25"},
      "vertex:claude-opus-5-5":{"inputUsdPerMillion":"5.00","outputUsdPerMillion":"25.00","cacheReadUsdPerMillion":"0.50","cacheCreationUsdPerMillion":"6.25"},
      "vertex:claude-sonnet-5-5":{"inputUsdPerMillion":"2.00","outputUsdPerMillion":"10.00","cacheReadUsdPerMillion":"0.20","cacheCreationUsdPerMillion":"2.50"},
      "vertex:claude-haiku-5-5":{"inputUsdPerMillion":"1.00","outputUsdPerMillion":"5.00","cacheReadUsdPerMillion":"0.10","cacheCreationUsdPerMillion":"1.25"},
      "vertex:claude-fable-5-1":{"inputUsdPerMillion":"10.00","outputUsdPerMillion":"50.00","cacheReadUsdPerMillion":"1.00","cacheCreationUsdPerMillion":"12.50"}
    }}
  JSON
  validation {
    condition = (
      can(jsondecode(var.gateway_pricing_json)) &&
      can(jsondecode(var.gateway_pricing_json).version) &&
      can(jsondecode(var.gateway_pricing_json).models)
    )
    error_message = "gateway_pricing_json must be JSON with version and models fields."
  }
}

variable "network" {
  description = "An existing VPC network to adopt as a full id (projects/PROJECT/global/networks/NAME), set together with subnetwork. Empty makes the module create its own network, subnets, Private Services Access, the private run.app DNS zone and the proxy-only subnet. An adopted network must already have Private Services Access (for Cloud SQL private IP), a private run.app zone resolving to 199.36.153.8-11 and an active proxy-only subnet (purpose REGIONAL_MANAGED_PROXY) in the region, for the gateway's internal load balancer; the module creates none of them."
  type        = string
  default     = ""
  validation {
    condition     = var.network == "" || can(regex("^projects/[^/]+/global/networks/[^/]+$", var.network))
    error_message = "network must be empty or a full network id such as projects/PROJECT/global/networks/NAME."
  }
}

variable "subnetwork" {
  description = "The subnetwork of the adopted network that the services' Direct VPC egress uses, set together with network. Needs Private Google Access and room for roughly twice the services' instance count. Give the full id, such as projects/PROJECT/regions/REGION/subnetworks/NAME."
  type        = string
  default     = ""
  validation {
    condition     = var.subnetwork == "" || can(regex("^projects/[^/]+/regions/[^/]+/subnetworks/[^/]+$", var.subnetwork))
    error_message = "subnetwork must be empty or a full subnetwork id such as projects/PROJECT/regions/REGION/subnetworks/NAME."
  }
}

variable "oidc_issuer" {
  description = "Single sign-on: the OpenID Connect issuer URL (https), set together with oidc_client_id. Empty leaves single sign-on off and creates no secret. The client secret goes into the oidc_client_secret_id secret as a version, added by aw deploy through gcloud."
  type        = string
  default     = ""
  validation {
    condition     = var.oidc_issuer == "" || startswith(var.oidc_issuer, "https://")
    error_message = "oidc_issuer must be empty or start with https://."
  }
}

variable "oidc_client_id" {
  description = "Single sign-on: the OpenID Connect client id, set together with oidc_issuer."
  type        = string
  default     = ""
}

variable "domain" {
  description = "A custom domain for the web control plane. Empty (the default) keeps the private-by-default run.app URL. Set it to put web behind an external HTTPS load balancer with a Google-managed certificate and an HTTP to HTTPS redirect; point the domain's A record at the load_balancer_ip output."
  type        = string
  default     = ""
  validation {
    condition     = var.domain == "" || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain))
    error_message = "domain must be empty or a lower-case hostname such as app.example.com."
  }
}

variable "armor" {
  description = "Attach a Cloud Armor policy (OWASP preconfigured rules) to the load balancer. Requires domain."
  type        = bool
  default     = false
}

variable "iap" {
  description = "Put Identity-Aware Proxy in front of web, so only IAP-authorised users reach it. Requires domain."
  type        = bool
  default     = false
}

variable "vertex_location" {
  type        = string
  default     = "global"
  description = "Where Claude on Vertex AI runs: global (default), us or eu. Regional endpoints (us, eu) cost 10 % more than global."
  validation {
    condition     = contains(["global", "us", "eu"], var.vertex_location)
    error_message = "vertex_location must be global, us or eu."
  }
}

variable "alerts_email" {
  description = "Where alert notifications go. Empty creates no notification channel, no alert policy and no uptime check; the log-based metrics and the dashboard are always created."
  type        = string
  default     = ""
  validation {
    condition     = var.alerts_email == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alerts_email))
    error_message = "alerts_email must be empty or a valid email address."
  }
}

variable "apps" {
  description = "The project's apps, rendered by aw deploy from agent-workspace.yaml: name => image (a digest reference), url (the https address people use) and role_sql (the SQL that creates the app's database role), plus optionally workspace_id (the uuid of the workspace the app acts in), connector_id (the id the platform reaches the app through) and api_key_secret (the id of a Secret Manager secret in this project that holds the app's Admin API key; never the key itself). A set workspace_id or connector_id becomes AW_WORKSPACE_ID or AW_APP_CONNECTOR_ID; api_key_secret becomes AW_APP_API_KEY, read by the app's own service account from that one secret. An optional sign_in (needs oidc_issuer) holds oidc_client_id (the app's own client at oidc_issuer), oidc_client_secret (the id of the Secret Manager secret holding that client's secret), app_client_id (the app's app-backend endpoint client) and app_client_secret (the id of the Secret Manager secret holding that client's secret); it becomes AW_OIDC_ISSUER_URL, AW_OIDC_CLIENT_ID, AW_OIDC_CLIENT_SECRET, AW_APP_CLIENT_ID and AW_APP_CLIENT_SECRET, the two secrets read by the app's own service account. Each app gets a Cloud Run service, a database role, two secrets and a service account. Empty (the default) creates none of it."
  type = map(object({
    image          = string
    url            = string
    role_sql       = string
    workspace_id   = optional(string)
    connector_id   = optional(string)
    api_key_secret = optional(string)
    sign_in = optional(object({
      oidc_client_id     = string
      oidc_client_secret = string
      app_client_id      = string
      app_client_secret  = string
    }))
  }))
  default = {}
  validation {
    condition = alltrue([
      for _, app in var.apps :
      can(regex("@sha256:[0-9a-f]{64}$", app.image)) && !endswith(app.image, "sha256:0000000000000000000000000000000000000000000000000000000000000000")
    ])
    error_message = "every app image must be a non-placeholder sha256 digest reference; mutable tags are refused."
  }
  validation {
    # The CLI's app name rule (NAME_KEY_PATTERN), capped at 25 so ${var.name}-app-<name> fits a
    # Cloud Run service name. A trailing hyphen would end the service and Compute resource names.
    condition     = alltrue([for name, _ in var.apps : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", name)) && length(name) <= 25])
    error_message = "app names must be lower-case kebab (^[a-z0-9]([a-z0-9-]*[a-z0-9])?$) and at most 25 characters."
  }
  validation {
    condition     = alltrue([for _, app in var.apps : can(regex("^https://[^/:?#@]+(/.*)?$", app.url))])
    error_message = "every app url must be an https address."
  }
  validation {
    condition     = alltrue([for _, app in var.apps : app.workspace_id == null || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", app.workspace_id))])
    error_message = "an app's workspace_id must be a workspace uuid."
  }
  validation {
    condition     = alltrue([for _, app in var.apps : app.connector_id == null || can(regex("^[A-Za-z0-9_.:-]{1,256}$", app.connector_id))])
    error_message = "an app's connector_id may hold letters, digits and _ . : - only, up to 256 characters."
  }
  validation {
    condition     = alltrue([for _, app in var.apps : app.api_key_secret == null || can(regex("^[A-Za-z0-9_-]{1,255}$", app.api_key_secret))])
    error_message = "an app's api_key_secret must be a Secret Manager secret id (letters, digits, - and _), never the key itself."
  }
  validation {
    condition = alltrue([
      for _, app in var.apps : app.sign_in == null ? true : (
        can(regex("^[A-Za-z0-9_-]{1,255}$", app.sign_in.oidc_client_secret)) && can(regex("^[A-Za-z0-9_-]{1,255}$", app.sign_in.app_client_secret))
      )
    ])
    error_message = "an app's sign_in oidc_client_secret and app_client_secret must be Secret Manager secret ids (letters, digits, - and _), never the secrets themselves."
  }
  validation {
    condition = alltrue([
      for _, app in var.apps : app.sign_in == null ? true : (
        length(app.sign_in.oidc_client_id) >= 1 && length(app.sign_in.oidc_client_id) <= 255 && length(app.sign_in.app_client_id) >= 1 && length(app.sign_in.app_client_id) <= 255
      )
    ])
    error_message = "an app's sign_in oidc_client_id and app_client_id must be 1-255 characters."
  }
}

variable "web_settings" {
  description = "gcp.settings: plain environment variables on the web service, name to value, 1:1 from agent-workspace.yaml (the CLI restricts the names to its closed list). Empty (the default) adds none. A name the module itself sets on web is refused."
  type        = map(string)
  default     = {}
  validation {
    condition     = length(setintersection(toset(keys(var.web_settings)), local.web_reserved_env)) == 0
    error_message = "web_settings may not name an environment variable the module sets on web itself."
  }
}

variable "web_secret_settings" {
  description = "gcp.secretSettings: environment variables on the web service whose value is a Secret Manager secret, environment name to the id of a secret in this project that a person created (never a value). Web reads version latest, and its service account gets roles/secretmanager.secretAccessor on exactly those secrets. Empty (the default) adds none."
  type        = map(string)
  default     = {}
  validation {
    condition     = length(setintersection(toset(keys(var.web_secret_settings)), local.web_reserved_env)) == 0
    error_message = "web_secret_settings may not name an environment variable the module sets on web itself."
  }
  validation {
    condition     = alltrue([for id in values(var.web_secret_settings) : can(regex("^[A-Za-z0-9_-]{1,255}$", id))])
    error_message = "web_secret_settings values must be Secret Manager secret ids (letters, digits, - and _)."
  }
}

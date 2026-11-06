# The private network the services and Cloud SQL run in. Empty `network` and `subnetwork` make the
# module create it; setting both adopts one the operator already runs, and then none of the
# resources below exist (the adopted network must already have Private Services Access, a private
# run.app zone and an active proxy-only subnet in the region).

locals {
  create_network     = var.network == "" && var.subnetwork == ""
  network_id         = local.create_network ? google_compute_network.main[0].id : var.network
  services_subnet_id = local.create_network ? google_compute_subnetwork.services[0].id : var.subnetwork
  # An adopted network has a single subnetwork input, so sandboxes share it with the services there;
  # the tag-scoped firewall below still isolates them.
  sandbox_subnet_id = local.create_network ? google_compute_subnetwork.sandbox[0].id : var.subnetwork
  # The project a firewall rule lives in: the host project of an adopted Shared VPC network.
  network_project = try(regex("^projects/([^/]+)/", local.network_id)[0], var.project_id)
  run_app_ips     = ["199.36.153.8", "199.36.153.9", "199.36.153.10", "199.36.153.11"]
}

# Cross-variable checks: variable validation cannot read another variable before Terraform 1.9.
resource "terraform_data" "input_checks" {
  lifecycle {
    precondition {
      condition     = (var.network == "") == (var.subnetwork == "")
      error_message = "network and subnetwork must be set together, or both left empty."
    }
    precondition {
      condition     = (var.oidc_issuer == "") == (var.oidc_client_id == "")
      error_message = "oidc_issuer and oidc_client_id must be set together, or both left empty."
    }
    precondition {
      condition     = local.runtime_image_in_project
      error_message = "images.runtime must be in an Artifact Registry repository of project_id (<location>-docker.pkg.dev/<project_id>/<repository>/...): the runner manager creates every runtime service from it, and the module grants it read access only there. aw deploy copies an image from outside Artifact Registry into the stack's own repository; copy one from another project's repository into this project first."
    }
  }
}

resource "google_compute_network" "main" {
  count                   = local.create_network ? 1 : 0
  name                    = "${var.name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.required]
}

resource "google_compute_subnetwork" "services" {
  count                    = local.create_network ? 1 : 0
  name                     = "${var.name}-services"
  region                   = var.region
  network                  = google_compute_network.main[0].id
  ip_cidr_range            = "10.10.0.0/24"
  private_ip_google_access = true
}

# The subnet the per-session sandbox services run in (RUNTIME_SUBNETWORK). A /22 because Direct VPC egress uses about twice
# as many addresses as there are instances, and keeps them for about 20 minutes after an instance
# stops; the minimum Cloud Run accepts is a /26.
resource "google_compute_subnetwork" "sandbox" {
  count                    = local.create_network ? 1 : 0
  name                     = "${var.name}-sandbox"
  region                   = var.region
  network                  = google_compute_network.main[0].id
  ip_cidr_range            = "10.10.4.0/22"
  private_ip_google_access = true
}

# Private Services Access, the peering Cloud SQL's private IP lives behind.
resource "google_compute_global_address" "psa" {
  count         = local.create_network ? 1 : 0
  name          = "${var.name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main[0].id
}

resource "google_service_networking_connection" "psa" {
  count                   = local.create_network ? 1 : 0
  network                 = google_compute_network.main[0].id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa[0].name]
  # Cloud SQL keeps using the peering for days after the instance is deleted, so a destroy that
  # tried to remove it fails; abandoning it lets the network go with the project's cleanup.
  deletion_policy = "ABANDON"
  depends_on      = [google_project_service.required]
}

# *.run.app resolves to the private Google VIPs (private.googleapis.com) inside the network, so the services reach each
# other (and the runner manager's internal ingress) without leaving it.
resource "google_dns_managed_zone" "run_app" {
  count      = local.create_network ? 1 : 0
  name       = "${var.name}-run-app"
  dns_name   = "run.app."
  visibility = "private"
  private_visibility_config {
    networks {
      network_url = google_compute_network.main[0].id
    }
  }
  depends_on = [google_project_service.required]
}

resource "google_dns_record_set" "run_app_wildcard" {
  count        = local.create_network ? 1 : 0
  managed_zone = google_dns_managed_zone.run_app[0].name
  name         = "*.run.app."
  type         = "A"
  ttl          = 300
  rrdatas      = local.run_app_ips
}

resource "google_dns_record_set" "run_app_apex" {
  count        = local.create_network ? 1 : 0
  managed_zone = google_dns_managed_zone.run_app[0].name
  name         = "run.app."
  type         = "A"
  ttl          = 300
  rrdatas      = local.run_app_ips
}

# ── The gateway's internal address for sandboxes ──────────────────────────────────────────────────
# A regional internal Application Load Balancer in front of the gateway, so a sandbox reaches the
# gateway at one private address of this network instead of through the Google VIP. Behind the VIP
# Google serves every *.run.app service of every project and every Google API, which no firewall can
# narrow to this install's gateway. The gateway's ingress stays internal: Cloud Run counts traffic
# from an internal Application Load Balancer as internal.
#
# Plain HTTP on port 80, inside the VPC: a certificate a sandbox can verify needs a public domain
# (Google-managed) or a private CA the sandbox trusts, and the default stack has neither. The run
# token is still the gate, and it is short-lived and scoped to one run. The proxy reaches Cloud Run
# over Google's own network.

locals {
  # The gateway's service name, shared with the serverless NEG so the load balancer is built while
  # Cloud SQL and the gateway are still being created, not after them.
  gateway_service_name = "${var.name}-gateway"
  gateway_internal_url = "http://${google_compute_address.gateway_internal.address}"
}

# Required once per region and network by every Envoy-based regional load balancer; only one can be
# active. An adopted network must already have one in this region.
resource "google_compute_subnetwork" "proxy_only" {
  count         = local.create_network ? 1 : 0
  name          = "${var.name}-proxy-only"
  region        = var.region
  network       = google_compute_network.main[0].id
  ip_cidr_range = "10.10.8.0/23"
  purpose       = "REGIONAL_MANAGED_PROXY"
  role          = "ACTIVE"
}

resource "google_compute_address" "gateway_internal" {
  name         = "${var.name}-gateway-internal"
  project      = var.project_id
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = local.services_subnet_id
  depends_on   = [google_project_service.required]
}

resource "google_compute_region_network_endpoint_group" "gateway" {
  name                  = "${var.name}-gateway-neg"
  project               = var.project_id
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = local.gateway_service_name
  }
  depends_on = [google_project_service.required]
}

resource "google_compute_region_backend_service" "gateway" {
  name                  = "${var.name}-gateway"
  project               = var.project_id
  region                = var.region
  load_balancing_scheme = "INTERNAL_MANAGED"
  protocol              = "HTTP"
  backend {
    group           = google_compute_region_network_endpoint_group.gateway.id
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1.0
  }
}

resource "google_compute_region_url_map" "gateway" {
  name            = "${var.name}-gateway"
  project         = var.project_id
  region          = var.region
  default_service = google_compute_region_backend_service.gateway.id
}

resource "google_compute_region_target_http_proxy" "gateway" {
  name    = "${var.name}-gateway"
  project = var.project_id
  region  = var.region
  url_map = google_compute_region_url_map.gateway.id
}

resource "google_compute_forwarding_rule" "gateway" {
  name                  = "${var.name}-gateway"
  project               = var.project_id
  region                = var.region
  load_balancing_scheme = "INTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  ip_address            = google_compute_address.gateway_internal.id
  network               = local.network_id
  subnetwork            = local.services_subnet_id
  target                = google_compute_region_target_http_proxy.gateway.id
  depends_on            = [google_compute_subnetwork.proxy_only]
}

# ── Sandbox egress (D-6) ──────────────────────────────────────────────────────────────────────────
# A sandbox (tag aw-sandbox) may reach only the gateway's internal address, over tcp 80. Everything
# else is denied, the Google VIPs included: the web, gateway and runner-manager services still reach
# each other through the private run.app zone and 199.36.153.8/30, but a sandbox does not. Created for
# an adopted network too: it may have NAT, and a `none` sandbox reaching a public host is the security
# stop of this phase. No NAT is created anywhere in this module.
#
# Every rule sits at priority 0, the highest a VPC rule can have, and the catch-all deny covers the
# complement of the gateway's /32 so it never overlaps the allow. At equal priority a deny beats an
# allow, so an egress allow rule on an adopted network cannot override the denies. A hierarchical or
# network firewall policy is evaluated before any VPC rule and can still override them: an adopted
# network must have none that allows egress from instances tagged aw-sandbox (see Limits today in the
# self-host-securely guide).
#
# Every other protocol and port to the gateway's address is denied by sandbox_deny_gateway_other:
# without it they would match no rule and fall through to GCP's implied allow-egress rule.
locals {
  sandbox_allowed_ip = google_compute_address.gateway_internal.address
  sandbox_allowed_n = sum([
    for i, octet in split(".", local.sandbox_allowed_ip) : tonumber(octet) * pow(256, 3 - i)
  ])
  # 0.0.0.0/0 without the gateway's /32: for each prefix length, the sibling of the block that holds
  # the address.
  sandbox_denied_cidrs = [
    for length in range(1, 33) : format(
      "%s/%d",
      cidrhost(
        "0.0.0.0/0",
        (
          floor(local.sandbox_allowed_n / pow(2, 32 - length)) +
          (floor(local.sandbox_allowed_n / pow(2, 32 - length)) % 2 == 0 ? 1 : -1)
        ) * pow(2, 32 - length),
      ),
      length,
    )
  ]
  # private.googleapis.com and restricted.googleapis.com: every *.run.app host and Google API.
  google_vip_cidrs = ["199.36.153.8/30", "199.36.153.4/30"]
}

resource "google_compute_firewall" "sandbox_deny_egress" {
  name               = "${var.name}-sandbox-deny-egress"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = local.sandbox_denied_cidrs
  deny {
    protocol = "all"
  }
  depends_on = [google_project_service.required]
}

# Already inside the catch-all deny; named on its own so no later edit of that list can reopen them.
resource "google_compute_firewall" "sandbox_deny_google_vips" {
  name               = "${var.name}-sandbox-deny-google-vips"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = local.google_vip_cidrs
  deny {
    protocol = "all"
  }
  depends_on = [google_project_service.required]
}

# GCP firewall rules cannot mix address families, so IPv6 has its own deny. A dual-stack adopted
# subnetwork would otherwise leave a `none` sandbox's IPv6 egress open.
resource "google_compute_firewall" "sandbox_deny_egress_ipv6" {
  name               = "${var.name}-sandbox-deny-egress-v6"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = ["::/0"]
  deny {
    protocol = "all"
  }
  depends_on = [google_project_service.required]
}

resource "google_compute_firewall" "sandbox_deny_gateway_other" {
  name               = "${var.name}-sandbox-deny-gateway-other"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = ["${local.sandbox_allowed_ip}/32"]
  deny {
    protocol = "tcp"
    ports    = ["0-79", "81-65535"]
  }
  deny {
    protocol = "udp"
  }
  deny {
    protocol = "icmp"
  }
  deny {
    protocol = "sctp"
  }
  deny {
    protocol = "esp"
  }
  deny {
    protocol = "ah"
  }
  depends_on = [google_project_service.required]
}

resource "google_compute_firewall" "sandbox_allow_gateway" {
  name               = "${var.name}-sandbox-allow-gateway"
  project            = local.network_project
  network            = local.network_id
  direction          = "EGRESS"
  priority           = 0
  target_tags        = ["aw-sandbox"]
  destination_ranges = ["${local.sandbox_allowed_ip}/32"]
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
  depends_on = [google_project_service.required]
}

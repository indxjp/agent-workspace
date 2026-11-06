# A custom domain, only on request: an external HTTPS load balancer in front of web (serverless NEG,
# Google-managed certificate, HTTP to HTTPS redirect), optionally with Cloud Armor and IAP. Every
# resource here is gated on var.domain, so the default stack is unchanged.

locals {
  has_domain = var.domain != ""
}

# Cross-variable checks: variable validation cannot read another variable before Terraform 1.9.
resource "terraform_data" "domain_checks" {
  lifecycle {
    precondition {
      condition     = local.has_domain || (!var.iap && !var.armor)
      error_message = "iap and armor need a load balancer: set domain, or leave both false."
    }
  }
}

resource "google_compute_global_address" "lb" {
  count      = local.has_domain ? 1 : 0
  name       = "${var.name}-lb"
  project    = var.project_id
  depends_on = [google_project_service.required]
}

resource "google_compute_region_network_endpoint_group" "web" {
  count                 = local.has_domain ? 1 : 0
  name                  = "${var.name}-web-neg"
  project               = var.project_id
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.web.name
  }
}

# Cloud Armor, minimal on purpose: the preconfigured OWASP SQL injection rule set, then allow
# everything else. Priority 1000 leaves room for operator rules before it; the default rule is
# always 2147483647.
resource "google_compute_security_policy" "armor" {
  count   = local.has_domain && var.armor ? 1 : 0
  name    = "${var.name}-armor"
  project = var.project_id

  rule {
    action   = "deny(403)"
    priority = 1000
    match {
      expr {
        expression = "evaluatePreconfiguredWaf('sqli-v33-stable', {'sensitivity': 1})"
      }
    }
    description = "OWASP: SQL injection"
  }

  rule {
    action   = "allow"
    priority = 2147483647
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow"
  }
}

resource "google_compute_backend_service" "web" {
  count                 = local.has_domain ? 1 : 0
  name                  = "${var.name}-web"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = var.armor ? google_compute_security_policy.armor[0].id : null

  backend {
    group = google_compute_region_network_endpoint_group.web[0].id
  }

  # IAP sits on the load balancer backend only: the run.app URL stays outside IAP, so the gateway's
  # internal call to web (aw-control) needs no Google ID token.
  dynamic "iap" {
    for_each = local.iap_enabled ? [1] : []
    content {
      enabled = true
    }
  }
}

resource "google_compute_managed_ssl_certificate" "web" {
  count   = local.has_domain ? 1 : 0
  name    = "${var.name}-web"
  project = var.project_id
  managed {
    domains = [var.domain]
  }
}

resource "google_compute_url_map" "web" {
  count           = local.has_domain ? 1 : 0
  name            = "${var.name}-web"
  project         = var.project_id
  default_service = google_compute_backend_service.web[0].id
}

resource "google_compute_target_https_proxy" "web" {
  count            = local.has_domain ? 1 : 0
  name             = "${var.name}-web"
  project          = var.project_id
  url_map          = google_compute_url_map.web[0].id
  ssl_certificates = [google_compute_managed_ssl_certificate.web[0].id]
}

resource "google_compute_global_forwarding_rule" "https" {
  count                 = local.has_domain ? 1 : 0
  name                  = "${var.name}-https"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb[0].id
  port_range            = "443"
  target                = google_compute_target_https_proxy.web[0].id
}

resource "google_compute_url_map" "redirect" {
  count   = local.has_domain ? 1 : 0
  name    = "${var.name}-redirect"
  project = var.project_id
  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  count   = local.has_domain ? 1 : 0
  name    = "${var.name}-redirect"
  project = var.project_id
  url_map = google_compute_url_map.redirect[0].id
}

resource "google_compute_global_forwarding_rule" "http" {
  count                 = local.has_domain ? 1 : 0
  name                  = "${var.name}-http"
  project               = var.project_id
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.lb[0].id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect[0].id
}

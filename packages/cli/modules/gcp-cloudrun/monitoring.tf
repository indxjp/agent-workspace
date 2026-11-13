# Observability: four log-based metrics and one dashboard are always created (free, no
# notification). With alerts_email set the stack also gets an email channel, an alert policy per
# signal and an uptime check.
#
# Nothing else in this module references a resource in this file, and each resource here depends
# only on what it references, so these apply in parallel with Cloud SQL and Cloud Run and add
# nothing to the critical path of the first deploy. Every name and display name starts with
# var.name so a leftover can be found and listed by prefix.
#
# Perpetual-diff care: every value below is written the way the API reads it back. The provider
# compares dashboard_json by value after dropping keys the config leaves out, so one value whose
# type differs (columns 2 against "2") fails the comparison and shows every API-filled default as
# a diff. The dashboard therefore writes the API's canonical form: columns as a string, and on each
# xyChart dataSet the plotType and targetAxis the API fills in. It sets no position (no xPos/yPos).

locals {
  alerts_enabled = var.alerts_email != ""

  # IAP answers an unauthenticated probe with a redirect to Google sign-in, so the check would
  # always fail; there is no uptime check (and no policy on it) when IAP is on.
  uptime_enabled = local.alerts_enabled && !local.iap_enabled

  # The host of the one web origin the web_url output reports.
  web_host = trimprefix(local.web_origin, "https://")

  log_metrics = merge({
    web-5xx = join(" AND ", [
      "resource.type=\"cloud_run_revision\"",
      "resource.labels.service_name=\"${var.name}-web\"",
      "httpRequest.status>=500",
    ])
    gateway-5xx = join(" AND ", [
      "resource.type=\"cloud_run_revision\"",
      "resource.labels.service_name=\"${var.name}-gateway\"",
      "httpRequest.status>=500",
    ])
    # The gateway passes upstream statuses such as 429 through on its model routes
    # (packages/gateway/src/router.ts) and logs "gateway request failed" when it cannot answer.
    gateway-upstream-errors = join(" AND ", [
      "resource.type=\"cloud_run_revision\"",
      "resource.labels.service_name=\"${var.name}-gateway\"",
      "(((httpRequest.requestUrl:\"/v1/messages\" OR httpRequest.requestUrl:\"/v1/responses\" OR httpRequest.requestUrl:\"/v1/chat/completions\") AND (httpRequest.status=429 OR httpRequest.status>=500)) OR jsonPayload.msg=\"gateway request failed\")",
    ])
    # The manager writes this line on stderr (apps/runner/src/manager.ts).
    runner-mgr-failures = join(" AND ", [
      "resource.type=\"cloud_run_revision\"",
      "resource.labels.service_name=\"${var.name}-runner-mgr\"",
      "(textPayload:\"runner manager request failed\" OR httpRequest.status>=500)",
    ])
    }, local.apps_enabled ? {
    # Every app service (apps.tf); absent without apps, so the dashboard and metrics are unchanged.
    apps-5xx = join(" AND ", [
      "resource.type=\"cloud_run_revision\"",
      "resource.labels.service_name=~\"^${var.name}-app-\"",
      "httpRequest.status>=500",
    ])
  } : {})

  cloud_sql_resource = "resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${var.project_id}:${var.name}-pg\""

  # One chart per entry. aligner and reducer are written exactly as the API reads them back.
  dashboard_charts = concat(
    [
      for key, _ in local.log_metrics : {
        title   = "${var.name} ${replace(key, "-", " ")} per second"
        filter  = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.main[key].name}\" AND resource.type=\"cloud_run_revision\""
        aligner = "ALIGN_RATE"
        reducer = "REDUCE_SUM"
      }
    ],
    [
      for service in ["web", "gateway", "runner-mgr"] : {
        title   = "${var.name} ${service} request latency (p99)"
        filter  = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.name}-${service}\""
        aligner = "ALIGN_PERCENTILE_99"
        reducer = "REDUCE_MAX"
      }
    ],
    [
      for service in ["web", "gateway", "runner-mgr"] : {
        title   = "${var.name} ${service} instances"
        filter  = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.name}-${service}\""
        aligner = "ALIGN_MAX"
        reducer = "REDUCE_SUM"
      }
    ],
    [
      {
        title   = "${var.name} Cloud SQL CPU utilization"
        filter  = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND ${local.cloud_sql_resource}"
        aligner = "ALIGN_MEAN"
        reducer = "REDUCE_MAX"
      },
      {
        title   = "${var.name} Cloud SQL disk utilization"
        filter  = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND ${local.cloud_sql_resource}"
        aligner = "ALIGN_MEAN"
        reducer = "REDUCE_MAX"
      },
      {
        title   = "${var.name} live sandbox instances"
        filter  = local.sandbox_filter
        aligner = "ALIGN_MAX"
        reducer = "REDUCE_SUM"
      },
    ],
  )

  sandbox_filter = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=starts_with(\"rt-\")"

  # One alert policy per signal. group_by is empty unless a reducer is set.
  alert_policies = merge(
    {
      for key, spec in merge({
        web-5xx                 = { title = "web 5xx responses", threshold = 5, duration = "300s" }
        gateway-5xx             = { title = "gateway 5xx responses", threshold = 5, duration = "300s" }
        gateway-upstream-errors = { title = "gateway upstream errors", threshold = 10, duration = "300s" }
        runner-mgr-failures     = { title = "runner manager failures", threshold = 3, duration = "300s" }
        }, local.apps_enabled ? {
        apps-5xx = { title = "app 5xx responses", threshold = 5, duration = "300s" }
        } : {}) : key => {
        display_name = "${var.name} ${spec.title}"
        filter       = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.main[key].name}\" AND resource.type=\"cloud_run_revision\""
        threshold    = spec.threshold
        duration     = spec.duration
        aligner      = "ALIGN_SUM"
        reducer      = "REDUCE_SUM"
      }
    },
    {
      cloud-sql-cpu = {
        display_name = "${var.name} Cloud SQL CPU above 90%"
        filter       = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND ${local.cloud_sql_resource}"
        threshold    = 0.9
        duration     = "900s"
        aligner      = "ALIGN_MEAN"
        reducer      = "REDUCE_NONE"
      }
      cloud-sql-disk = {
        display_name = "${var.name} Cloud SQL disk above 85%"
        filter       = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND ${local.cloud_sql_resource}"
        threshold    = 0.85
        duration     = "300s"
        aligner      = "ALIGN_MEAN"
        reducer      = "REDUCE_NONE"
      }
      # Sandbox services are named rt-<id> with no install prefix, so this counts every install in
      # the project, not only this one. Counts services, not series: stage one sums the active
      # instances of each service (across revisions), stage two counts the services that have one.
      live-sandboxes = {
        display_name = "${var.name} live sandboxes above ${local.size.sandbox_alert_cap}"
        filter       = "${local.sandbox_filter} AND metric.labels.state=\"active\""
        threshold    = local.size.sandbox_alert_cap
        duration     = "300s"
        aligner      = "ALIGN_MAX"
        reducer      = "REDUCE_SUM"
      }
    },
    local.uptime_enabled ? {
      web-uptime = {
        display_name = "${var.name} web readiness probe failing"
        filter       = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.web_readyz[0].uptime_check_id}\" AND resource.type=\"uptime_url\""
        threshold    = 1
        duration     = "300s"
        aligner      = "ALIGN_NEXT_OLDER"
        reducer      = "REDUCE_COUNT_FALSE"
      }
    } : {},
  )
}

resource "google_logging_metric" "main" {
  for_each = local.log_metrics

  name        = "${var.name}-${each.key}"
  description = "${var.name}: ${replace(each.key, "-", " ")}"
  filter      = each.value

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_dashboard" "main" {
  dashboard_json = jsonencode({
    displayName = var.name
    gridLayout = {
      columns = "2"
      widgets = [
        for chart in local.dashboard_charts : {
          title = chart.title
          xyChart = {
            dataSets = [{
              plotType   = "LINE"
              targetAxis = "Y1"
              timeSeriesQuery = {
                timeSeriesFilter = {
                  filter = chart.filter
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = chart.aligner
                    crossSeriesReducer = chart.reducer
                  }
                }
              }
            }]
          }
        }
      ]
    }
  })
}

resource "google_monitoring_notification_channel" "email" {
  count = local.alerts_enabled ? 1 : 0

  display_name = "${var.name} alerts"
  type         = "email"
  labels = {
    email_address = var.alerts_email
  }
}

resource "google_monitoring_uptime_check_config" "web_readyz" {
  count = local.uptime_enabled ? 1 : 0

  display_name = "${var.name}-web-readyz"
  period       = "300s"
  timeout      = "10s"

  http_check {
    path         = "/api/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.web_host
    }
  }
}

resource "google_monitoring_alert_policy" "main" {
  for_each = local.alerts_enabled ? local.alert_policies : {}

  display_name          = each.value.display_name
  combiner              = "OR"
  notification_channels = [google_monitoring_notification_channel.email[0].name]

  conditions {
    display_name = each.value.display_name

    condition_threshold {
      filter          = each.value.filter
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold
      duration        = each.value.duration

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = each.value.aligner
        cross_series_reducer = each.value.reducer == "REDUCE_NONE" ? null : each.value.reducer
        group_by_fields = (
          each.key == "web-uptime" ? ["resource.label.host"] :
          each.key == "live-sandboxes" ? ["resource.label.service_name"] : null
        )
      }

      dynamic "aggregations" {
        for_each = each.key == "live-sandboxes" ? [1] : []
        content {
          alignment_period     = "300s"
          per_series_aligner   = "ALIGN_MAX"
          cross_series_reducer = "REDUCE_COUNT"
        }
      }
    }
  }
}

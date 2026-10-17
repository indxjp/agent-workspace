# Deployment observability

The Terraform stack creates a public HTTPS uptime check, 99.5% rolling availability SLO, CPU and
availability alerts, and the Cloud Monitoring dashboard in this directory. Route alert policies to
your existing notification channels after apply; the module intentionally does not guess an
on-call destination.

`compose.observability.yaml` is an optional Compose overlay for application OTLP and host metrics.
Set `OTEL_COLLECTOR_IMAGE` to a reviewed contrib-collector digest and run Compose with both the
production file and this overlay. Workload identity comes from the VM metadata server; do not mount
a service-account key. Before enabling the overlay, verify the selected collector image contains
the `googlecloud` exporter and that the application build emits OTLP.

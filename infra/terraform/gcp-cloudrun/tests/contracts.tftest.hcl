mock_provider "google" {
  mock_data "google_project" {
    defaults = {
      number = "123456789012"
    }
  }

  mock_resource "google_kms_key_ring" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/locations/asia-northeast1/keyRings/agent-workspace-secrets"
    }
  }

  mock_resource "google_kms_crypto_key" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/locations/asia-northeast1/keyRings/agent-workspace-secrets/cryptoKeys/master-key-cmek"
    }
  }

  mock_resource "google_service_account" {
    override_during = plan

    defaults = {
      name   = "projects/aw-test-project/serviceAccounts/agent-workspace-web@aw-test-project.iam.gserviceaccount.com"
      email  = "agent-workspace-web@aw-test-project.iam.gserviceaccount.com"
      member = "serviceAccount:agent-workspace-web@aw-test-project.iam.gserviceaccount.com"
    }
  }

  mock_resource "google_secret_manager_secret" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/secrets/agent-workspace-master-encryption-key"
    }
  }

  mock_resource "google_secret_manager_secret_version" {
    override_during = plan

    defaults = {
      version = "1"
    }
  }

  mock_resource "google_compute_network" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/global/networks/agent-workspace-vpc"
    }
  }

  mock_resource "google_compute_subnetwork" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/regions/asia-northeast1/subnetworks/agent-workspace-services"
    }
  }

  mock_resource "google_compute_address" {
    override_during = plan

    defaults = {
      id      = "projects/aw-test-project/regions/asia-northeast1/addresses/agent-workspace-gateway-internal"
      address = "10.10.0.50"
    }
  }

  mock_resource "google_compute_region_network_endpoint_group" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/regions/asia-northeast1/networkEndpointGroups/agent-workspace-gateway-neg"
    }
  }

  mock_resource "google_compute_region_backend_service" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/regions/asia-northeast1/backendServices/agent-workspace-gateway"
    }
  }

  mock_resource "google_compute_region_url_map" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/regions/asia-northeast1/urlMaps/agent-workspace-gateway"
    }
  }

  mock_resource "google_compute_region_target_http_proxy" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/regions/asia-northeast1/targetHttpProxies/agent-workspace-gateway"
    }
  }

  mock_resource "google_compute_security_policy" {
    override_during = plan

    defaults = {
      id = "projects/aw-test-project/global/securityPolicies/agent-workspace-armor"
    }
  }

  mock_resource "google_cloud_run_v2_service" {
    override_during = plan

    defaults = {
      uri = "https://agent-workspace-web-abc123-an.a.run.app"
    }
  }

  mock_data "google_compute_zones" {
    defaults = {
      names = ["asia-northeast1-a", "asia-northeast1-b", "asia-northeast1-c"]
    }
  }

  mock_resource "google_artifact_registry_repository" {
    override_during = plan

    defaults = {
      name = "projects/aw-test-project/locations/asia-northeast1/repositories/agent-workspace"
    }
  }
}

mock_provider "google-beta" {
  mock_resource "google_project_service_identity" {
    override_during = plan

    defaults = {
      email  = "service-123456789012@gcp-sa-secretmanager.iam.gserviceaccount.com"
      member = "serviceAccount:service-123456789012@gcp-sa-secretmanager.iam.gserviceaccount.com"
    }
  }
}

mock_provider "time" {}

mock_provider "random" {}

variables {
  project_id            = "aw-test-project"
  bootstrap_admin_email = "owner@example.com"

  images = {
    web     = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    gateway = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    runner  = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
    runtime = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
  }
}

run "web_accepts_all_ingress_and_the_gateway_and_runner_manager_are_internal_only" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_service.web.ingress == "INGRESS_TRAFFIC_ALL" &&
      google_cloud_run_v2_service.gateway.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.runner_manager.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    )
    error_message = "web accepts INGRESS_TRAFFIC_ALL; the gateway and runner manager accept INGRESS_TRAFFIC_INTERNAL_ONLY"
  }
}

run "web_and_gateway_are_invokable_by_allusers_and_the_runner_manager_only_by_web" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.web_public.member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.gateway_public.member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.web_public.role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.gateway_public.role == "roles/run.invoker"
    )
    error_message = "web and gateway must grant roles/run.invoker to allUsers"
  }

  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.web_invokes_runner_manager.role == "roles/run.invoker" &&
      google_cloud_run_v2_service_iam_member.web_invokes_runner_manager.member == google_service_account.web.member
    )
    error_message = "the web service account must be the runner manager's invoker"
  }
}

run "no_allusers_member_exists_on_the_runner_manager" {
  command = plan

  # A resurrected runner_manager_public would not compile against this reference, so the check is
  # that the only runner manager binding names the web identity rather than allUsers.
  assert {
    condition     = google_cloud_run_v2_service_iam_member.web_invokes_runner_manager.member != "allUsers"
    error_message = "the runner manager must have no allUsers invoker"
  }
}

run "web_gateway_and_runner_manager_reach_the_private_network_by_direct_vpc_egress" {
  command = plan

  assert {
    condition = alltrue([
      for service in [google_cloud_run_v2_service.web, google_cloud_run_v2_service.gateway, google_cloud_run_v2_service.runner_manager] :
      service.template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY" &&
      length(service.template[0].vpc_access[0].network_interfaces) == 1
    ])
    error_message = "web, gateway and runner manager must use Direct VPC egress with PRIVATE_RANGES_ONLY"
  }
}

run "the_runner_manager_names_the_sandbox_network_and_subnetwork" {
  command = plan

  assert {
    condition     = [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value if e.name == "RUNTIME_NETWORK"] == [google_compute_network.main[0].id]
    error_message = "RUNTIME_NETWORK must be the network id"
  }

  assert {
    condition     = [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value if e.name == "RUNTIME_SUBNETWORK"] == [google_compute_subnetwork.sandbox[0].id]
    error_message = "RUNTIME_SUBNETWORK must be the sandbox subnetwork id"
  }

  assert {
    condition     = length([for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.name if contains(["RUNTIME_VPC_CONNECTOR", "RUNTIME_EGRESS"], e.name)]) == 0
    error_message = "the runner manager must carry no RUNTIME_VPC_CONNECTOR or RUNTIME_EGRESS"
  }
}

run "the_gateway_has_an_internal_application_load_balancer" {
  command = plan

  assert {
    condition = (
      google_compute_address.gateway_internal.address_type == "INTERNAL" &&
      google_compute_address.gateway_internal.subnetwork == google_compute_subnetwork.services[0].id
    )
    error_message = "the gateway's internal address must be an INTERNAL address in the services subnet"
  }

  assert {
    condition = (
      google_compute_region_network_endpoint_group.gateway.network_endpoint_type == "SERVERLESS" &&
      google_compute_region_network_endpoint_group.gateway.cloud_run[0].service == google_cloud_run_v2_service.gateway.name
    )
    error_message = "a serverless NEG must point at the gateway Cloud Run service"
  }

  assert {
    condition = (
      google_compute_region_backend_service.gateway.load_balancing_scheme == "INTERNAL_MANAGED" &&
      [for b in google_compute_region_backend_service.gateway.backend : b.group] == [google_compute_region_network_endpoint_group.gateway.id] &&
      google_compute_region_url_map.gateway.default_service == google_compute_region_backend_service.gateway.id &&
      google_compute_region_target_http_proxy.gateway.url_map == google_compute_region_url_map.gateway.id
    )
    error_message = "the backend service must be INTERNAL_MANAGED on the gateway NEG, behind the URL map and target proxy"
  }

  assert {
    condition = (
      google_compute_forwarding_rule.gateway.load_balancing_scheme == "INTERNAL_MANAGED" &&
      google_compute_forwarding_rule.gateway.port_range == "80" &&
      google_compute_forwarding_rule.gateway.ip_address == google_compute_address.gateway_internal.id &&
      google_compute_forwarding_rule.gateway.subnetwork == google_compute_subnetwork.services[0].id &&
      google_compute_forwarding_rule.gateway.target == google_compute_region_target_http_proxy.gateway.id
    )
    error_message = "the internal forwarding rule must serve port 80 at the gateway's internal address in the services subnet"
  }

  assert {
    condition = (
      google_compute_subnetwork.proxy_only[0].purpose == "REGIONAL_MANAGED_PROXY" &&
      google_compute_subnetwork.proxy_only[0].role == "ACTIVE"
    )
    error_message = "a created network must get an active REGIONAL_MANAGED_PROXY proxy-only subnet"
  }

  assert {
    condition     = google_cloud_run_v2_service.gateway.ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY"
    error_message = "the gateway's ingress stays internal behind the internal load balancer"
  }
}

run "sandboxes_get_the_gateway_at_its_internal_load_balancer" {
  command = plan

  assert {
    condition     = local.gateway_internal_url == "http://10.10.0.50"
    error_message = "the sandbox-facing gateway URL must be the internal load balancer's address"
  }

  assert {
    condition     = [for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.value if e.name == "MODEL_GATEWAY_URL"] == ["http://10.10.0.50"]
    error_message = "web must hand sandboxes the internal load balancer URL as MODEL_GATEWAY_URL, not the run.app URL"
  }

  assert {
    condition     = output.gateway_internal_url == "http://10.10.0.50"
    error_message = "gateway_internal_url must be the internal load balancer URL"
  }
}

run "sandbox_firewall_allows_only_the_gateway_load_balancer_and_no_nat_exists" {
  command = plan

  assert {
    condition = (
      google_compute_firewall.sandbox_deny_egress.direction == "EGRESS" &&
      google_compute_firewall.sandbox_deny_egress.priority == 0 &&
      google_compute_firewall.sandbox_deny_egress.target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_deny_egress.destination_ranges == toset([
        "128.0.0.0/1", "64.0.0.0/2", "32.0.0.0/3", "16.0.0.0/4", "0.0.0.0/5", "12.0.0.0/6", "8.0.0.0/7", "11.0.0.0/8",
        "10.128.0.0/9", "10.64.0.0/10", "10.32.0.0/11", "10.16.0.0/12", "10.0.0.0/13", "10.12.0.0/14", "10.8.0.0/15",
        "10.11.0.0/16", "10.10.128.0/17", "10.10.64.0/18", "10.10.32.0/19", "10.10.16.0/20", "10.10.8.0/21",
        "10.10.4.0/22", "10.10.2.0/23", "10.10.1.0/24", "10.10.0.128/25", "10.10.0.64/26", "10.10.0.0/27",
        "10.10.0.32/28", "10.10.0.56/29", "10.10.0.52/30", "10.10.0.48/31", "10.10.0.51/32",
      ]) &&
      !contains(google_compute_firewall.sandbox_deny_egress.destination_ranges, "0.0.0.0/0") &&
      [for d in google_compute_firewall.sandbox_deny_egress.deny : d.protocol] == ["all"]
    )
    error_message = "the catch-all deny must cover 0.0.0.0/0 without the gateway's /32, at priority 0 for tag aw-sandbox (the module declares no NAT; the CLI test asserts it)"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_deny_google_vips.direction == "EGRESS" &&
      google_compute_firewall.sandbox_deny_google_vips.priority == 0 &&
      google_compute_firewall.sandbox_deny_google_vips.target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_deny_google_vips.destination_ranges == toset(["199.36.153.8/30", "199.36.153.4/30"]) &&
      [for d in google_compute_firewall.sandbox_deny_google_vips.deny : d.protocol] == ["all"] &&
      length(google_compute_firewall.sandbox_deny_google_vips.allow) == 0
    )
    error_message = "both Google VIP ranges must be denied on every protocol and port at priority 0 for tag aw-sandbox"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_deny_gateway_other.direction == "EGRESS" &&
      google_compute_firewall.sandbox_deny_gateway_other.priority == 0 &&
      google_compute_firewall.sandbox_deny_gateway_other.target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_deny_gateway_other.destination_ranges == toset(["10.10.0.50/32"]) &&
      toset([for d in google_compute_firewall.sandbox_deny_gateway_other.deny : d.protocol]) == toset(["tcp", "udp", "icmp", "sctp", "esp", "ah"]) &&
      toset(flatten([for d in google_compute_firewall.sandbox_deny_gateway_other.deny : d.ports == null ? [] : tolist(d.ports)])) == toset(["0-79", "81-65535"])
    )
    error_message = "every protocol and port to the gateway's internal address except tcp 80 must be denied at priority 0"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_allow_gateway.direction == "EGRESS" &&
      google_compute_firewall.sandbox_allow_gateway.priority == 0 &&
      google_compute_firewall.sandbox_allow_gateway.target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_allow_gateway.destination_ranges == toset(["10.10.0.50/32"]) &&
      [for a in google_compute_firewall.sandbox_allow_gateway.allow : a.protocol] == ["tcp"] &&
      flatten([for a in google_compute_firewall.sandbox_allow_gateway.allow : tolist(a.ports)]) == ["80"]
    )
    error_message = "the only sandbox allow rule must permit tcp 80 to the gateway's internal address at priority 0"
  }

  assert {
    condition = alltrue([
      for range in google_compute_firewall.sandbox_allow_gateway.destination_ranges :
      !contains(["199.36.153.8/30", "199.36.153.4/30", "0.0.0.0/0"], range)
    ])
    error_message = "no aw-sandbox allow rule may target the Google VIP ranges"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_deny_egress_ipv6.direction == "EGRESS" &&
      google_compute_firewall.sandbox_deny_egress_ipv6.priority == 0 &&
      google_compute_firewall.sandbox_deny_egress_ipv6.target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_deny_egress_ipv6.destination_ranges == toset(["::/0"]) &&
      [for d in google_compute_firewall.sandbox_deny_egress_ipv6.deny : d.protocol] == ["all"]
    )
    error_message = "IPv6 egress for aw-sandbox must be denied by its own priority 0 rule"
  }
}

run "an_adopted_network_still_gets_the_sandbox_firewall_and_uses_its_subnetwork" {
  command = plan

  variables {
    network    = "projects/aw-test-project/global/networks/existing"
    subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/existing-services"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_deny_egress.network == var.network &&
      google_compute_firewall.sandbox_deny_google_vips.network == var.network &&
      google_compute_firewall.sandbox_deny_gateway_other.network == var.network &&
      google_compute_firewall.sandbox_deny_egress_ipv6.network == var.network &&
      google_compute_firewall.sandbox_allow_gateway.network == var.network
    )
    error_message = "every sandbox firewall rule must exist on the adopted network"
  }

  assert {
    condition = (
      google_compute_forwarding_rule.gateway.network == var.network &&
      google_compute_forwarding_rule.gateway.subnetwork == var.subnetwork &&
      google_compute_address.gateway_internal.subnetwork == var.subnetwork &&
      length(google_compute_subnetwork.proxy_only) == 0
    )
    error_message = "on an adopted network the internal load balancer uses the adopted subnetwork and its existing proxy-only subnet"
  }

  assert {
    condition     = [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value if e.name == "RUNTIME_SUBNETWORK"] == [var.subnetwork]
    error_message = "RUNTIME_SUBNETWORK must be the adopted subnetwork"
  }
}

run "web_names_the_runner_manager_id_token_audience_and_has_no_oidc_env_by_default" {
  command = plan

  assert {
    condition = contains(
      [for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name],
      "RUNNER_MANAGER_ID_TOKEN_AUDIENCE",
    )
    error_message = "web must receive RUNNER_MANAGER_ID_TOKEN_AUDIENCE"
  }

  assert {
    condition = length(setintersection(
      toset([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name]),
      toset(["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI"]),
    )) == 0
    error_message = "web must carry no OIDC env when oidc_issuer is unset"
  }

  assert {
    condition     = length(google_secret_manager_secret.oidc_client_secret) == 0 && output.oidc_client_secret_id == ""
    error_message = "no OIDC secret is created when oidc_issuer is unset"
  }
}

run "the_default_stack_creates_a_private_network_dns_zone_and_service_connection" {
  command = plan

  assert {
    condition = (
      google_compute_network.main[0].auto_create_subnetworks == false &&
      google_compute_subnetwork.services[0].private_ip_google_access &&
      google_compute_subnetwork.sandbox[0].private_ip_google_access &&
      google_compute_subnetwork.sandbox[0].ip_cidr_range == "10.10.4.0/22"
    )
    error_message = "the module must create a custom-mode network with Private Google Access subnets"
  }

  assert {
    condition = (
      google_service_networking_connection.psa[0].deletion_policy == "ABANDON" &&
      google_compute_global_address.psa[0].purpose == "VPC_PEERING" &&
      google_compute_global_address.psa[0].prefix_length == 20
    )
    error_message = "Private Services Access must reserve a /20 and abandon the connection on destroy"
  }

  assert {
    condition = (
      google_dns_managed_zone.run_app[0].dns_name == "run.app." &&
      google_dns_managed_zone.run_app[0].visibility == "private" &&
      google_dns_record_set.run_app_wildcard[0].name == "*.run.app." &&
      google_dns_record_set.run_app_apex[0].name == "run.app." &&
      length(google_dns_record_set.run_app_wildcard[0].rrdatas) == 4 &&
      contains(google_dns_record_set.run_app_apex[0].rrdatas, "199.36.153.11")
    )
    error_message = "a private run.app zone must resolve the wildcard and apex to the four restricted VIPs"
  }
}

run "an_adopted_network_creates_no_network_resources" {
  command = plan

  variables {
    network    = "projects/aw-test-project/global/networks/existing"
    subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/existing-services"
  }

  assert {
    condition = (
      length(google_compute_network.main) == 0 &&
      length(google_compute_subnetwork.services) == 0 &&
      length(google_compute_subnetwork.sandbox) == 0 &&
      length(google_compute_global_address.psa) == 0 &&
      length(google_service_networking_connection.psa) == 0 &&
      length(google_dns_managed_zone.run_app) == 0 &&
      length(google_dns_record_set.run_app_wildcard) == 0 &&
      length(google_dns_record_set.run_app_apex) == 0
    )
    error_message = "adopting a network must create no network, subnet, address, connection or zone"
  }

  assert {
    condition     = output.network == "projects/aw-test-project/global/networks/existing"
    error_message = "the network output must be the adopted network"
  }
}

run "network_without_subnetwork_is_refused" {
  command = plan

  variables {
    network = "projects/aw-test-project/global/networks/existing"
  }

  expect_failures = [terraform_data.input_checks]
}

run "oidc_wires_four_env_vars_and_a_secret_without_a_version" {
  command = plan

  variables {
    oidc_issuer    = "https://login.example.com"
    oidc_client_id = "client-123"
  }

  assert {
    condition = (
      length(google_secret_manager_secret.oidc_client_secret) == 1 &&
      google_secret_manager_secret.oidc_client_secret[0].secret_id == "agent-workspace-oidc-client-secret" &&
      google_secret_manager_secret_iam_member.web_oidc_client_secret[0].role == "roles/secretmanager.secretAccessor"
    )
    error_message = "oidc_issuer must create the client secret and let web read it"
  }

  assert {
    condition = {
      for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name => e.value
      if contains(["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_REDIRECT_URI"], e.name)
      } == {
      OIDC_ISSUER_URL   = "https://login.example.com"
      OIDC_CLIENT_ID    = "client-123"
      OIDC_REDIRECT_URI = "https://agent-workspace-web-123456789012.asia-northeast1.run.app/api/auth/callback"
    }
    error_message = "web must receive the issuer, client id and the redirect URI on its own origin"
  }

  # Run 42674364781: web_url was the service's `uri` (<service>-<hash>-<region code>.a.run.app) while
  # web sent the deterministic URL as its redirect URI, so an operator registering web_url's
  # callback would have met redirect_uri_mismatch. web_url is the origin of the redirect URI.
  assert {
    condition = (
      output.web_url == "https://agent-workspace-web-123456789012.asia-northeast1.run.app" &&
      one([
        for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
        e.value if e.name == "OIDC_REDIRECT_URI"
      ]) == "${output.web_url}/api/auth/callback"
    )
    error_message = "web_url must be the deterministic run.app origin the OIDC redirect URI is built on, never the service uri"
  }

  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
      e.name == "OIDC_CLIENT_SECRET" && e.value_source[0].secret_key_ref[0].version == "latest"
    ])
    error_message = "OIDC_CLIENT_SECRET must come from the secret at version latest"
  }
}

run "oidc_issuer_without_a_client_id_is_refused" {
  command = plan

  variables {
    oidc_issuer = "https://login.example.com"
  }

  expect_failures = [terraform_data.input_checks]
}

run "a_name_starting_rt_is_refused" {
  command = plan

  # rt- is the runner manager's sandbox prefix, which its create/delete grant matches by name and
  # its invoke grant and the gateway's by host: a stack named rt-tool-x would let the gateway (and
  # the manager) invoke rt-tool-x-web.
  variables {
    name = "rt-tool-x"
  }

  expect_failures = [var.name]
}

run "a_non_https_oidc_issuer_is_refused" {
  command = plan

  variables {
    oidc_issuer    = "http://login.example.com"
    oidc_client_id = "client-123"
  }

  expect_failures = [var.oidc_issuer]
}

run "cloud_sql_has_only_a_private_encrypted_address" {
  command = plan

  assert {
    condition = (
      google_sql_database_instance.main.settings[0].ip_configuration[0].ipv4_enabled == false &&
      google_sql_database_instance.main.settings[0].ip_configuration[0].ssl_mode == "ENCRYPTED_ONLY"
    )
    error_message = "Cloud SQL must have no public IPv4 and require encrypted connections"
  }
}

run "both_cloud_sql_proxy_sidecars_use_the_private_ip" {
  command = plan

  assert {
    condition = alltrue([
      for service in [google_cloud_run_v2_service.web, google_cloud_run_v2_service.gateway] :
      anytrue([
        for c in service.template[0].containers : c.name == "cloud-sql-proxy" && contains(c.args, "--private-ip")
      ])
    ])
    error_message = "the web and gateway cloud-sql-proxy sidecars must pass --private-ip"
  }
}

run "cloud_sql_is_postgres_16_enterprise_and_protected_by_default" {
  command = plan

  assert {
    condition = (
      google_sql_database_instance.main.database_version == "POSTGRES_16" &&
      google_sql_database_instance.main.settings[0].edition == "ENTERPRISE"
    )
    error_message = "Cloud SQL must be POSTGRES_16 ENTERPRISE"
  }

  assert {
    condition     = google_sql_database_instance.main.deletion_protection
    error_message = "Cloud SQL deletion protection must be on by default"
  }
}

run "the_default_stack_protects_data_in_both_buckets_and_the_three_services" {
  command = plan

  assert {
    condition = alltrue([
      for b in [google_storage_bucket.objects, google_storage_bucket.state] :
      b.force_destroy == false &&
      b.versioning[0].enabled == true &&
      b.soft_delete_policy[0].retention_duration_seconds == 604800 &&
      length(b.lifecycle_rule) == 1 &&
      alltrue([
        for r in b.lifecycle_rule :
        one(r.condition).days_since_noncurrent_time == 30 && one(r.action).type == "Delete"
      ])
    ])
    error_message = "both buckets must keep force_destroy false, versioning, 7-day soft delete and a 30-day noncurrent-version delete rule"
  }

  assert {
    condition = alltrue([
      for service in [
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.gateway,
        google_cloud_run_v2_service.runner_manager,
      ] : service.deletion_protection == true
    ])
    error_message = "web, gateway and runner manager must have deletion protection on by default"
  }
}

run "cloud_sql_can_be_destroyed_when_data_protection_is_off" {
  command = plan

  variables {
    data_protection = false
  }

  assert {
    condition     = !google_sql_database_instance.main.deletion_protection
    error_message = "data_protection = false must lift Cloud SQL deletion protection"
  }

  assert {
    condition = (
      google_storage_bucket.objects.force_destroy == true &&
      google_storage_bucket.state.force_destroy == true
    )
    error_message = "data_protection = false must let both buckets be destroyed with their objects"
  }

  assert {
    condition = alltrue([
      for service in [
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.gateway,
        google_cloud_run_v2_service.runner_manager,
      ] : service.deletion_protection == false
    ])
    error_message = "data_protection = false must lift deletion protection on the three services"
  }
}

run "the_default_size_is_small" {
  command = plan

  assert {
    condition = (
      google_sql_database_instance.main.settings[0].tier == "db-f1-micro" &&
      google_sql_database_instance.main.settings[0].availability_type == "ZONAL"
    )
    error_message = "the small size must use db-f1-micro and ZONAL availability"
  }

  assert {
    condition = (
      google_cloud_run_v2_service.web.template[0].scaling[0].min_instance_count == 1 &&
      google_cloud_run_v2_service.gateway.template[0].scaling[0].min_instance_count == 0 &&
      google_cloud_run_v2_service.runner_manager.template[0].scaling[0].min_instance_count == 0
    )
    error_message = "the small size must run web with min 1 and scale the gateway and runner manager to zero"
  }

  assert {
    condition = (
      google_sql_database_instance.main.settings[0].backup_configuration[0].backup_retention_settings[0].retained_backups == 14 &&
      google_sql_database_instance.main.settings[0].backup_configuration[0].backup_retention_settings[0].retention_unit == "COUNT" &&
      google_sql_database_instance.main.settings[0].backup_configuration[0].transaction_log_retention_days == 7
    )
    error_message = "Cloud SQL must retain 14 backups and 7 days of transaction logs"
  }

  assert {
    condition = (
      google_sql_database_instance.main.settings[0].maintenance_window[0].day == 7 &&
      google_sql_database_instance.main.settings[0].maintenance_window[0].hour == 18 &&
      google_sql_database_instance.main.settings[0].maintenance_window[0].update_track == "stable"
    )
    error_message = "maintenance must run Sunday 18:00 UTC on the stable track"
  }

  assert {
    condition = alltrue([
      for service in [
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.gateway,
        google_cloud_run_v2_service.runner_manager,
      ] : service.template[0].containers[0].resources[0].startup_cpu_boost == true
    ])
    error_message = "the main container of web, gateway and runner manager must enable startup CPU boost"
  }
}

run "the_standard_size_is_highly_available_with_a_warm_instance_everywhere" {
  command = plan

  variables {
    size = "standard"
  }

  assert {
    condition = (
      google_sql_database_instance.main.settings[0].tier == "db-custom-2-7680" &&
      google_sql_database_instance.main.settings[0].availability_type == "REGIONAL"
    )
    error_message = "the standard size must use db-custom-2-7680 with REGIONAL availability"
  }

  assert {
    condition = alltrue([
      for service in [
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.gateway,
        google_cloud_run_v2_service.runner_manager,
      ] : service.template[0].scaling[0].min_instance_count == 1
    ])
    error_message = "the standard size must keep at least one instance of every service"
  }
}

run "an_unknown_size_is_refused" {
  command = plan

  variables {
    size = "large"
  }

  expect_failures = [var.size]
}

run "no_project_binding_grants_anything_to_the_default_compute_service_account" {
  command = plan

  assert {
    condition = alltrue([
      for m in [
        google_project_iam_member.runner_manager_run_developer,
        google_project_iam_member.runner_manager_run_invoker,
        google_project_iam_member.web_cloudsql_client,
        google_project_iam_member.gateway_cloudsql_client,
        google_project_iam_member.gateway_aiplatform_user,
      ] : !strcontains(m.member, "-compute@developer.gserviceaccount.com") && m.role != "roles/secretmanager.secretAccessor"
    ])
    error_message = "no project-level binding may name the default compute service account or grant secretmanager.secretAccessor"
  }

  assert {
    condition     = !contains(keys(google_project_service.required), "cloudbuild.googleapis.com")
    error_message = "Cloud Build is unused and its API must not be enabled"
  }
}

run "each_service_account_reads_exactly_the_secrets_it_uses" {
  command = plan

  assert {
    condition = (
      length(google_secret_manager_secret_iam_member.web_access) == 5 &&
      length(google_secret_manager_secret_iam_member.gateway_access) == 2 &&
      toset(keys(google_secret_manager_secret_iam_member.web_access)) == toset([
        "agent-workspace-database-url",
        "agent-workspace-gateway-token-secret",
        "agent-workspace-session-secret",
        "agent-workspace-bootstrap-admin-password",
        "agent-workspace-runner-manager-token",
      ]) &&
      toset(keys(google_secret_manager_secret_iam_member.gateway_access)) == toset([
        "agent-workspace-database-url",
        "agent-workspace-gateway-token-secret",
      ]) &&
      google_secret_manager_secret_iam_member.runner_manager_access.secret_id == "agent-workspace-runner-manager-token" &&
      google_secret_manager_secret_iam_member.web_master_key_access.secret_id == google_secret_manager_secret.master_key.secret_id &&
      google_secret_manager_secret_iam_member.gateway_master_key_access.secret_id == google_secret_manager_secret.master_key.secret_id &&
      length(google_secret_manager_secret_iam_member.egress_proxy_key_access) == 0 &&
      length(google_secret_manager_secret_iam_member.runner_manager_egress_key_access) == 0
    )
    error_message = "web must read 5 secrets plus the master key, the gateway 2 plus the master key, the runner manager only its token"
  }
}

run "with_sandbox_internet_the_proxy_and_the_runner_manager_read_exactly_the_key_secret" {
  command = plan

  variables {
    sandbox_internet = true
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    }
  }

  override_resource {
    override_during = plan
    target          = google_compute_address.egress_proxy
    values = {
      address = "10.10.0.60"
    }
  }

  assert {
    condition = (
      google_secret_manager_secret_iam_member.egress_proxy_key_access[0].secret_id == "agent-workspace-egress-credential-key" &&
      google_secret_manager_secret_iam_member.egress_proxy_key_access[0].role == "roles/secretmanager.secretAccessor" &&
      google_secret_manager_secret_iam_member.runner_manager_egress_key_access[0].secret_id == "agent-workspace-egress-credential-key" &&
      google_secret_manager_secret_iam_member.runner_manager_egress_key_access[0].member == google_service_account.runner_manager.member &&
      length(google_secret_manager_secret_iam_member.web_access) == 5 &&
      length(google_secret_manager_secret_iam_member.gateway_access) == 2
    )
    error_message = "only the proxy and the runner manager may read the key secret; web and the gateway keep their secrets"
  }
}

run "the_proxy_vm_authenticates_to_the_registry_location_of_its_image" {
  command = plan

  variables {
    sandbox_internet = true
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "europe-west1-docker.pkg.dev/aw-test-project/proxy-images/egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    }
  }

  override_resource {
    override_during = plan
    target          = google_compute_address.egress_proxy
    values = {
      address = "10.10.0.60"
    }
  }

  assert {
    condition = (
      strcontains(local.egress_proxy_prepare, "--registries=europe-west1-docker.pkg.dev") &&
      !strcontains(local.egress_proxy_prepare, "--registries=asia-northeast1-docker.pkg.dev")
    )
    error_message = "the credential helper must be configured for the registry host of the proxy image, not var.region"
  }
}

run "module_owned_secret_references_are_pinned_to_the_created_version" {
  command = plan

  assert {
    condition = alltrue([
      for service in [
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.gateway,
        google_cloud_run_v2_service.runner_manager,
      ] :
      alltrue([
        for e in service.template[0].containers[0].env :
        e.value_source[0].secret_key_ref[0].version == "1"
        if length(e.value_source) > 0
      ])
    ])
    error_message = "every module-owned secret reference must pin the created secret version, not latest"
  }

  assert {
    condition = alltrue([
      for service in [google_cloud_run_v2_service.web, google_cloud_run_v2_service.gateway] :
      anytrue([
        for e in service.template[0].containers[0].env :
        e.name == "GCP_MASTER_KEY_SECRET" && endswith(e.value, "/versions/1")
      ])
    ])
    error_message = "GCP_MASTER_KEY_SECRET must name the created master key version, not latest"
  }
}

# The application's role owns the migrated schema, and Cloud SQL refuses to drop a PostgreSQL role
# that owns objects: a destroy that deletes the user fails before the instance (BYOC GCP P1 live
# run, 2026-11-05). The user is abandoned and goes with the instance; the database is still deleted.
run "the_database_user_is_abandoned_on_destroy" {
  command = plan

  assert {
    condition     = google_sql_user.main.deletion_policy == "ABANDON"
    error_message = "google_sql_user.main must set deletion_policy = \"ABANDON\", or destroy fails on the role's owned objects"
  }

  assert {
    condition     = google_sql_database.main.deletion_policy != "ABANDON"
    error_message = "google_sql_database.main must not be abandoned: it keeps the default deletion_policy (DELETE)"
  }
}

run "the_kms_key_encrypts_the_master_key" {
  command = plan

  assert {
    condition = (
      google_secret_manager_secret.master_key.replication[0].user_managed[0].replicas[0].customer_managed_encryption[0].kms_key_name
      == google_kms_crypto_key.secret_manager.id
    )
    error_message = "the master key secret must be encrypted with the module's Cloud KMS key"
  }
}

run "the_kms_binding_names_the_secret_manager_service_agent" {
  command = plan

  assert {
    condition = (
      google_kms_crypto_key_iam_member.secret_manager.member
      == "serviceAccount:service-123456789012@gcp-sa-secretmanager.iam.gserviceaccount.com"
      && time_sleep.secret_manager_identity.triggers["member"]
      == google_project_service_identity.secret_manager.member
      && time_sleep.secret_manager_identity.create_duration == "60s"
    )
    error_message = "the KMS binding must name the Secret Manager service agent the module creates"
  }
}

run "image_registry_output_names_the_artifact_repository" {
  command = plan

  assert {
    condition     = output.image_registry == "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace"
    error_message = "image_registry must be <region>-docker.pkg.dev/<project>/<name>"
  }
}

run "mutable_image_tags_are_refused" {
  command = plan

  variables {
    images = {
      web     = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web:latest"
      gateway = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner  = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    }
  }

  expect_failures = [var.images]
}

# The runner manager creates every runtime service from var.images.runtime, and Cloud Run checks
# that the calling principal can read that image (live run 42011318769: a 403 on CI's staging
# repository). It reads the stack's repository, and the runtime image's own repository when that
# is another one in this project; nothing in any other project.
run "the_runner_manager_reads_only_the_stack_repository_when_the_runtime_image_is_in_it" {
  command = plan

  assert {
    condition = (
      google_artifact_registry_repository_iam_member.runner_manager_artifact_reader.repository == "agent-workspace" &&
      google_artifact_registry_repository_iam_member.runner_manager_artifact_reader.role == "roles/artifactregistry.reader" &&
      length(google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader) == 0
    )
    error_message = "with the runtime image in the stack's repository the runner manager reads that repository only"
  }
}

run "the_runner_manager_reads_the_repository_a_runtime_image_used_in_place_is_in" {
  command = plan

  variables {
    images = {
      web     = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner  = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime = "asia-northeast1-docker.pkg.dev/aw-test-project/aw-byoc-1-staging/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    }
  }

  assert {
    condition = (
      length(google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader) == 1 &&
      google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader[0].project == "aw-test-project" &&
      google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader[0].location == "asia-northeast1" &&
      google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader[0].repository == "aw-byoc-1-staging" &&
      google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader[0].role == "roles/artifactregistry.reader" &&
      google_artifact_registry_repository_iam_member.runner_manager_runtime_image_reader[0].member == google_service_account.runner_manager.member
    )
    error_message = "the runner manager must read the repository the runtime image is in, scoped to that repository"
  }
}

run "a_runtime_image_in_another_projects_registry_is_refused" {
  command = plan

  variables {
    images = {
      web     = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner  = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime = "asia-northeast1-docker.pkg.dev/someone-elses-project/images/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    }
  }

  expect_failures = [terraform_data.input_checks]
}

run "a_runtime_image_outside_artifact_registry_is_refused" {
  command = plan

  variables {
    images = {
      web     = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner  = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime = "ghcr.io/indxdev/agent-workspace-runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    }
  }

  expect_failures = [terraform_data.input_checks]
}

# A second apply right after the first must plan no change. The API reads back a service-level
# scaling block of zeros; without a matching declaration every plan removes it (BYOC GCP P1 live
# run, 2026-11-05). min_instance_count stays 0 and scaling_mode stays unset (automatic scaling).
run "the_long_lived_cloud_run_services_declare_the_service_level_scaling_the_api_reads_back" {
  command = plan

  assert {
    condition = alltrue([
      for service in [
        google_cloud_run_v2_service.web,
        google_cloud_run_v2_service.gateway,
        google_cloud_run_v2_service.runner_manager,
      ] :
      length(service.scaling) == 1 &&
      service.scaling[0].min_instance_count == 0 &&
      service.scaling[0].manual_instance_count == 0 &&
      service.scaling[0].scaling_mode == null
    ])
    error_message = "web, gateway and runner manager must declare service-level scaling { min_instance_count = 0, manual_instance_count = 0 } with scaling_mode unset, or every plan shows a perpetual diff"
  }
}

run "the_default_stack_creates_no_external_load_balancer_armor_or_iap" {
  command = plan

  assert {
    condition = (
      length(google_compute_global_address.lb) == 0 &&
      length(google_compute_backend_service.web) == 0 &&
      length(google_compute_managed_ssl_certificate.web) == 0 &&
      length(google_compute_security_policy.armor) == 0 &&
      length(google_project_service.iap) == 0 &&
      google_cloud_run_v2_service.web.ingress == "INGRESS_TRAFFIC_ALL"
    )
    error_message = "without a domain no external load balancer, armor or IAP exists and web keeps INGRESS_TRAFFIC_ALL (the gateway's internal load balancer always exists)"
  }

  assert {
    condition     = output.load_balancer_ip == ""
    error_message = "load_balancer_ip is empty without a domain"
  }
}

run "a_domain_adds_the_load_balancer_and_closes_web_ingress" {
  command = plan

  variables {
    domain = "app.example.com"
  }

  assert {
    condition = (
      length(google_compute_global_address.lb) == 1 &&
      google_compute_region_network_endpoint_group.web[0].network_endpoint_type == "SERVERLESS" &&
      google_compute_backend_service.web[0].load_balancing_scheme == "EXTERNAL_MANAGED" &&
      google_compute_backend_service.web[0].security_policy == null &&
      length(google_compute_security_policy.armor) == 0 &&
      one(google_compute_managed_ssl_certificate.web[0].managed[0].domains) == "app.example.com" &&
      google_compute_global_forwarding_rule.https[0].port_range == "443" &&
      google_compute_global_forwarding_rule.http[0].port_range == "80"
    )
    error_message = "a domain creates the address, serverless NEG, backend, certificate and both forwarding rules, without armor"
  }

  assert {
    condition = (
      google_compute_url_map.redirect[0].default_url_redirect[0].https_redirect == true &&
      google_compute_url_map.redirect[0].default_url_redirect[0].strip_query == false
    )
    error_message = "port 80 redirects to HTTPS and keeps the query"
  }

  assert {
    condition     = google_cloud_run_v2_service.web.ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
    error_message = "with a domain web accepts only internal and load balancer traffic"
  }

  assert {
    condition     = google_cloud_run_v2_service_iam_member.web_public.member == "allUsers" && length(google_project_service.iap) == 0
    error_message = "a domain alone keeps web invokable by allUsers and does not enable IAP"
  }

  assert {
    condition     = output.web_url == "https://app.example.com"
    error_message = "web_url is the domain"
  }
}

run "domain_armor_and_iap_attach_the_policy_and_put_iap_on_the_backend" {
  command = plan

  variables {
    domain = "app.example.com"
    armor  = true
    iap    = true
  }

  assert {
    condition = (
      length(google_compute_security_policy.armor) == 1 &&
      google_compute_backend_service.web[0].security_policy != null
    )
    error_message = "armor creates the policy and attaches it to the backend service"
  }

  assert {
    condition = (
      length(google_compute_backend_service.web[0].iap) == 1 &&
      google_compute_backend_service.web[0].iap[0].enabled == true
    )
    error_message = "iap enables IAP on the load balancer backend service"
  }

  assert {
    condition     = google_cloud_run_v2_service_iam_member.web_public.member == "allUsers"
    error_message = "web keeps its allUsers invoker behind the internal-load-balancer ingress"
  }
}

run "the_web_origin_follows_the_domain_but_the_gateway_keeps_the_run_app_url" {
  command = plan

  variables {
    domain         = "app.example.com"
    oidc_issuer    = "https://login.example.com"
    oidc_client_id = "client"
  }

  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_service.web.template[0].containers[0].env :
      e.name == "OIDC_REDIRECT_URI" && e.value == "https://app.example.com/api/auth/callback"
    ])
    error_message = "OIDC_REDIRECT_URI follows the domain"
  }

  assert {
    condition = anytrue([
      for e in google_cloud_run_v2_service.gateway.template[0].containers[0].env :
      e.name == "GATEWAY_CONTROL_PLANE_ORIGIN" && endswith(e.value, ".run.app")
    ])
    error_message = "the gateway keeps reaching web by its run.app URL"
  }
}

run "iap_without_a_domain_is_refused" {
  command = plan

  variables {
    iap = true
  }

  expect_failures = [terraform_data.domain_checks]
}

run "armor_without_a_domain_is_refused" {
  command = plan

  variables {
    armor = true
  }

  expect_failures = [terraform_data.domain_checks]
}

run "an_upper_case_domain_is_refused" {
  command = plan

  variables {
    domain = "App.Example.com"
  }

  expect_failures = [var.domain]
}

run "a_bare_network_name_is_refused" {
  command = plan

  variables {
    network    = "existing"
    subnetwork = "projects/aw-test-project/regions/asia-northeast1/subnetworks/existing-services"
  }

  expect_failures = [var.network]
}

# D-3: Claude on Vertex AI is reached by the gateway with the install's own identity.
run "vertex_ai_api_is_enabled_and_only_the_gateway_may_call_it" {
  command = plan

  assert {
    condition     = contains(local.required_apis, "aiplatform.googleapis.com")
    error_message = "the module must enable aiplatform.googleapis.com"
  }

  assert {
    condition = (
      google_project_iam_member.gateway_aiplatform_user.role == "roles/aiplatform.user" &&
      google_project_iam_member.gateway_aiplatform_user.project == "aw-test-project"
    )
    error_message = "the gateway service account must hold roles/aiplatform.user"
  }

  assert {
    condition = alltrue([
      for member in [
        google_project_iam_member.web_cloudsql_client,
        google_project_iam_member.gateway_cloudsql_client,
      ] : member.role != "roles/aiplatform.user"
    ])
    error_message = "no other service account may be granted roles/aiplatform.user"
  }
}

run "web_defaults_its_vertex_connection_to_the_install_project_and_global" {
  command = plan

  assert {
    condition = (
      one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.value if e.name == "AW_VERTEX_PROJECT_ID"]) == "aw-test-project" &&
      one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.value if e.name == "AW_VERTEX_LOCATION"]) == "global"
    )
    error_message = "web must receive AW_VERTEX_PROJECT_ID = project_id and AW_VERTEX_LOCATION = global by default"
  }
}

run "vertex_location_reaches_web" {
  command = plan

  variables {
    vertex_location = "eu"
  }

  assert {
    condition     = one([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.value if e.name == "AW_VERTEX_LOCATION"]) == "eu"
    error_message = "vertex_location must reach web as AW_VERTEX_LOCATION"
  }
}

run "vertex_location_outside_global_us_eu_is_refused" {
  command = plan

  variables {
    vertex_location = "asia"
  }

  expect_failures = [var.vertex_location]
}

run "by_default_the_log_metrics_and_the_dashboard_exist_and_nothing_notifies" {
  command = plan

  assert {
    condition = (
      length(google_logging_metric.main) == 4 &&
      google_logging_metric.main["web-5xx"].name == "agent-workspace-web-5xx" &&
      google_logging_metric.main["gateway-5xx"].name == "agent-workspace-gateway-5xx" &&
      google_logging_metric.main["gateway-upstream-errors"].name == "agent-workspace-gateway-upstream-errors" &&
      google_logging_metric.main["runner-mgr-failures"].name == "agent-workspace-runner-mgr-failures"
    )
    error_message = "the four log-based metrics must exist, named with the install prefix"
  }

  assert {
    condition = alltrue([
      for m in google_logging_metric.main :
      m.metric_descriptor[0].metric_kind == "DELTA" && m.metric_descriptor[0].value_type == "INT64" && m.metric_descriptor[0].unit == "1"
    ])
    error_message = "each log metric must declare DELTA, INT64, unit 1"
  }

  assert {
    condition     = google_monitoring_dashboard.main.dashboard_json != ""
    error_message = "the dashboard must exist"
  }

  assert {
    condition = (
      length(google_monitoring_notification_channel.email) == 0 &&
      length(google_monitoring_alert_policy.main) == 0 &&
      length(google_monitoring_uptime_check_config.web_readyz) == 0
    )
    error_message = "without alerts_email there must be no channel, alert policy or uptime check"
  }
}

run "the_dashboard_json_decodes_and_holds_no_positions" {
  command = plan

  assert {
    condition     = length(jsondecode(google_monitoring_dashboard.main.dashboard_json).gridLayout.widgets) == 13
    error_message = "the dashboard must hold 13 charts: 4 log metrics, 3 latencies, 3 instance counts, SQL CPU and disk, live sandboxes"
  }

  assert {
    condition     = !strcontains(google_monitoring_dashboard.main.dashboard_json, "xPos") && !strcontains(google_monitoring_dashboard.main.dashboard_json, "yPos")
    error_message = "the dashboard must not write xPos or yPos"
  }

  assert {
    condition     = jsondecode(google_monitoring_dashboard.main.dashboard_json).displayName == "agent-workspace"
    error_message = "the dashboard is named with the install prefix"
  }
}

# The provider compares dashboard_json by value after dropping keys the config omits, so a value
# whose type differs from the API's read-back (columns 2 against "2") makes every plan after the
# first show a diff. The dashboard must be written in the API's canonical form.
run "the_dashboard_json_is_written_in_the_api_canonical_form" {
  command = plan

  assert {
    condition     = jsondecode(google_monitoring_dashboard.main.dashboard_json).gridLayout.columns == "2"
    error_message = "gridLayout.columns must be the string \"2\", as the Monitoring API reads it back"
  }

  assert {
    condition     = !strcontains(google_monitoring_dashboard.main.dashboard_json, "\"columns\":2")
    error_message = "gridLayout.columns must not be written as a JSON number"
  }

  assert {
    condition = alltrue(flatten([
      for widget in jsondecode(google_monitoring_dashboard.main.dashboard_json).gridLayout.widgets : [
        for data_set in widget.xyChart.dataSets :
        lookup(data_set, "plotType", "") == "LINE" && lookup(data_set, "targetAxis", "") == "Y1"
      ]
    ]))
    error_message = "every xyChart dataSet must set plotType LINE and targetAxis Y1, the defaults the API fills in"
  }
}

run "alerts_email_creates_one_channel_seven_policies_and_the_uptime_policy" {
  command = plan

  variables {
    alerts_email = "oncall@example.com"
  }

  assert {
    condition = (
      length(google_monitoring_notification_channel.email) == 1 &&
      google_monitoring_notification_channel.email[0].type == "email" &&
      google_monitoring_notification_channel.email[0].labels.email_address == "oncall@example.com"
    )
    error_message = "one email channel naming the address must exist"
  }

  assert {
    condition     = length(google_monitoring_alert_policy.main) == 8
    error_message = "seven metric/SQL/sandbox policies plus one uptime policy must exist"
  }

  assert {
    condition = alltrue([
      for p in google_monitoring_alert_policy.main :
      length(p.notification_channels) == 1 && p.combiner == "OR" && startswith(p.display_name, "agent-workspace ")
    ])
    error_message = "every policy must name the channel, combine with OR and start with the install name"
  }

  assert {
    condition = (
      google_monitoring_uptime_check_config.web_readyz[0].http_check[0].path == "/api/readyz" &&
      google_monitoring_uptime_check_config.web_readyz[0].http_check[0].port == 443 &&
      google_monitoring_uptime_check_config.web_readyz[0].monitored_resource[0].labels.host == "agent-workspace-web-123456789012.asia-northeast1.run.app"
    )
    error_message = "the uptime check must probe /api/readyz on 443 at the host of web_url"
  }
}

run "the_uptime_host_is_the_domain_when_one_is_set" {
  command = plan

  variables {
    alerts_email = "oncall@example.com"
    domain       = "app.example.com"
  }

  assert {
    condition     = google_monitoring_uptime_check_config.web_readyz[0].monitored_resource[0].labels.host == "app.example.com"
    error_message = "the uptime host must be the domain"
  }
}

run "iap_creates_no_uptime_check_and_no_uptime_policy" {
  command = plan

  variables {
    alerts_email = "oncall@example.com"
    domain       = "app.example.com"
    iap          = true
  }

  assert {
    condition = (
      length(google_monitoring_uptime_check_config.web_readyz) == 0 &&
      length(google_monitoring_alert_policy.main) == 7
    )
    error_message = "behind IAP there must be no uptime check and no uptime policy"
  }
}

run "the_standard_size_alerts_at_100_sandboxes" {
  command = plan

  variables {
    alerts_email = "oncall@example.com"
    size         = "standard"
  }

  assert {
    condition     = google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].threshold_value == 100
    error_message = "the standard sandbox alert threshold is 100"
  }
}

run "the_small_size_alerts_at_20_sandboxes" {
  command = plan

  variables {
    alerts_email = "oncall@example.com"
  }

  assert {
    condition     = google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].threshold_value == 20
    error_message = "the small sandbox alert threshold is 20"
  }
}

run "the_sandbox_alert_counts_services_not_series" {
  command = plan

  variables {
    alerts_email = "oncall@example.com"
  }

  assert {
    condition = (
      strcontains(google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].filter, "metric.labels.state=\"active\"") &&
      length(google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].aggregations) == 2 &&
      google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].aggregations[0].cross_series_reducer == "REDUCE_SUM" &&
      google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].aggregations[0].group_by_fields == tolist(["resource.label.service_name"]) &&
      google_monitoring_alert_policy.main["live-sandboxes"].conditions[0].condition_threshold[0].aggregations[1].cross_series_reducer == "REDUCE_COUNT"
    )
    error_message = "the live-sandboxes alert must sum active instances per service, then count the services"
  }
}

run "an_invalid_alerts_email_is_refused" {
  command = plan

  variables {
    alerts_email = "not-an-email"
  }

  expect_failures = [var.alerts_email]
}

# ── Sandbox internet (D-7 amendment) ──────────────────────────────────────────────────────────────

run "sandbox_internet_off_creates_nothing_new" {
  command = plan

  assert {
    condition = alltrue([
      length(google_compute_instance_template.egress_proxy) == 0,
      length(google_compute_instance_group_manager.egress_proxy) == 0,
      length(google_compute_subnetwork.egress_proxy) == 0,
      length(google_compute_health_check.egress_proxy) == 0,
      length(google_compute_address.egress_proxy) == 0,
      length(google_compute_router.egress) == 0,
      length(google_compute_router_nat.egress) == 0,
      length(google_compute_firewall.sandbox_allow_egress_proxy) == 0,
      length(google_compute_firewall.sandbox_deny_egress_proxy_other) == 0,
      length(google_compute_firewall.egress_proxy_allow_sandboxes) == 0,
      length(google_compute_firewall.egress_proxy_allow_health_checks) == 0,
      length(google_compute_firewall.egress_proxy_deny_private) == 0,
      length(google_compute_firewall.egress_proxy_deny_private_ipv6) == 0,
      length(google_service_account.egress_proxy) == 0,
      length(google_project_iam_member.egress_proxy_log_writer) == 0,
      length(google_artifact_registry_repository_iam_member.egress_proxy_reader) == 0,
      length(random_password.egress_credential_key) == 0,
      length(google_secret_manager_secret.egress_credential_key) == 0,
      length(google_secret_manager_secret_version.egress_credential_key) == 0,
      length(google_secret_manager_secret_iam_member.egress_proxy_key_access) == 0,
      length(google_secret_manager_secret_iam_member.runner_manager_egress_key_access) == 0,
      length(data.google_compute_zones.egress) == 0,
    ])
    error_message = "with sandbox_internet false no proxy, NAT, firewall rule, identity or key secret may exist"
  }

  assert {
    condition = length(setintersection(
      toset(concat(
        [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.name],
        [for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name],
      )),
      toset(["RUNTIME_EGRESS_PROXY_URL", "RUNTIME_EGRESS_PROXY_KEY", "RUNTIME_PROXY_BYPASS"]),
    )) == 0
    error_message = "the runner manager and web must carry no egress proxy env when sandbox_internet is false"
  }

  assert {
    condition     = output.egress_proxy_address == ""
    error_message = "egress_proxy_address must be empty when sandbox_internet is false"
  }

  assert {
    condition = google_compute_firewall.sandbox_deny_egress.destination_ranges == toset([
      "128.0.0.0/1", "64.0.0.0/2", "32.0.0.0/3", "16.0.0.0/4", "0.0.0.0/5", "12.0.0.0/6", "8.0.0.0/7", "11.0.0.0/8",
      "10.128.0.0/9", "10.64.0.0/10", "10.32.0.0/11", "10.16.0.0/12", "10.0.0.0/13", "10.12.0.0/14", "10.8.0.0/15",
      "10.11.0.0/16", "10.10.128.0/17", "10.10.64.0/18", "10.10.32.0/19", "10.10.16.0/20", "10.10.8.0/21",
      "10.10.4.0/22", "10.10.2.0/23", "10.10.1.0/24", "10.10.0.128/25", "10.10.0.64/26", "10.10.0.0/27",
      "10.10.0.32/28", "10.10.0.56/29", "10.10.0.52/30", "10.10.0.48/31", "10.10.0.51/32",
    ])
    error_message = "the catch-all deny must be unchanged when sandbox_internet is false"
  }
}

# A stale pin: gcp.sandboxInternet was turned off, but EGRESS_PROXY_IMAGE stayed in .env and a render
# pinned images.egress_proxy again. It must create nothing, refuse nothing and leave web's env as is,
# even from a repository outside project_id.
run "sandbox_internet_off_ignores_a_stale_egress_proxy_pin" {
  command = plan

  variables {
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "asia-northeast1-docker.pkg.dev/another-project/agent-workspace/egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    }
  }

  assert {
    condition = alltrue([
      length(google_compute_instance_template.egress_proxy) == 0,
      length(google_compute_address.egress_proxy) == 0,
      length(google_artifact_registry_repository_iam_member.egress_proxy_reader) == 0,
      length(google_secret_manager_secret.egress_credential_key) == 0,
      length(google_compute_router_nat.egress) == 0,
    ])
    error_message = "a stale images.egress_proxy pin with sandbox_internet false must create nothing"
  }

  assert {
    condition = !contains(
      [for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name],
      "RUNTIME_EGRESS_PROXY_URL",
    )
    error_message = "a stale images.egress_proxy pin must not give web RUNTIME_EGRESS_PROXY_URL"
  }
}

run "sandbox_internet_on_creates_the_proxy_vm_nat_and_firewall" {
  command = plan

  variables {
    sandbox_internet = true
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    }
  }

  override_resource {
    override_during = plan
    target          = google_compute_address.egress_proxy
    values = {
      address = "10.10.0.60"
    }
  }

  assert {
    condition = (
      length(google_compute_instance_template.egress_proxy[0].network_interface[0].access_config) == 0 &&
      google_compute_instance_template.egress_proxy[0].machine_type == "e2-small" &&
      google_compute_instance_template.egress_proxy[0].tags == toset(["aw-egress-proxy"]) &&
      google_compute_instance_template.egress_proxy[0].shielded_instance_config[0].enable_secure_boot &&
      google_compute_instance_template.egress_proxy[0].shielded_instance_config[0].enable_vtpm &&
      google_compute_instance_template.egress_proxy[0].shielded_instance_config[0].enable_integrity_monitoring &&
      google_compute_instance_template.egress_proxy[0].metadata["enable-oslogin"] == "TRUE" &&
      google_compute_instance_template.egress_proxy[0].metadata["block-project-ssh-keys"] == "TRUE" &&
      google_compute_instance_template.egress_proxy[0].metadata["serial-port-enable"] == "FALSE" &&
      google_compute_instance_template.egress_proxy[0].metadata["google-logging-enabled"] == "true" &&
      !contains(keys(google_compute_instance_template.egress_proxy[0].metadata), "gce-container-declaration")
    )
    error_message = "the proxy VM must have no external IP, Shielded VM, OS Login, the serial port off and logging on, and must not use the deprecated container declaration"
  }

  assert {
    condition = (
      strcontains(base64decode(regex("aw-egress-proxy.service\n.*\n.*\n    encoding: b64\n    content: (\\S+)", google_compute_instance_template.egress_proxy[0].metadata["user-data"])[0]), "EGRESS_MODE=shared") &&
      strcontains(base64decode(regex("aw-egress-proxy.service\n.*\n.*\n    encoding: b64\n    content: (\\S+)", google_compute_instance_template.egress_proxy[0].metadata["user-data"])[0]), "egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555") &&
      strcontains(base64decode(regex("aw-egress-proxy.service\n.*\n.*\n    encoding: b64\n    content: (\\S+)", google_compute_instance_template.egress_proxy[0].metadata["user-data"])[0]), "--read-only --user 1000:1000")
    )
    error_message = "user-data must run the digest-pinned egress image in shared mode, read-only, as uid 1000"
  }

  # Container-Optimized OS: the host firewall drops inbound connections except SSH, the root file
  # system is read-only and /usr is not merged. Live run 42239414765 got no TCP answer from the proxy
  # VM on 3128 at all; these pin what makes the listener reachable and the unit startable.
  assert {
    condition = (
      strcontains(local.egress_proxy_unit, "--network host") &&
      !strcontains(local.egress_proxy_unit, " -p ") &&
      strcontains(local.egress_proxy_unit, "-e HOST=0.0.0.0 -e PORT=3128") &&
      strcontains(local.egress_proxy_prepare, "iptables -w -C INPUT -p tcp --dport 3128 -j ACCEPT") &&
      strcontains(local.egress_proxy_prepare, "iptables -w -A INPUT -p tcp --dport 3128 -j ACCEPT")
    )
    error_message = "the proxy must listen on 0.0.0.0:3128 on the host network, with tcp 3128 opened in the Container-Optimized OS host firewall"
  }

  assert {
    condition = (
      strcontains(local.egress_proxy_unit, "StateDirectory=aw-egress") &&
      strcontains(local.egress_proxy_unit, "Environment=HOME=/var/lib/aw-egress") &&
      !strcontains(local.egress_proxy_unit, "/usr/bin/mkdir") &&
      length(regexall("(?m)^Exec[A-Za-z]+=-?/", local.egress_proxy_unit)) == length(regexall("(?m)^Exec[A-Za-z]+=-?(/usr/bin/docker |/bin/bash )", local.egress_proxy_unit)) &&
      strcontains(google_compute_instance_template.egress_proxy[0].metadata["user-data"], "path: /etc/aw-egress/prepare.sh") &&
      strcontains(google_compute_instance_template.egress_proxy[0].metadata["user-data"], "path: /etc/aw-egress/report-exit.sh")
    )
    error_message = "the unit may call only /usr/bin/docker and /bin/bash by absolute path, and systemd must create the writable HOME the credential helper writes to"
  }

  assert {
    condition = (
      google_compute_instance_template.egress_proxy[0].metadata["enable-guest-attributes"] == "TRUE" &&
      strcontains(local.egress_proxy_prepare, "guest-attributes/aw-egress/") &&
      strcontains(local.egress_proxy_prepare, "report prepare ok") &&
      !strcontains(local.egress_proxy_prepare, "report prepare \"$token") &&
      strcontains(local.egress_proxy_unit, "ExecStopPost=/bin/bash /etc/aw-egress/report-exit.sh")
    )
    error_message = "the proxy VM must report its prepare steps and the container's exit to guest attributes"
  }

  assert {
    condition = (
      google_compute_instance_group_manager.egress_proxy[0].target_size == 1 &&
      length(google_compute_instance_group_manager.egress_proxy[0].auto_healing_policies) == 1 &&
      google_compute_instance_group_manager.egress_proxy[0].zone == "asia-northeast1-a" &&
      google_compute_health_check.egress_proxy[0].http_health_check[0].port == 3128 &&
      google_compute_health_check.egress_proxy[0].http_health_check[0].request_path == "/healthz" &&
      google_compute_instance_template.egress_proxy[0].network_interface[0].network_ip == google_compute_address.egress_proxy[0].address &&
      google_compute_instance_template.egress_proxy[0].network_interface[0].subnetwork == google_compute_subnetwork.egress_proxy[0].id &&
      !google_compute_subnetwork.egress_proxy[0].private_ip_google_access
    )
    error_message = "the proxy must be one autohealed VM that takes its reserved internal address from the template, on a subnet without Private Google Access"
  }

  assert {
    condition = (
      google_compute_router_nat.egress[0].source_subnetwork_ip_ranges_to_nat == "LIST_OF_SUBNETWORKS" &&
      google_compute_router_nat.egress[0].nat_ip_allocate_option == "AUTO_ONLY" &&
      length(google_compute_router_nat.egress[0].subnetwork) == 1 &&
      one(google_compute_router_nat.egress[0].subnetwork).name == google_compute_subnetwork.egress_proxy[0].id &&
      one(google_compute_router_nat.egress[0].subnetwork).source_ip_ranges_to_nat == toset(["PRIMARY_IP_RANGE"])
    )
    error_message = "Cloud NAT must serve only the proxy subnet's primary range"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_allow_egress_proxy[0].direction == "EGRESS" &&
      google_compute_firewall.sandbox_allow_egress_proxy[0].priority == 0 &&
      google_compute_firewall.sandbox_allow_egress_proxy[0].target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_allow_egress_proxy[0].destination_ranges == toset(["10.10.0.60/32"]) &&
      flatten([for a in google_compute_firewall.sandbox_allow_egress_proxy[0].allow : tolist(a.ports)]) == ["3128"]
    )
    error_message = "sandboxes must be allowed tcp 3128 to the proxy's /32 at priority 0"
  }

  assert {
    condition = (
      google_compute_firewall.sandbox_deny_egress_proxy_other[0].priority == 0 &&
      google_compute_firewall.sandbox_deny_egress_proxy_other[0].target_tags == toset(["aw-sandbox"]) &&
      google_compute_firewall.sandbox_deny_egress_proxy_other[0].destination_ranges == toset(["10.10.0.60/32"]) &&
      toset([for d in google_compute_firewall.sandbox_deny_egress_proxy_other[0].deny : d.protocol]) == toset(["tcp", "udp", "icmp", "sctp", "esp", "ah"]) &&
      toset(flatten([for d in google_compute_firewall.sandbox_deny_egress_proxy_other[0].deny : d.ports == null ? [] : tolist(d.ports)])) == toset(["0-3127", "3129-65535"])
    )
    error_message = "every other port and protocol to the proxy must be denied"
  }

  assert {
    condition = (
      !contains(google_compute_firewall.sandbox_deny_egress.destination_ranges, "0.0.0.0/0") &&
      !contains(google_compute_firewall.sandbox_deny_egress.destination_ranges, "10.10.0.60/32") &&
      !contains(google_compute_firewall.sandbox_deny_egress.destination_ranges, "10.10.0.50/32") &&
      !contains(google_compute_firewall.sandbox_deny_egress.destination_ranges, "10.10.0.56/29") &&
      google_compute_firewall.sandbox_deny_egress.destination_ranges == toset([
        "128.0.0.0/1", "64.0.0.0/2", "32.0.0.0/3", "16.0.0.0/4", "0.0.0.0/5", "12.0.0.0/6", "8.0.0.0/7", "11.0.0.0/8",
        "10.128.0.0/9", "10.64.0.0/10", "10.32.0.0/11", "10.16.0.0/12", "10.0.0.0/13", "10.12.0.0/14", "10.8.0.0/15",
        "10.11.0.0/16", "10.10.128.0/17", "10.10.64.0/18", "10.10.32.0/19", "10.10.16.0/20", "10.10.8.0/21",
        "10.10.4.0/22", "10.10.2.0/23", "10.10.1.0/24", "10.10.0.128/25", "10.10.0.64/26", "10.10.0.0/27",
        "10.10.0.32/28", "10.10.0.52/30", "10.10.0.48/31", "10.10.0.51/32",
        "10.10.0.56/30", "10.10.0.62/31", "10.10.0.61/32",
      ])
    )
    error_message = "the catch-all deny must cover 0.0.0.0/0 minus the gateway's /32 and the proxy's /32"
  }

  assert {
    condition = (
      google_compute_firewall.egress_proxy_allow_sandboxes[0].direction == "INGRESS" &&
      google_compute_firewall.egress_proxy_allow_sandboxes[0].target_tags == toset(["aw-egress-proxy"]) &&
      google_compute_firewall.egress_proxy_allow_sandboxes[0].source_ranges == toset([google_compute_subnetwork.sandbox[0].ip_cidr_range]) &&
      flatten([for a in google_compute_firewall.egress_proxy_allow_sandboxes[0].allow : tolist(a.ports)]) == ["3128"] &&
      google_compute_firewall.egress_proxy_allow_health_checks[0].direction == "INGRESS" &&
      google_compute_firewall.egress_proxy_allow_health_checks[0].target_tags == toset(["aw-egress-proxy"]) &&
      google_compute_firewall.egress_proxy_allow_health_checks[0].source_ranges == toset(["35.191.0.0/16", "130.211.0.0/22"]) &&
      flatten([for a in google_compute_firewall.egress_proxy_allow_health_checks[0].allow : tolist(a.ports)]) == ["3128"]
    )
    error_message = "ingress to the proxy must come only from the sandbox range and the health-check ranges, on 3128"
  }

  assert {
    condition = (
      google_compute_firewall.egress_proxy_deny_private[0].direction == "EGRESS" &&
      google_compute_firewall.egress_proxy_deny_private[0].priority == 0 &&
      google_compute_firewall.egress_proxy_deny_private[0].target_tags == toset(["aw-egress-proxy"]) &&
      google_compute_firewall.egress_proxy_deny_private[0].destination_ranges == toset([
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "199.36.153.4/30", "199.36.153.8/30",
      ]) &&
      [for d in google_compute_firewall.egress_proxy_deny_private[0].deny : d.protocol] == ["all"] &&
      google_compute_firewall.egress_proxy_deny_private_ipv6[0].target_tags == toset(["aw-egress-proxy"]) &&
      google_compute_firewall.egress_proxy_deny_private_ipv6[0].destination_ranges == toset(["::/0"]) &&
      [for d in google_compute_firewall.egress_proxy_deny_private_ipv6[0].deny : d.protocol] == ["all"]
    )
    error_message = "the proxy VM must be denied the private ranges, the Google VIPs and all IPv6"
  }

  assert {
    condition = (
      google_project_iam_member.egress_proxy_log_writer[0].role == "roles/logging.logWriter" &&
      google_artifact_registry_repository_iam_member.egress_proxy_reader[0].role == "roles/artifactregistry.reader" &&
      google_artifact_registry_repository_iam_member.egress_proxy_reader[0].repository == "agent-workspace" &&
      google_artifact_registry_repository_iam_member.egress_proxy_reader[0].location == "asia-northeast1" &&
      google_secret_manager_secret_iam_member.egress_proxy_key_access[0].role == "roles/secretmanager.secretAccessor"
    )
    error_message = "the proxy identity holds logging.logWriter and repository- and secret-scoped reads only"
  }

  assert {
    condition = (
      [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value if e.name == "RUNTIME_EGRESS_PROXY_URL"] == ["http://10.10.0.60:3128"] &&
      [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value if e.name == "RUNTIME_PROXY_BYPASS"] == ["10.10.0.50"] &&
      [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].secret if e.name == "RUNTIME_EGRESS_PROXY_KEY"] == ["agent-workspace-egress-credential-key"] &&
      [for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].version if e.name == "RUNTIME_EGRESS_PROXY_KEY"] == ["1"] &&
      [for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.value if e.name == "RUNTIME_EGRESS_PROXY_URL"] == ["http://10.10.0.60:3128"]
    )
    error_message = "the runner manager must get the proxy URL, key and bypass, and web the proxy URL"
  }

  assert {
    condition     = output.egress_proxy_address == "10.10.0.60"
    error_message = "egress_proxy_address must be the proxy's internal address"
  }
}

run "sandbox_internet_without_an_egress_proxy_image_is_refused" {
  command = plan

  variables {
    sandbox_internet = true
  }

  expect_failures = [terraform_data.input_checks]
}

run "sandbox_internet_with_an_egress_proxy_image_outside_the_project_is_refused" {
  command = plan

  variables {
    sandbox_internet = true
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "asia-northeast1-docker.pkg.dev/someone-elses-project/images/egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    }
  }

  expect_failures = [terraform_data.input_checks]
}

run "sandbox_internet_with_an_adopted_network_is_refused" {
  command = plan

  variables {
    sandbox_internet = true
    network          = "projects/aw-test-project/global/networks/existing"
    subnetwork       = "projects/aw-test-project/regions/asia-northeast1/subnetworks/existing-services"
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/egress-proxy@sha256:5555555555555555555555555555555555555555555555555555555555555555"
    }
  }

  expect_failures = [terraform_data.input_checks]
}

run "a_non_digest_egress_proxy_image_is_refused" {
  command = plan

  variables {
    images = {
      web          = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime      = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      egress_proxy = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/egress-proxy:latest"
    }
  }

  expect_failures = [var.images]
}

# ── Apps and tool sandboxes (apps.tf) ─────────────────────────────────────────────────────────────

run "without_apps_nothing_app_related_exists_and_the_dashboard_is_unchanged" {
  command = plan

  assert {
    condition = (
      length(google_cloud_run_v2_service.app) == 0 &&
      length(google_cloud_run_v2_job.app_role) == 0 &&
      length(google_service_account.app) == 0 &&
      length(google_service_account.app_roles) == 0 &&
      length(google_secret_manager_secret.app) == 0 &&
      length(google_secret_manager_secret.db_password) == 0 &&
      length(output.app_urls) == 0 &&
      !contains(keys(google_logging_metric.main), "apps-5xx")
    )
    error_message = "apps = {} must create no app resource, secret, service account or metric, and app_urls is empty"
  }

  assert {
    condition     = length(jsondecode(google_monitoring_dashboard.main.dashboard_json).gridLayout.widgets) == 13 && jsondecode(google_monitoring_dashboard.main.dashboard_json).gridLayout.columns == "2"
    error_message = "without apps the dashboard keeps its 13 charts and canonical form"
  }
}

run "one_app_is_internal_only_always_on_and_invokable_by_allusers" {
  command = plan

  variables {
    apps = {
      crm = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  assert {
    condition = (
      google_cloud_run_v2_service.app["crm"].name == "agent-workspace-app-crm" &&
      google_cloud_run_v2_service.app["crm"].ingress == "INGRESS_TRAFFIC_INTERNAL_ONLY" &&
      google_cloud_run_v2_service.app["crm"].deletion_protection == true &&
      google_cloud_run_v2_service.app["crm"].scaling[0].min_instance_count == 1 &&
      google_cloud_run_v2_service.app["crm"].template[0].scaling[0].min_instance_count == 1 &&
      google_cloud_run_v2_service.app["crm"].template[0].containers[0].resources[0].cpu_idle == false &&
      google_cloud_run_v2_service.app["crm"].template[0].containers[0].startup_probe[0].http_get[0].path == "/api/health" &&
      google_cloud_run_v2_service.app["crm"].template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
    )
    error_message = "an app is an internal-only, always-on (CPU always allocated) service probed on /api/health"
  }

  assert {
    condition = (
      google_cloud_run_v2_service_iam_member.app_public["crm"].member == "allUsers" &&
      google_cloud_run_v2_service_iam_member.app_public["crm"].role == "roles/run.invoker"
    )
    error_message = "an app is invokable by allUsers (ingress is the gate)"
  }

  assert {
    condition = (
      anytrue([for c in google_cloud_run_v2_service.app["crm"].template[0].containers : c.name == "cloud-sql-proxy" && contains(c.args, "--private-ip")]) &&
      contains([for e in google_cloud_run_v2_service.app["crm"].template[0].containers[0].env : e.name], "AW_APP_MIGRATE_ON_START") &&
      contains([for e in google_cloud_run_v2_service.app["crm"].template[0].containers[0].env : e.name], "AW_APP_IDENTITY_SECRET") &&
      contains([for e in google_cloud_run_v2_service.app["crm"].template[0].containers[0].env : e.name], "DATABASE_URL")
    )
    error_message = "the app runs the private-IP Cloud SQL proxy sidecar and gets its database url, identity secret and migrate switch"
  }

  assert {
    condition     = length(google_compute_url_map.web) == 0 && length(google_compute_managed_ssl_certificate.app) == 0
    error_message = "without a domain no host rule or certificate exists"
  }

  assert {
    condition     = contains(keys(google_logging_metric.main), "apps-5xx") && length(jsondecode(google_monitoring_dashboard.main.dashboard_json).gridLayout.widgets) == 14
    error_message = "apps add the apps-5xx metric and one dashboard chart"
  }
}

run "the_app_service_account_holds_only_a_conditioned_cloud_sql_client_and_its_two_secrets" {
  command = plan

  variables {
    apps = {
      crm = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  assert {
    condition = (
      google_project_iam_member.app_cloudsql_client["crm"].role == "roles/cloudsql.client" &&
      strcontains(google_project_iam_member.app_cloudsql_client["crm"].condition[0].expression, "projects/aw-test-project/instances/agent-workspace-pg") &&
      length([for k, m in google_project_iam_member.app_cloudsql_client : k]) == 1
    )
    error_message = "the app's only project role is cloudsql.client, conditioned on this stack's instance"
  }

  assert {
    condition = (
      toset(keys(google_secret_manager_secret_iam_member.app_access)) == toset(["crm/database-url", "crm/identity-secret"]) &&
      alltrue([for _, m in google_secret_manager_secret_iam_member.app_access : m.role == "roles/secretmanager.secretAccessor"])
    )
    error_message = "the app reads exactly its database url and identity secret"
  }

  assert {
    condition = (
      google_secret_manager_secret_iam_member.app_roles_db_password[0].secret_id == "agent-workspace-db-password" &&
      toset(keys(google_secret_manager_secret_iam_member.app_roles_app_password)) == toset(["crm"])
    )
    error_message = "the role job's service account reads the owner password secret and the app's password secret only"
  }
}

run "the_role_job_runs_on_google_beta_with_an_execution_token" {
  command = plan

  variables {
    apps = {
      crm = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.app_role["crm"].run_execution_token) == 32 &&
      google_cloud_run_v2_job.app_role["crm"].template[0].template[0].max_retries == 1 &&
      google_cloud_run_v2_job.app_role["crm"].template[0].template[0].timeout == "300s" &&
      startswith(google_cloud_run_v2_job.app_role["crm"].template[0].template[0].containers[0].image, "docker.io/library/postgres:18-alpine@sha256:")
    )
    error_message = "the role job carries a 32-character run_execution_token, one retry, a 300 s timeout and the pinned PostgreSQL client"
  }

  assert {
    condition = (
      google_cloud_run_v2_job.app_role["crm"].name == "agent-workspace-r-${substr(sha256("crm"), 0, 5)}" &&
      google_cloud_run_v2_job.app_role["crm"].labels["aw-app"] == "crm"
    )
    error_message = "the role job is named <name>-r-<5 hex of the app name's sha256> and labelled with its app"
  }
}

# Live failure (run 42452148886): Cloud Run names an execution <job name>-<run_execution_token> and
# refuses 64 characters or more. With the longest name aw deploy renders (19, moduleResourceName)
# and the longest app name (25), every job with a run_execution_token (only the role job today) and
# every other per-app name must still fit Google's limits.
run "the_longest_stack_and_app_names_fit_every_google_name_limit" {
  command = plan

  variables {
    name   = "abcdefghijklmnopqrs"
    domain = "app.example.com"
    apps = {
      "a234567890123456789012345" = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_a234567890123456789012345;"
      }
    }
  }

  assert {
    condition     = length(var.name) == 19 && alltrue([for key, _ in var.apps : length(key) == 25])
    error_message = "the run uses a 19-character name and a 25-character app name"
  }

  assert {
    condition = alltrue([
      for _, job in google_cloud_run_v2_job.app_role :
      length(job.name) + 1 + length(job.run_execution_token) < 64 && length(job.name) + 33 < 64
    ])
    error_message = "every job execution name (<job name>-<32-hex run_execution_token>) is under 64 characters"
  }

  assert {
    condition = (
      alltrue([for _, svc in google_cloud_run_v2_service.app : length(svc.name) <= 49]) &&
      alltrue([for _, sa in google_service_account.app : length(sa.account_id) >= 6 && length(sa.account_id) <= 30]) &&
      alltrue([for _, sa in google_service_account.app_roles : length(sa.account_id) >= 6 && length(sa.account_id) <= 30]) &&
      alltrue([for _, secret in google_secret_manager_secret.app : length(secret.secret_id) <= 255]) &&
      alltrue([for _, neg in google_compute_region_network_endpoint_group.app : length(neg.name) <= 63]) &&
      alltrue([for _, backend in google_compute_backend_service.app : length(backend.name) <= 63]) &&
      alltrue([for _, cert in google_compute_managed_ssl_certificate.app : length(cert.name) <= 63]) &&
      alltrue([for _, user in local.app_pg_user : length(user) <= 63])
    )
    error_message = "every per-app name fits Google's limit: service 49, account id 6-30, secret id 255, Compute 63, PostgreSQL role 63"
  }
}

run "an_app_name_ending_in_a_hyphen_is_refused" {
  command = plan

  variables {
    apps = {
      "crm-" = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm_;"
      }
    }
  }

  expect_failures = [var.apps]
}

run "an_app_name_starting_with_a_digit_is_accepted_as_the_cli_accepts_it" {
  command = plan

  variables {
    apps = {
      "2fa" = {
        image    = "docker.io/example/twofa@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://twofa.example.com"
        role_sql = "create role app_2fa;"
      }
    }
  }

  assert {
    condition     = google_cloud_run_v2_service.app["2fa"].name == "agent-workspace-app-2fa"
    error_message = "an app name may start with a digit: the service name still starts with the stack name"
  }
}

run "an_app_behind_a_domain_gets_load_balancer_ingress_and_a_host_rule" {
  command = plan

  variables {
    domain = "app.example.com"
    apps = {
      crm = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  assert {
    condition = (
      google_cloud_run_v2_service.app["crm"].ingress == "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER" &&
      one(google_compute_managed_ssl_certificate.app["crm"].managed[0].domains) == "crm.example.com" &&
      one(google_compute_managed_ssl_certificate.web[0].managed[0].domains) == "app.example.com" &&
      length(google_compute_url_map.web[0].host_rule) == 1 &&
      one([for r in google_compute_url_map.web[0].host_rule : one(r.hosts)]) == "crm.example.com" &&
      google_compute_backend_service.app["crm"].load_balancing_scheme == "EXTERNAL_MANAGED"
    )
    error_message = "with a domain the app takes load balancer ingress, its own certificate, backend and a host rule"
  }
}

run "an_app_host_equal_to_the_domain_is_refused" {
  command = plan

  variables {
    domain = "app.example.com"
    apps = {
      crm = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://app.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  expect_failures = [terraform_data.apps_checks]
}

run "an_app_image_tag_is_refused" {
  command = plan

  variables {
    apps = {
      crm = {
        image    = "docker.io/example/crm:latest"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  expect_failures = [var.apps]
}

run "a_forty_character_app_name_is_refused" {
  command = plan

  variables {
    apps = {
      "a123456789012345678901234567890123456789" = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "https://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  expect_failures = [var.apps]
}

run "a_non_https_app_url_is_refused" {
  command = plan

  variables {
    apps = {
      crm = {
        image    = "docker.io/example/crm@sha256:6666666666666666666666666666666666666666666666666666666666666666"
        url      = "http://crm.example.com"
        role_sql = "create role app_crm;"
      }
    }
  }

  expect_failures = [var.apps]
}

run "the_custom_role_ids_carry_a_per_install_suffix" {
  command = plan

  override_resource {
    target          = random_id.role_suffix
    override_during = plan
    values          = { hex = "a1b2c3" }
  }

  assert {
    condition = (
      endswith(google_project_iam_custom_role.runner_manager.role_id, "_a1b2c3") &&
      endswith(google_project_iam_custom_role.runner_manager_invoker.role_id, "_a1b2c3")
    )
    error_message = "custom role ids need a random per-install suffix: GCP reserves deleted role ids"
  }
}

run "the_runner_manager_holds_no_permission_on_jobs" {
  command = plan

  override_resource {
    target          = random_id.role_suffix
    override_during = plan
    values          = { hex = "a1b2c3" }
  }

  assert {
    condition = alltrue([
      for p in concat(
        tolist(google_project_iam_custom_role.runner_manager.permissions),
        tolist(google_project_iam_custom_role.runner_manager_invoker.permissions),
      ) : !startswith(p, "run.jobs.")
    ])
    error_message = "the runner manager's custom roles must hold no run.jobs.* permission"
  }

  assert {
    condition = alltrue([
      for m in [
        google_project_iam_member.runner_manager_run_developer,
        google_project_iam_member.runner_manager_run_invoker,
      ] : !contains(["roles/run.developer", "roles/run.invoker"], m.role)
    ])
    error_message = "the runner manager must not hold the predefined run.developer or run.invoker role"
  }
}

run "the_runner_manager_may_invoke_only_sandbox_hosts" {
  command = plan

  # Live run 42577620759: Cloud Run evaluates request.host on a project-level invoke binding and
  # offers no resource.type or resource.name at invoke, so a name condition would let the manager
  # invoke web, the gateway and the apps. The grant is conditioned on a sandbox's run.app host.
  assert {
    condition = (
      google_project_iam_member.runner_manager_run_invoker.member == google_service_account.runner_manager.member &&
      google_project_iam_member.runner_manager_run_invoker.condition[0].title == "sandbox-hosts-only" &&
      trimspace(google_project_iam_member.runner_manager_run_invoker.condition[0].expression) == "request.host.startsWith(\"rt-\") && request.host.endsWith(\".run.app\")"
    )
    error_message = "the runner manager's invoke grant is conditioned on an rt- run.app host and nothing wider"
  }

  assert {
    condition = (
      !strcontains(google_project_iam_member.runner_manager_run_invoker.condition[0].expression, "resource.") &&
      length(google_project_iam_custom_role.runner_manager_invoker.permissions) == 1 &&
      contains(google_project_iam_custom_role.runner_manager_invoker.permissions, "run.routes.invoke")
    )
    error_message = "the runner manager's invoke grant names no resource attribute and holds run.routes.invoke alone"
  }

  # The create/delete grant keeps its name condition (D-16 remains for delete).
  assert {
    condition     = google_project_iam_member.runner_manager_run_developer.condition[0].expression == local.runtime_services_only
    error_message = "the runner manager's create/delete grant keeps the runtime-services-only name condition"
  }

  # No service of this stack has a host the condition matches: every one is named after var.name,
  # which may not start with rt-.
  assert {
    condition = alltrue([
      for n in concat(
        [
          google_cloud_run_v2_service.web.name,
          google_cloud_run_v2_service.gateway.name,
          google_cloud_run_v2_service.runner_manager.name,
        ],
        [for a in google_cloud_run_v2_service.app : a.name],
      ) : !startswith(n, "rt-")
    ])
    error_message = "no service of the stack may have an rt- host"
  }
}

run "the_gateway_may_invoke_only_tool_sandboxes_and_asks_for_id_tokens" {
  command = plan

  override_resource {
    target          = random_id.role_suffix
    override_during = plan
    values          = { hex = "a1b2c3" }
  }

  # Cloud Run gives the invoke check request.host but no resource.name (live runs 42525921402 and
  # 42550494860: a name condition granted neither invoke nor setIamPolicy), so the gateway's grant
  # is conditioned on a tool sandbox's host, https://rt-tool-<id>-<hash>-<region>.a.run.app.
  assert {
    condition = (
      google_project_iam_member.gateway_invokes_tool_sandboxes.member == google_service_account.gateway.member &&
      trimspace(google_project_iam_member.gateway_invokes_tool_sandboxes.condition[0].expression) == "request.host.startsWith(\"rt-tool-\") && request.host.endsWith(\".run.app\")"
    )
    error_message = "the gateway's invoke grant is conditioned on an rt-tool- run.app host and nothing wider"
  }

  # run.invoker carries run.jobs.run: the gateway's grant is run.servicesInvoker (run.routes.invoke
  # alone), and the manager's create/delete grant excludes Jobs by type (the app_role job holds the
  # database owner's password).
  assert {
    condition = (
      google_project_iam_member.gateway_invokes_tool_sandboxes.role == "roles/run.servicesInvoker" &&
      strcontains(google_project_iam_member.runner_manager_run_developer.condition[0].expression, "resource.type != \"run.googleapis.com/Job\" &&")
    )
    error_message = "no Cloud Run grant to the gateway or on rt- names may run a Job"
  }

  # No identity may set a Cloud Run IAM policy: run.admin (run.services.setIamPolicy) is granted to
  # no one, and the runner manager holds its two custom roles only (IAM-01).
  assert {
    condition = (
      google_project_iam_member.runner_manager_run_developer.role == "projects/aw-test-project/roles/agent_workspace_runner_manager_a1b2c3" &&
      google_project_iam_member.runner_manager_run_invoker.role == "projects/aw-test-project/roles/agent_workspace_runner_manager_invoker_a1b2c3" &&
      !contains(google_project_iam_custom_role.runner_manager.permissions, "run.services.setIamPolicy")
    )
    error_message = "the runner manager holds its two custom roles, never run.admin or setIamPolicy"
  }

  assert {
    condition     = [for e in google_cloud_run_v2_service.gateway.template[0].containers[0].env : e.value if e.name == "GATEWAY_TOOL_SANDBOX_AUTH"] == ["google-id-token"]
    error_message = "the gateway is told to call tool sandboxes with a Google ID token"
  }

  assert {
    condition = (
      !contains([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e.name], "AGENT_WORKSPACE_TOOL_HOST_IMAGE") &&
      !contains([for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e.name], "AGENT_WORKSPACE_TOOL_HOST_IMAGE")
    )
    error_message = "without images.tool_host neither web nor the runner manager gets AGENT_WORKSPACE_TOOL_HOST_IMAGE"
  }
}

run "tool_host_reaches_web_and_the_runner_manager" {
  command = plan

  variables {
    images = {
      web       = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/web@sha256:1111111111111111111111111111111111111111111111111111111111111111"
      gateway   = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/gateway@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      runner    = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runner@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      runtime   = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/runtime@sha256:4444444444444444444444444444444444444444444444444444444444444444"
      tool_host = "asia-northeast1-docker.pkg.dev/aw-test-project/agent-workspace/tool-host@sha256:7777777777777777777777777777777777777777777777777777777777777777"
    }
  }

  assert {
    condition = (
      length([for e in google_cloud_run_v2_service.web.template[0].containers[0].env : e if e.name == "AGENT_WORKSPACE_TOOL_HOST_IMAGE"]) == 1 &&
      length([for e in google_cloud_run_v2_service.runner_manager.template[0].containers[0].env : e if e.name == "AGENT_WORKSPACE_TOOL_HOST_IMAGE"]) == 1
    )
    error_message = "images.tool_host sets AGENT_WORKSPACE_TOOL_HOST_IMAGE on web and the runner manager"
  }
}

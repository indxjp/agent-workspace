[CmdletBinding()]
param(
  [ValidateSet('Validate', 'Apply', 'Destroy')]
  [string]$Action = 'Apply',
  [string]$SubscriptionId = $env:AZURE_SUBSCRIPTION_ID,
  [string]$Location = 'japaneast',
  [string]$Name = 'agent-workspace',
  [string]$BootstrapAdminEmail = $env:BOOTSTRAP_ADMIN_EMAIL,
  [string]$GitHubRepository = '',
  [string]$GitHubEnvironment = 'azure-preview',
  [bool]$EnableDynamicSessions = $true,
  [ValidatePattern('^(?:[a-z0-9]{1,8})?$')]
  [string]$SessionPoolGeneration = '',
  [switch]$SkipBuild,
  [switch]$DestroyBootstrap
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Azure CLI streams ACR build logs through Python. On Windows, the inherited
# legacy console code page can make that stream crash on otherwise valid UTF-8
# build output (for example pnpm's checkmark). Keep the deploy path independent
# of the operator's locale.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$bootstrapDirectory = Join-Path $repositoryRoot 'infra\terraform\azure-container-apps\bootstrap'
$mainDirectory = Join-Path $repositoryRoot 'infra\terraform\azure-container-apps'
$buildContextDirectory = $null
$buildContextArchive = $null
$bootstrapPlanPath = $null

function Invoke-Checked {
  param(
    [Parameter(Mandatory)] [string]$Command,
    [Parameter(Mandatory)] [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Get-CheckedOutput {
  param(
    [Parameter(Mandatory)] [string]$Command,
    [Parameter(Mandatory)] [string[]]$Arguments
  )

  $output = & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
  return ($output | Out-String).Trim()
}

function Assert-Command {
  param([Parameter(Mandatory)] [string]$Name)
  if ($null -eq (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found on PATH."
  }
}

function Invoke-TerraformValidation {
  Invoke-Checked terraform @("-chdir=$bootstrapDirectory", 'fmt', '-check', '-recursive')
  Invoke-Checked terraform @("-chdir=$bootstrapDirectory", 'init', '-backend=false', '-input=false')
  Invoke-Checked terraform @("-chdir=$bootstrapDirectory", 'validate')
  Invoke-Checked terraform @("-chdir=$bootstrapDirectory", 'test')
  Invoke-Checked terraform @("-chdir=$mainDirectory", 'fmt', '-check', '-recursive')
  Invoke-Checked terraform @("-chdir=$mainDirectory", 'init', '-backend=false', '-input=false')
  Invoke-Checked terraform @("-chdir=$mainDirectory", 'validate')
  Invoke-Checked terraform @("-chdir=$mainDirectory", 'test')
}

function Wait-ForHttps {
  param([Parameter(Mandatory)] [string]$Url)
  for ($attempt = 1; $attempt -le 60; $attempt += 1) {
    try {
      # The unauthenticated root intentionally redirects to /signin. Follow a
      # bounded redirect chain so a healthy auth boundary counts as a healthy
      # ingress route instead of surfacing as a PowerShell redirect exception.
      $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec 15 -MaximumRedirection 5 -SkipHttpErrorCheck
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        Write-Host "Web ingress answered HTTP $($response.StatusCode): $Url"
        return
      }
    }
    catch {
      Write-Verbose "Web cold-start attempt $attempt failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 10
  }
  throw "Web ingress did not answer within 10 minutes: $Url"
}

function Wait-ForAcrBuild {
  param(
    [Parameter(Mandatory)] [string]$Registry,
    [Parameter(Mandatory)] [string]$RunId
  )

  for ($attempt = 1; $attempt -le 180; $attempt += 1) {
    $status = Get-CheckedOutput az @(
      'acr', 'task', 'show-run',
      '--registry', $Registry,
      '--run-id', $RunId,
      '--query', 'status',
      '--output', 'tsv'
    )
    switch ($status) {
      'Succeeded' {
        Write-Host "ACR build $RunId succeeded."
        return
      }
      { $_ -in @('Canceled', 'Error', 'Failed', 'Timeout') } {
        throw "ACR build $RunId finished with status '$status'. Inspect it with: az acr task logs --registry $Registry --run-id $RunId"
      }
    }
    Start-Sleep -Seconds 10
  }
  throw "ACR build $RunId did not finish within 30 minutes."
}

foreach ($command in @('az', 'git', 'terraform')) {
  Assert-Command $command
}

Push-Location $repositoryRoot
try {
  Invoke-TerraformValidation
  if ($Action -eq 'Validate') {
    Write-Host 'Azure Terraform formatting, validation, and contract tests passed.'
    return
  }

  if ([string]::IsNullOrWhiteSpace($SubscriptionId)) {
    throw 'SubscriptionId is required (or set AZURE_SUBSCRIPTION_ID).'
  }
  if ([string]::IsNullOrWhiteSpace($BootstrapAdminEmail)) {
    throw 'BootstrapAdminEmail is required (or set BOOTSTRAP_ADMIN_EMAIL).'
  }

  Invoke-Checked az @('account', 'set', '--subscription', $SubscriptionId)
  foreach ($provider in @(
      'Microsoft.App',
      'Microsoft.ContainerRegistry',
      'Microsoft.DBforPostgreSQL',
      'Microsoft.KeyVault',
      'Microsoft.ManagedIdentity',
      'Microsoft.Network',
      'Microsoft.OperationalInsights',
      'Microsoft.Storage',
      'Microsoft.Authorization'
    )) {
    Invoke-Checked az @('provider', 'register', '--namespace', $provider, '--wait')
  }

  Invoke-Checked terraform @("-chdir=$bootstrapDirectory", 'init', '-input=false')
  if ($Action -eq 'Destroy') {
    $bootstrapState = Join-Path $bootstrapDirectory 'terraform.tfstate'
    if (-not (Test-Path -LiteralPath $bootstrapState)) {
      throw "Destroy requires the existing bootstrap state at $bootstrapState. Refusing to create or guess a deployment."
    }
  }
  else {
    $bootstrapPlanPath = Join-Path ([IO.Path]::GetTempPath()) "agent-workspace-bootstrap-$([Guid]::NewGuid().ToString('N')).tfplan"
    $bootstrapArguments = @(
      "-chdir=$bootstrapDirectory",
      'plan',
      '-input=false',
      "-out=$bootstrapPlanPath",
      "-var=subscription_id=$SubscriptionId",
      "-var=location=$Location",
      "-var=name=$Name"
    )
    if (-not [string]::IsNullOrWhiteSpace($GitHubRepository)) {
      $bootstrapArguments += "-var=github_repository=$GitHubRepository"
      $bootstrapArguments += "-var=github_environment=$GitHubEnvironment"
    }
    Invoke-Checked terraform $bootstrapArguments

    # The bootstrap owns state, registry, and deployment credentials. Never let
    # the convenience script replace or delete those resources because of a
    # mistyped environment name or subscription. An intentional destructive
    # bootstrap change must be reviewed and applied manually.
    $bootstrapPlan = (Get-CheckedOutput terraform @(
        "-chdir=$bootstrapDirectory", 'show', '-json', $bootstrapPlanPath
      )) | ConvertFrom-Json
    $destructiveBootstrapChanges = @(
      $bootstrapPlan.resource_changes |
        Where-Object { $_.change.actions -contains 'delete' } |
        ForEach-Object { $_.address }
    )
    if ($destructiveBootstrapChanges.Count -gt 0) {
      throw "Refusing destructive bootstrap changes: $($destructiveBootstrapChanges -join ', '). Verify Name and SubscriptionId, then review and apply the bootstrap plan manually if destruction is intentional."
    }

    Invoke-Checked terraform @(
      "-chdir=$bootstrapDirectory", 'apply', '-auto-approve', '-input=false', $bootstrapPlanPath
    )
  }

  $resourceGroup = Get-CheckedOutput terraform @("-chdir=$bootstrapDirectory", 'output', '-raw', 'resource_group_name')
  $registryResourceGroup = Get-CheckedOutput terraform @("-chdir=$bootstrapDirectory", 'output', '-raw', 'container_registry_resource_group_name')
  $registryName = Get-CheckedOutput terraform @("-chdir=$bootstrapDirectory", 'output', '-raw', 'container_registry_name')
  $registryServer = Get-CheckedOutput terraform @("-chdir=$bootstrapDirectory", 'output', '-raw', 'container_registry_login_server')
  $backend = (Get-CheckedOutput terraform @("-chdir=$bootstrapDirectory", 'output', '-json', 'backend_config')) | ConvertFrom-Json

  $tag = Get-CheckedOutput git @('rev-parse', '--short=12', 'HEAD')
  $images = @{}
  if ($Action -eq 'Apply' -and -not $SkipBuild) {
    # ACR CLI archives the source before Docker can apply .dockerignore. Build
    # from the exact commit so local node_modules, Terraform providers, secrets,
    # and other untracked state are neither uploaded nor allowed to affect an
    # immutable image whose tag names that commit.
    $contextId = [Guid]::NewGuid().ToString('N')
    $buildContextDirectory = Join-Path ([IO.Path]::GetTempPath()) "agent-workspace-build-$contextId"
    $buildContextArchive = "$buildContextDirectory.zip"
    New-Item -ItemType Directory -Path $buildContextDirectory -ErrorAction Stop | Out-Null
    Invoke-Checked git @('archive', '--format=zip', "--output=$buildContextArchive", 'HEAD')
    Expand-Archive -LiteralPath $buildContextArchive -DestinationPath $buildContextDirectory

    foreach ($component in @(
        @{ Name = 'web'; Dockerfile = 'Dockerfile'; Target = 'web' },
        @{ Name = 'gateway'; Dockerfile = 'gateway.Dockerfile'; Target = 'gateway' },
        @{ Name = 'runner'; Dockerfile = 'Dockerfile'; Target = 'runner' },
        @{ Name = 'runtime'; Dockerfile = 'runtime.Dockerfile'; Target = 'runtime' }
      )) {
      $repository = "agent-workspace/$($component.Name)"
      $runId = Get-CheckedOutput az @(
        'acr', 'build',
        '--registry', $registryName,
        '--platform', 'linux/amd64',
        '--file', $component.Dockerfile,
        '--target', $component.Target,
        '--image', "${repository}:$tag",
        '--no-logs',
        '--query', 'runId',
        '--output', 'tsv',
        $buildContextDirectory
      )
      if ([string]::IsNullOrWhiteSpace($runId)) {
        throw "ACR did not return a run ID for $repository."
      }
      Wait-ForAcrBuild -Registry $registryName -RunId $runId
      $digest = Get-CheckedOutput az @(
        'acr', 'repository', 'show',
        '--name', $registryName,
        '--image', "${repository}:$tag",
        '--query', 'digest',
        '--output', 'tsv'
      )
      if ($digest -notmatch '^sha256:[0-9a-f]{64}$') {
        throw "ACR returned an invalid digest for $repository`: $digest"
      }
      $images[$component.Name] = "$registryServer/$repository@$digest"
    }
  }
  elseif ($Action -eq 'Apply') {
    if ([string]::IsNullOrWhiteSpace($env:TF_VAR_images)) {
      throw 'SkipBuild requires TF_VAR_images to contain the four immutable image references.'
    }
    $images = $env:TF_VAR_images | ConvertFrom-Json -AsHashtable
  }
  else {
    foreach ($componentName in @('web', 'gateway', 'runner', 'runtime')) {
      $images[$componentName] = "$registryServer/agent-workspace/$componentName@sha256:$('f' * 64)"
    }
  }

  $env:TF_VAR_subscription_id = $SubscriptionId
  $env:TF_VAR_resource_group_name = $resourceGroup
  $env:TF_VAR_container_registry_name = $registryName
  $env:TF_VAR_container_registry_resource_group_name = $registryResourceGroup
  $env:TF_VAR_name = $Name
  $env:TF_VAR_bootstrap_admin_email = $BootstrapAdminEmail
  $env:TF_VAR_enable_dynamic_sessions = $EnableDynamicSessions.ToString().ToLowerInvariant()
  $env:TF_VAR_session_pool_generation = $SessionPoolGeneration
  $env:TF_VAR_images = $images | ConvertTo-Json -Compress

  Invoke-Checked terraform @(
    "-chdir=$mainDirectory", 'init', '-reconfigure', '-input=false',
    "-backend-config=resource_group_name=$($backend.resource_group_name)",
    "-backend-config=storage_account_name=$($backend.storage_account_name)",
    "-backend-config=container_name=$($backend.container_name)",
    "-backend-config=key=$($backend.key)",
    '-backend-config=use_azuread_auth=true'
  )

  if ($Action -eq 'Destroy') {
    Invoke-Checked terraform @("-chdir=$mainDirectory", 'destroy', '-auto-approve', '-input=false')
    if ($DestroyBootstrap) {
      Invoke-Checked terraform @(
        "-chdir=$bootstrapDirectory", 'destroy', '-auto-approve', '-input=false',
        "-var=subscription_id=$SubscriptionId",
        "-var=location=$Location",
        "-var=name=$Name"
      )
    }
    return
  }

  Invoke-Checked terraform @("-chdir=$mainDirectory", 'apply', '-auto-approve', '-input=false')
  $webUrl = Get-CheckedOutput terraform @("-chdir=$mainDirectory", 'output', '-raw', 'web_url')
  Wait-ForHttps $webUrl

  if ($EnableDynamicSessions) {
    Write-Warning 'The session pool was provisioned but not called with the deployer identity. Validate it through the runner, or use a temporary pool-scoped Session Executor assignment and remove that assignment immediately afterward.'
  }

  Invoke-Checked terraform @("-chdir=$mainDirectory", 'output')
}
finally {
  Pop-Location
  $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  foreach ($temporaryPath in @($buildContextDirectory, $buildContextArchive, $bootstrapPlanPath)) {
    if (-not [string]::IsNullOrWhiteSpace($temporaryPath) -and (Test-Path -LiteralPath $temporaryPath)) {
      $resolvedTemporaryPath = [IO.Path]::GetFullPath($temporaryPath)
      if (-not $resolvedTemporaryPath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a deployment temporary path outside $temporaryRoot`: $resolvedTemporaryPath"
      }
      Remove-Item -LiteralPath $resolvedTemporaryPath -Recurse -Force
    }
  }
}

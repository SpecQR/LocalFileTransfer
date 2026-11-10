param(
   [Parameter(Mandatory)] [string] $BaselineArtifact,
   [Parameter(Mandatory)] [string] $OptimizedArtifact,
   [ValidateRange(1, 10)] [int] $Samples = 3,
   [string] $EvidenceDirectory = "",
   [ValidateSet("7z", "direct")] [string] $BaselinePackaging = "7z",
   [ValidateSet("7z", "direct")] [string] $OptimizedPackaging = "direct",
   [ValidateSet("normal", "store")] [string] $BaselineCompression = "normal",
   [ValidateSet("normal", "store")] [string] $OptimizedCompression = "normal"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PowerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$OutputDirectory = if ($EvidenceDirectory) {
   [IO.Path]::GetFullPath($EvidenceDirectory)
} else {
   Join-Path $Root "test-results\portable-startup"
}
$Artifacts = @{
   baseline = [IO.Path]::GetFullPath($BaselineArtifact)
   optimized = [IO.Path]::GetFullPath($OptimizedArtifact)
}
# The caller supplies the configuration used to build each artifact. Keep these
# labels independent of the baseline/optimized roles when comparing compression.
$Packaging = @{
   baseline = $BaselinePackaging
   optimized = $OptimizedPackaging
}
$Compression = @{
   baseline = $BaselineCompression
   optimized = $OptimizedCompression
}
$ComparisonId = "$BaselinePackaging-$BaselineCompression-vs-$OptimizedPackaging-$OptimizedCompression"
$Results = @{
   baseline = [Collections.Generic.List[object]]::new()
   optimized = [Collections.Generic.List[object]]::new()
}
$RunOrder = [Collections.Generic.List[object]]::new()

foreach ($artifact in $Artifacts.Values) {
   if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
      throw "A comparison artifact was not found"
   }
}

if ($Artifacts.baseline -eq $Artifacts.optimized) {
   throw "The comparison requires separate baseline and optimized artifacts"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Invoke-StartupSample {
   param(
      [Parameter(Mandatory)] [string] $Variant,
      [Parameter(Mandatory)] [string] $Phase,
      [Parameter(Mandatory)] [int] $Round
   )

   $sampleDirectory = Join-Path $OutputDirectory "$Phase-$Round-$Variant"
   $arguments = @(
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", (Join-Path $PSScriptRoot "test-packaged-windows.ps1"),
      "-ArtifactPath", $Artifacts[$Variant],
      "-EvidenceDirectory", $sampleDirectory
   )
   & $PowerShellPath @arguments | Out-Null

   if ($LASTEXITCODE -ne 0) {
      throw "$Variant packaged smoke failed during $Phase round $Round (exit $LASTEXITCODE)"
   }

   $evidence = Get-Content -LiteralPath (Join-Path $sampleDirectory "PACKAGED_SMOKE.json") -Raw | ConvertFrom-Json

   if (
      $evidence.initialHealthStatus -ne 200 `
      -or $evidence.initialAppStatus -ne 200 `
      -or $evidence.recoveredHealthStatus -ne 200 `
      -or $evidence.recoveredAppStatus -ne 200 `
      -or $evidence.desktopReadyBeforeInterruption -ne $true `
      -or -not $evidence.gracefulWindowClose `
      -or -not $evidence.endpointClosed `
      -or $evidence.residualProcesses -ne 0
   ) {
      throw "$Variant packaged smoke did not satisfy all runtime gates"
   }

   foreach ($metric in @("serviceReadySeconds", "healthReadySeconds", "appHttpReadySeconds")) {
      $value = $evidence.$metric

      if ($null -eq $value -or [double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value) -or [double]$value -le 0) {
         throw "$Variant startup evidence has an invalid $metric"
      }
   }

   $RunOrder.Add([ordered]@{
      phase = $Phase
      round = $Round
      variant = $Variant
   })
   $sampleSummary = [ordered]@{
      comparisonId = $ComparisonId
      phase = $Phase
      round = $Round
      variant = $Variant
      packaging = $Packaging[$Variant]
      compression = $Compression[$Variant]
      serviceReadySeconds = $evidence.serviceReadySeconds
      healthReadySeconds = $evidence.healthReadySeconds
      appHttpReadySeconds = $evidence.appHttpReadySeconds
      length = $evidence.length
      sha256 = $evidence.sha256
   }
   Write-Host ("STARTUP_SAMPLE=" + ($sampleSummary | ConvertTo-Json -Depth 4 -Compress))

   if ($Phase -eq "measured") {
      $Results[$Variant].Add($evidence)
   }
}

function Get-Median {
   param([Parameter(Mandatory)] [double[]] $Values)

   $ordered = @($Values | Sort-Object)
   $middle = [int][math]::Floor($ordered.Count / 2)

   if ($ordered.Count % 2 -eq 1) {
      return $ordered[$middle]
   }

   return ($ordered[$middle - 1] + $ordered[$middle]) / 2
}

# Each invocation uses fresh storage and fully shuts down its extracted runtime.
# Warm filesystem/AV caches cannot be reset reliably on a hosted runner.
Invoke-StartupSample -Variant baseline -Phase warmup -Round 0
Invoke-StartupSample -Variant optimized -Phase warmup -Round 0

for ($round = 1; $round -le $Samples; $round += 1) {
   $variants = if ($round % 2 -eq 1) { @("baseline", "optimized") } else { @("optimized", "baseline") }

   foreach ($variant in $variants) {
      Invoke-StartupSample -Variant $variant -Phase measured -Round $round
   }
}

$summaries = [ordered]@{}

foreach ($variant in @("baseline", "optimized")) {
   $runs = $Results[$variant]
   $first = $runs[0]

   foreach ($run in $runs) {
      if ($run.sha256 -ne $first.sha256 -or $run.length -ne $first.length) {
         throw "$variant artifact changed between measured runs"
      }
   }

   $summaries[$variant] = [ordered]@{
      artifact = $first.artifact
      sha256 = $first.sha256
      length = $first.length
      packaging = $Packaging[$variant]
      portableUseZip = $Packaging[$variant] -eq "direct"
      compression = $Compression[$variant]
      serviceReadyMedianSeconds = [math]::Round((Get-Median -Values @($runs | ForEach-Object serviceReadySeconds)), 3)
      healthReadyMedianSeconds = [math]::Round((Get-Median -Values @($runs | ForEach-Object healthReadySeconds)), 3)
      appHttpReadyMedianSeconds = [math]::Round((Get-Median -Values @($runs | ForEach-Object appHttpReadySeconds)), 3)
      samples = @($runs | ForEach-Object {
         [ordered]@{
            serviceReadySeconds = $_.serviceReadySeconds
            healthReadySeconds = $_.healthReadySeconds
            appHttpReadySeconds = $_.appHttpReadySeconds
            desktopReadyBeforeInterruption = $true
            packagedRecoveryPassed = $true
            gracefulShutdownPassed = $true
         }
      })
   }
}

if ($summaries.baseline.sha256 -eq $summaries.optimized.sha256) {
   throw "The baseline and optimized artifacts are identical"
}

$report = [ordered]@{
   schemaVersion = 1
   testedAt = (Get-Date).ToUniversalTime().ToString("o")
   sourceCommit = $env:GITHUB_SHA
   runnerImage = $env:ImageOS
   runnerImageVersion = $env:ImageVersion
   comparison = "same-source-packaging-only"
   comparisonId = $ComparisonId
   configurationSource = "explicit-comparison-parameters"
   architecture = "x64"
   warmupRunsPerVariant = 1
   measuredRunsPerVariant = $Samples
   runOrder = @($RunOrder.ToArray())
   startBoundary = "stopwatch-immediately-before-launch"
   serviceReadyBoundary = "first-service-ready-log-observed"
   healthReadyBoundary = "first-successful-healthz-http-response"
   appHttpReadyBoundary = "first-successful-app-html-http-response"
   readinessPollMilliseconds = 200
   gpuDisabledForSmoke = $true
   loopbackOnlyForSmoke = $true
   freshStorageEachRun = $true
   desktopReadinessProbe = "windows-ui-automation-connected-status-after-startup-clock-stops"
   rendererReadyMeasured = $false
   coldBootMeasured = $false
   arm64RuntimeMeasured = $false
   variants = $summaries
   sizeIncreaseBytes = [int64]$summaries.optimized.length - [int64]$summaries.baseline.length
   serviceReadyMedianReductionSeconds = [math]::Round(
      ($summaries.baseline.serviceReadyMedianSeconds - $summaries.optimized.serviceReadyMedianSeconds), 3
   )
}
$json = $report | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText(
   (Join-Path $OutputDirectory "STARTUP_COMPARISON.json"),
   $json + [Environment]::NewLine,
   [Text.UTF8Encoding]::new($false)
)
$json

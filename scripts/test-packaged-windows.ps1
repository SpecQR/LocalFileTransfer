$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http

$HttpHandler = [Net.Http.HttpClientHandler]::new()
$HttpHandler.UseProxy = $false
$HttpClient = [Net.Http.HttpClient]::new($HttpHandler)
$HttpClient.Timeout = [TimeSpan]::FromSeconds(5)
$LftLastHttpError = $null

function Get-TestProcesses {
   return @(Get-CimInstance Win32_Process | Where-Object {
      $_.CommandLine -and $_.CommandLine -like ("*" + $UserData + "*")
   })
}

function Add-TrackedProcesses {
   foreach ($process in @(Get-TestProcesses)) {
      [void]$TrackedIds.Add([int]$process.ProcessId)
   }
}

function Get-LogRecords {
   if (-not (Test-Path -LiteralPath $LogPath)) {
      return @()
   }

   $records = foreach ($line in Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue) {
      try {
         $line | ConvertFrom-Json
      } catch {
         # A concurrently appended final line is retried on the next poll.
      }
   }

   return @($records)
}

function Wait-Until {
   param(
      [Parameter(Mandatory)] [string] $Description,
      [Parameter(Mandatory)] [int] $TimeoutSeconds,
      [Parameter(Mandatory)] [scriptblock] $Condition
   )

   $deadline = (Get-Date).AddSeconds($TimeoutSeconds)

   while ((Get-Date) -lt $deadline) {
      if (& $Condition) {
         return
      }

      Start-Sleep -Milliseconds 200
   }

   throw "Timed out waiting for $Description"
}

function Invoke-LocalHttp {
   param([Parameter(Mandatory)] [string] $Url)

   $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, $Url)
   $request.Headers.ConnectionClose = $true
   $response = $null

   try {
      $response = $HttpClient.SendAsync(
         $request,
         [Net.Http.HttpCompletionOption]::ResponseContentRead
      ).GetAwaiter().GetResult()

      return [pscustomobject]@{
         StatusCode = [int]$response.StatusCode
         Content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      }
   } finally {
      if ($response) {
         $response.Dispose()
      }

      $request.Dispose()
   }
}

function Wait-HttpOk {
   param(
      [Parameter(Mandatory)] [string] $Url,
      [Parameter(Mandatory)] [int] $TimeoutSeconds
   )

   $script:LftHttpResult = $null
   $script:LftLastHttpError = $null

   try {
      Wait-Until -Description $Url -TimeoutSeconds $TimeoutSeconds -Condition {
         try {
            $script:LftHttpResult = Invoke-LocalHttp -Url $Url
            $script:LftLastHttpError = $null
            return $script:LftHttpResult.StatusCode -eq 200
         } catch {
            $script:LftLastHttpError = $_.Exception.Message
            return $false
         }
      }
   } catch {
      $suffix = if ($script:LftLastHttpError) {
         " Last HTTP error: $script:LftLastHttpError"
      } else {
         ""
      }

      throw ($_.Exception.Message + $suffix)
   }

   return $script:LftHttpResult
}

function Wait-HttpClosed {
   param(
      [Parameter(Mandatory)] [string] $Url,
      [Parameter(Mandatory)] [int] $TimeoutSeconds
   )

   try {
      Wait-Until -Description "$Url to close" -TimeoutSeconds $TimeoutSeconds -Condition {
         try {
            Invoke-LocalHttp -Url $Url | Out-Null
            return $false
         } catch {
            return $true
         }
      }
      return $true
   } catch {
      return $false
   }
}
$Root = Split-Path -Parent $PSScriptRoot
$Version = (Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
$EvidenceLabel = if ($Version -match "-rc\.(\d+)$") { "RC" + $Matches[1] } else { $Version -replace "[^A-Za-z0-9]", "_" }
$ArtifactName = "Local.File.Transfer-$Version-x64-Portable.exe"
$Artifact = Join-Path $Root "apps\desktop\release\$ArtifactName"
$RunRoot = Join-Path ([IO.Path]::GetTempPath()) ("lft-packaged-smoke-" + [guid]::NewGuid().ToString("N"))
$UserData = Join-Path $RunRoot "user-data"
$Storage = Join-Path $RunRoot "storage"
$Receive = Join-Path $RunRoot "received"
$LogPath = Join-Path $Storage "logs\service.jsonl"
$Launcher = $null
$TrackedIds = [Collections.Generic.HashSet[int]]::new()
$StartedAt = Get-Date
$Evidence = $null
$LaunchArguments = @(
   "--user-data-dir=" + $UserData,
   "--disable-gpu"
)

if (-not (Test-Path -LiteralPath $Artifact -PathType Leaf)) {
   throw "Portable artifact was not found: $Artifact"
}

New-Item -ItemType Directory -Path $UserData, $Storage, $Receive -Force | Out-Null

try {
   $savedStorage = $env:LFT_STORAGE_DIR
   $savedReceive = $env:LFT_RECEIVE_DIR
   $env:LFT_STORAGE_DIR = $Storage
   $env:LFT_RECEIVE_DIR = $Receive

   try {
      $Launcher = Start-Process -FilePath $Artifact `
         -ArgumentList $LaunchArguments `
         -WindowStyle Hidden `
         -PassThru
      [void]$TrackedIds.Add($Launcher.Id)
   } finally {
      $env:LFT_STORAGE_DIR = $savedStorage
      $env:LFT_RECEIVE_DIR = $savedReceive
   }

   Wait-Until -Description "first service-ready record" -TimeoutSeconds 90 -Condition {
      @(Get-LogRecords | Where-Object event -eq "service-ready").Count -ge 1
   }
   Add-TrackedProcesses
   $firstReady = @(Get-LogRecords | Where-Object event -eq "service-ready")[0]
   $Port = [int]$firstReady.details.port
   $BaseUrl = "http://127.0.0.1:$Port"
   $Health = Wait-HttpOk -Url "$BaseUrl/healthz" -TimeoutSeconds 30
   $App = Wait-HttpOk -Url "$BaseUrl/app" -TimeoutSeconds 30

   Wait-Until -Description "SQLite room database" -TimeoutSeconds 30 -Condition {
      Test-Path -LiteralPath (Join-Path $Storage "rooms.sqlite")
   }
   $BeforeProcesses = @(Get-TestProcesses)
   $Utility = $BeforeProcesses | Where-Object {
      $_.CommandLine -match "node\.mojom\.NodeService"
   } | Select-Object -First 1

   if (-not $Utility) {
      $summary = $BeforeProcesses | Select-Object ProcessId, ParentProcessId, Name, CommandLine
      throw "Could not identify the packaged Node Utility Process. Processes: $($summary | ConvertTo-Json -Compress)"
   }

   if ($Utility.CommandLine -notlike ("*" + $UserData + "*")) {
      throw "Refusing to stop a Utility Process outside the isolated smoke run"
   }

   [void]$TrackedIds.Add([int]$Utility.ProcessId)
   $InterruptedAt = Get-Date
   Stop-Process -Id $Utility.ProcessId -Force

   Wait-Until -Description "restarted service-ready record" -TimeoutSeconds 45 -Condition {
      $records = @(Get-LogRecords | Where-Object event -eq "service-ready")

      return $records.Count -ge 2 -and [int]$records[-1].details.serviceRestarts -eq 1
   }
   $RecoveredAt = Get-Date
   Add-TrackedProcesses
   $SecondReady = @(Get-LogRecords | Where-Object event -eq "service-ready")[-1]
   $RecoveredPort = [int]$SecondReady.details.port
   $RecoveredBaseUrl = "http://127.0.0.1:$RecoveredPort"
   $RecoveredHealth = Wait-HttpOk -Url "$RecoveredBaseUrl/healthz" -TimeoutSeconds 30
   $RecoveredApp = Wait-HttpOk -Url "$RecoveredBaseUrl/app" -TimeoutSeconds 30
   $AfterProcesses = @(Get-TestProcesses)
   $Main = $AfterProcesses | Where-Object {
      $_.Name -eq "Local File Transfer.exe" -and $_.CommandLine -notmatch "--type="
   } | Select-Object -First 1

   if (-not $Main) {
      throw "Could not identify the packaged Electron main process"
   }

   [void]$TrackedIds.Add([int]$Main.ProcessId)
   $MainProcess = [Diagnostics.Process]::GetProcessById([int]$Main.ProcessId)
   $GracefulWindowClose = $MainProcess.CloseMainWindow()

   if (-not $GracefulWindowClose) {
      throw "The packaged Electron window did not accept a graceful close"
   }

   Wait-Until -Description "packaged process shutdown" -TimeoutSeconds 30 -Condition {
      Add-TrackedProcesses
      return @(Get-TestProcesses).Count -eq 0 -and -not (Get-Process -Id $Launcher.Id -ErrorAction SilentlyContinue)
   }
   $EndpointClosed = Wait-HttpClosed -Url "$RecoveredBaseUrl/healthz" -TimeoutSeconds 15
   $Records = @(Get-LogRecords)
   $Residual = @(Get-TestProcesses)

   $Evidence = [ordered]@{
      schemaVersion = 1
      testedAt = (Get-Date).ToUniversalTime().ToString("o")
      artifact = $ArtifactName
      length = (Get-Item -LiteralPath $Artifact).Length
      sha256 = (Get-FileHash -LiteralPath $Artifact -Algorithm SHA256).Hash
      authenticodeStatus = (Get-AuthenticodeSignature -LiteralPath $Artifact).Status.ToString()
      port = $Port
      initialHealthStatus = [int]$Health.StatusCode
      initialHealthBody = $Health.Content
      initialAppStatus = [int]$App.StatusCode
      processCountBeforeInterruption = $BeforeProcesses.Count
      utilityInterruptionInjected = $true
      gpuDisabledForSmoke = $true
      recoveredPort = $RecoveredPort
      recoveredHealthStatus = [int]$RecoveredHealth.StatusCode
      recoveredHealthBody = $RecoveredHealth.Content
      recoveredAppStatus = [int]$RecoveredApp.StatusCode
      serviceReadyRecords = @($Records | Where-Object event -eq "service-ready").Count
      serviceRestartCount = [int]$SecondReady.details.serviceRestarts
      interruptionRecoverySeconds = [math]::Round(($RecoveredAt - $InterruptedAt).TotalSeconds, 3)
      sqliteCreated = Test-Path -LiteralPath (Join-Path $Storage "rooms.sqlite")
      structuredLogEvents = @($Records | Select-Object -ExpandProperty event)
      gracefulWindowClose = $GracefulWindowClose
      endpointClosed = $EndpointClosed
      residualProcesses = $Residual.Count
      launchSeconds = [math]::Round(($InterruptedAt - $StartedAt).TotalSeconds, 3)
   }

   if (-not $EndpointClosed -or $Residual.Count -ne 0) {
      throw "Packaged shutdown left an endpoint or process active"
   }

   $releaseEvidenceDir = Join-Path $Root "docs\release\$Version"

   New-Item -ItemType Directory -Path $releaseEvidenceDir -Force | Out-Null
   $json = $Evidence | ConvertTo-Json -Depth 8

   [IO.File]::WriteAllText(
      (Join-Path $Root ("docs\" + $EvidenceLabel + "_PACKAGED_SMOKE.json")),
      $json + [Environment]::NewLine,
      [Text.UTF8Encoding]::new($false)
   )
   [IO.File]::WriteAllText(
      (Join-Path $releaseEvidenceDir "PACKAGED_SMOKE.json"),
      $json + [Environment]::NewLine,
      [Text.UTF8Encoding]::new($false)
   )
   Remove-Item -LiteralPath (Join-Path $releaseEvidenceDir "PACKAGED_SMOKE_FAILURE.json") -Force -ErrorAction SilentlyContinue
   $Evidence | ConvertTo-Json -Depth 8
} catch {
   $failureDir = Join-Path $Root "docs\release\$Version"
   $failureEvidence = [ordered]@{
      schemaVersion = 1
      testedAt = (Get-Date).ToUniversalTime().ToString("o")
      artifact = $ArtifactName
      error = $_.Exception.Message
      lastHttpError = $script:LftLastHttpError
      gpuDisabledForSmoke = $true
      logRecords = @(Get-LogRecords)
      processes = @(Get-TestProcesses | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
   }

   New-Item -ItemType Directory -Path $failureDir -Force | Out-Null
   [IO.File]::WriteAllText(
      (Join-Path $failureDir "PACKAGED_SMOKE_FAILURE.json"),
      ($failureEvidence | ConvertTo-Json -Depth 8) + [Environment]::NewLine,
      [Text.UTF8Encoding]::new($false)
   )
   throw
} finally {
   Add-TrackedProcesses

   for ($attempt = 0; $attempt -lt 3; $attempt += 1) {
      $cleanup = @(Get-TestProcesses | Sort-Object @{ Expression = {
         if ($_.Name -like "*Portable.exe") { 0 }
         elseif ($_.CommandLine -notmatch "--type=") { 1 }
         else { 2 }
      } })

      if ($cleanup.Count -eq 0) {
         break
      }

      foreach ($process in $cleanup) {
         if ($process.CommandLine -notlike ("*" + $UserData + "*")) {
            throw "Refusing to stop a process outside the isolated smoke run"
         }

         Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
      }

      if ($Launcher -and (Get-Process -Id $Launcher.Id -ErrorAction SilentlyContinue)) {
         Stop-Process -Id $Launcher.Id -Force -ErrorAction SilentlyContinue
      }

      Start-Sleep -Milliseconds 500
   }

   $cleanupResidual = @(Get-TestProcesses)

   if ($cleanupResidual.Count -ne 0) {
      throw "Isolated smoke processes remain after cleanup: $($cleanupResidual.ProcessId -join ',')"
   }

   $HttpClient.Dispose()
   $HttpHandler.Dispose()

   $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
   $resolvedRunRoot = [IO.Path]::GetFullPath($RunRoot)
   $leaf = Split-Path -Leaf $resolvedRunRoot

   if (
      $resolvedRunRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) `
      -and $leaf.StartsWith("lft-packaged-smoke-", [StringComparison]::Ordinal)
   ) {
      Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force -ErrorAction SilentlyContinue
   } else {
      throw "Refusing to remove an unexpected smoke-test directory: $resolvedRunRoot"
   }
}

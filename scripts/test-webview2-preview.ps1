param(
   [string] $ArchivePath = "",
   [string] $EvidenceDirectory = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Net.Http, System.IO.Compression.FileSystem
$Root = Split-Path -Parent $PSScriptRoot
$SourceCommit = & git -C $Root rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Unable to identify the tested source commit" }
$SourceCommit = $SourceCommit.Trim()
$Manifest = Get-Content -LiteralPath (Join-Path $Root "apps/webview2/preview.json") -Raw | ConvertFrom-Json
$ArchiveName = "Local.File.Transfer-WebView2-Preview-$($Manifest.version)-x64.zip"
$Archive = if ($ArchivePath) { [IO.Path]::GetFullPath($ArchivePath) } else { Join-Path $Root "apps/webview2/release/$ArchiveName" }
$EvidenceRoot = if ($EvidenceDirectory) { [IO.Path]::GetFullPath($EvidenceDirectory) } else { Join-Path $Root "test-results/webview2-preview" }
$RunRoot = Join-Path ([IO.Path]::GetTempPath()) ("lft-webview2-smoke-" + [guid]::NewGuid().ToString("N"))
$PackageRoot = Join-Path $RunRoot "package"
$DataRoot = Join-Path $RunRoot "data"
$ReceiveDir = Join-Path $DataRoot "receive"
$LogPath = Join-Path $DataRoot "storage/logs/service.jsonl"
$FixturePath = Join-Path $RunRoot "preview-outbound.bin"
$StatePath = Join-Path $RunRoot "protocol-state.json"
$Catalog = [IO.File]::ReadAllText((Join-Path $Root "apps/web/src/i18n/catalog.ts"), [Text.Encoding]::UTF8)
$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$Native = $null
$Window = $null
$Stage = "prepare"
$LastCheck = "prepare"
$StartupClock = $null
$WindowVisibleSeconds = $null
$JoinUrl = $null
$PreviousClipboard = [Windows.Forms.Clipboard]::GetText()
$TrackedIds = [Collections.Generic.HashSet[int]]::new()
$HttpHandler = [Net.Http.HttpClientHandler]::new()
$HttpHandler.UseProxy = $false
$Http = [Net.Http.HttpClient]::new($HttpHandler)
$Http.Timeout = [TimeSpan]::FromSeconds(3)

function Wait-For {
   param([string] $Description, [int] $Seconds = 45, [scriptblock] $Condition)
   $script:LastCheck = $Description
   $waitClock = [Diagnostics.Stopwatch]::StartNew()
   while ($waitClock.Elapsed.TotalSeconds -lt $Seconds) {
      if ($Native -and $StartupClock -and $null -eq $script:WindowVisibleSeconds) {
         try {
            $Native.Refresh()
            if ($Native.MainWindowHandle -ne [IntPtr]::Zero) {
               $script:WindowVisibleSeconds = $StartupClock.Elapsed.TotalSeconds
            }
         } catch { }
      }
      if (& $Condition) { return }
      Start-Sleep -Milliseconds 200
   }
   throw "Preview check timed out: $Description"
}

function Get-Records {
   if (-not (Test-Path -LiteralPath $LogPath)) { return @() }
   return @(Get-Content -LiteralPath $LogPath -ErrorAction SilentlyContinue | ForEach-Object {
      try { $_ | ConvertFrom-Json } catch { }
   })
}

function Get-RelatedProcesses {
   return @(Get-CimInstance Win32_Process | Where-Object {
      ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($PackageRoot + "\", [StringComparison]::OrdinalIgnoreCase)) `
      -or ($_.CommandLine -and $_.CommandLine.Contains($DataRoot))
   })
}

function Track-Processes {
   foreach ($process in @(Get-RelatedProcesses)) { [void]$TrackedIds.Add([int]$process.ProcessId) }
}

function Test-Http {
   param([string] $Url)
   try {
      $response = $Http.GetAsync($Url).GetAwaiter().GetResult()
      try { return [int]$response.StatusCode -eq 200 } finally { $response.Dispose() }
   } catch { return $false }
}

function Labels {
   param([string] $Key)
   $pattern = "(?m)^\s*" + [regex]::Escape($Key) + ': "([^"\r\n]+)"'
   return @([regex]::Matches($Catalog, $pattern) | ForEach-Object { $_.Groups[1].Value })
}

function Name-Condition {
   param([string[]] $Names)
   $conditions = [System.Windows.Automation.Condition[]]@($Names | ForEach-Object {
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $_)
   })
   if ($conditions.Count -eq 1) { return $conditions[0] }
   if ($conditions.Count -eq 0) { throw "Missing UI test label" }
   return [System.Windows.Automation.OrCondition]::new($conditions)
}

function Find-Control {
   param([string[]] $Names, [object] $ControlType = $null, [object] $Within = $Window)
   $condition = Name-Condition $Names
   if ($ControlType) {
      $condition = [System.Windows.Automation.AndCondition]::new(
         $condition,
         [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ControlType)
      )
   }
   return $Within.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Wait-Connected {
   Wait-For -Description "connected native window" -Condition {
      try {
         $Native.Refresh()
         $handle = $Native.MainWindowHandle
         if ($handle -eq [IntPtr]::Zero) { return $false }
         $script:Window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
         if ($Window.Current.ProcessId -ne $Native.Id) { return $false }
         return $null -ne (Find-Control -Names (Labels "connected"))
      } catch { return $false }
   }
}

function Invoke-Button {
   param([string[]] $Names, [object] $Within = $Window)
   $script:Button = $null
   Wait-For -Description "enabled UI action" -Condition {
      $script:Button = Find-Control -Names $Names -ControlType ([System.Windows.Automation.ControlType]::Button) -Within $Within
      return $null -ne $Button -and $Button.Current.IsEnabled
   }
   $pattern = $Button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
   $pattern.Invoke()
}

function Read-RoomLink {
   [Windows.Forms.Clipboard]::Clear()
   Invoke-Button -Names (Labels "copyRoomLink")
   Wait-For -Description "copied room link" -Condition {
      try {
         $value = [Windows.Forms.Clipboard]::GetText()
         $uri = $null
         if ([Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$uri) -and $uri.Scheme -eq "http" -and $uri.AbsolutePath.StartsWith("/room/") -and $uri.Fragment.StartsWith("#t=")) {
            $script:JoinUrl = $value
            return $true
         }
      } catch { }
      return $false
   }
   [Windows.Forms.Clipboard]::Clear()
}

function Invoke-Protocol {
   param([string] $Phase)
   $start = [Diagnostics.ProcessStartInfo]::new()
   $start.FileName = $NodePath
   $helper = Join-Path $PSScriptRoot "test-webview2-preview-protocol.mjs"
   $start.Arguments = '"' + $helper + '" --phase ' + $Phase
   $start.UseShellExecute = $false
   $start.CreateNoWindow = $true
   $start.RedirectStandardInput = $true
   $start.RedirectStandardOutput = $true
   $start.RedirectStandardError = $true
   $process = [Diagnostics.Process]::Start($start)
   $stdout = $process.StandardOutput.ReadToEndAsync()
   $stderr = $process.StandardError.ReadToEndAsync()
   $process.StandardInput.WriteLine((@{
      joinUrl = $JoinUrl
      fixturePath = $FixturePath
      statePath = $StatePath
      receiveDir = $ReceiveDir
   } | ConvertTo-Json -Compress))
   $process.StandardInput.Close()
   if (-not $process.WaitForExit(90000)) {
      $process.Kill()
      throw "Preview protocol phase timed out: $Phase"
   }
   $text = $stdout.GetAwaiter().GetResult()
   $errorText = $stderr.GetAwaiter().GetResult().Trim()
   if ($process.ExitCode -ne 0) {
      if ($errorText -match '^WEBVIEW2_PROTOCOL_FAILURE=[a-z0-9-]+$') {
         throw "Preview protocol phase failed: $Phase; $errorText"
      }
      throw "Preview protocol phase failed: $Phase"
   }
   return $text | ConvertFrom-Json
}

function Select-NativeFile {
   Invoke-Button -Names (Labels "addFiles")
   $script:FileDialog = $null
   Wait-For -Description "native file dialog" -Condition {
      $condition = [System.Windows.Automation.AndCondition]::new(
         [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$Native.Id),
         [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ClassNameProperty, "#32770")
      )
      $script:FileDialog = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
         [System.Windows.Automation.TreeScope]::Children, $condition
      )
      return $null -ne $FileDialog
   }
   $id = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "1148")
   $nameBox = $FileDialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $id)
   if ($null -eq $nameBox) { throw "Native file dialog has no filename control" }
   if ($nameBox.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) {
      $nameBox = $nameBox.FindFirst(
         [System.Windows.Automation.TreeScope]::Descendants,
         [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      )
   }
   if ($null -eq $nameBox) { throw "Native file dialog has no filename edit" }
   $nameBox.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($FixturePath)
   $open = $FileDialog.FindFirst(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "1")
   )
   if ($null -eq $open) { throw "Native file dialog has no Open action" }
   $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}

function Exercise-SharedTextUi {
   Invoke-Button -Names @((Labels "sharedText") + (Labels "sharedTextUnread"))
   $script:Editor = $null
   Wait-For -Description "shared text loaded in native UI" -Condition {
      $script:Editor = Find-Control -Names (Labels "sharedTextAreaLabel") -ControlType ([System.Windows.Automation.ControlType]::Edit)
      if ($null -eq $Editor -or -not $Editor.Current.IsEnabled) { return $false }
      return $Editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value -eq "WebView2 preview: HTTP shared text"
   }
   $Editor.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue("WebView2 preview: native shared text")
   Invoke-Button -Names (Labels "sharedTextShare")
   Wait-For -Description "shared text save completed" -Condition {
      return $null -ne (Find-Control -Names (Labels "sharedTextShared"))
   }
   Invoke-Button -Names (Labels "close")
}

function File-Hash {
   param([string] $Path)
   $algorithm = [Security.Cryptography.SHA256]::Create()
   $stream = [IO.File]::OpenRead($Path)
   try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
   finally { $stream.Dispose(); $algorithm.Dispose() }
}

New-Item -ItemType Directory -Path $RunRoot, $PackageRoot, $DataRoot, $EvidenceRoot -Force | Out-Null
try {
   [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $PackageRoot)
   $Executable = Join-Path $PackageRoot "LocalFileTransferPreview.exe"
   if (-not (Test-Path -LiteralPath $Executable)) { throw "Preview ZIP is missing its root executable" }
   Invoke-Protocol -Phase prepare | Out-Null
   $start = [Diagnostics.ProcessStartInfo]::new()
   $start.FileName = $Executable
   $start.WorkingDirectory = $PackageRoot
   $start.UseShellExecute = $false
   $start.EnvironmentVariables["LFT_WEBVIEW2_USER_DATA_DIR"] = $DataRoot
   $start.EnvironmentVariables["LFT_SMOKE_LOOPBACK_ONLY"] = "1"
   $Stage = "launch"
   $StartupClock = [Diagnostics.Stopwatch]::StartNew()
   $Native = [Diagnostics.Process]::Start($start)
   [void]$TrackedIds.Add($Native.Id)
   Wait-For -Description "initial service-ready" -Seconds 90 -Condition {
      return @(Get-Records | Where-Object event -eq "service-ready").Count -ge 1
   }
   $serviceReadySeconds = $StartupClock.Elapsed.TotalSeconds
   $first = @(Get-Records | Where-Object event -eq "service-ready")[0]
   $BaseUrl = "http://127.0.0.1:$([int]$first.details.port)"
   Wait-For -Description "initial HTTP health" -Condition { Test-Http "$BaseUrl/healthz" }
   Wait-For -Description "initial app HTML" -Condition { Test-Http "$BaseUrl/app" }
   $appHttpReadySeconds = $StartupClock.Elapsed.TotalSeconds
   Wait-Connected
   $desktopConnectedSeconds = $StartupClock.Elapsed.TotalSeconds
   $StartupClock.Stop()
   Track-Processes
   $Stage = "native-file-and-http-transfer"
   Read-RoomLink
   Select-NativeFile
   $Transfer = Invoke-Protocol -Phase exercise
   $Stage = "shared-text-ui"
   Exercise-SharedTextUi
   $SharedText = Invoke-Protocol -Phase verify-ui
   $Stage = "service-recovery"
   $Service = @(Get-RelatedProcesses | Where-Object {
      $_.Name -eq "LocalFileTransferService.exe" -and $_.ParentProcessId -eq $Native.Id
   }) | Select-Object -First 1
   if (-not $Service) { throw "No isolated service child was found" }
   [void]$TrackedIds.Add([int]$Service.ProcessId)
   $recoveryClock = [Diagnostics.Stopwatch]::StartNew()
   Stop-Process -Id ([int]$Service.ProcessId) -Force
   Wait-For -Description "recovered service-ready" -Condition {
      $records = @(Get-Records | Where-Object event -eq "service-ready")
      return $records.Count -ge 2 -and [int]$records[-1].details.serviceRestarts -ge 1
   }
   $last = @(Get-Records | Where-Object event -eq "service-ready")[-1]
   $RecoveredBaseUrl = "http://127.0.0.1:$([int]$last.details.port)"
   Wait-For -Description "recovered HTTP health" -Condition { Test-Http "$RecoveredBaseUrl/healthz" }
   Wait-Connected
   $recoveryClock.Stop()
   Read-RoomLink
   $Recovery = Invoke-Protocol -Phase recover
   Track-Processes
   $WebViewProcesses = @(Get-RelatedProcesses | Where-Object Name -eq "msedgewebview2.exe")
   $RuntimeVersion = if ($WebViewProcesses.Count -gt 0) {
      [Diagnostics.FileVersionInfo]::GetVersionInfo($WebViewProcesses[0].ExecutablePath).FileVersion
   } else { $null }
   $Stage = "shutdown"
   $Native.Refresh()
   if (-not $Native.CloseMainWindow()) { throw "Native window rejected graceful close" }
   Wait-For -Description "native and service shutdown" -Condition {
      Track-Processes
      return @(Get-RelatedProcesses).Count -eq 0
   }
   Wait-For -Description "HTTP endpoint shutdown" -Condition { -not (Test-Http "$RecoveredBaseUrl/healthz") }
   $report = [ordered]@{
      schemaVersion = 1
      version = $Manifest.version
      sourceCommit = $SourceCommit
      testedAt = (Get-Date).ToUniversalTime().ToString("o")
      artifact = $ArchiveName
      archiveSha256 = File-Hash $Archive
      architecture = "x64"
      extractedDistributionTested = $true
      webview2RuntimeVersion = $RuntimeVersion
      loopbackOnlyForSmoke = $true
      developerDebuggingEnabled = $false
      serviceReadySeconds = [math]::Round($serviceReadySeconds, 3)
      windowVisibleSeconds = [math]::Round($WindowVisibleSeconds, 3)
      windowVisibilityProbe = "first-nonzero-main-window-handle-observed"
      appHttpReadySeconds = [math]::Round($appHttpReadySeconds, 3)
      desktopConnectedSeconds = [math]::Round($desktopConnectedSeconds, 3)
      desktopReadinessProbe = "windows-ui-automation-connected-status"
      desktopReadyBeforeInterruption = $true
      interruptionRecoverySeconds = [math]::Round($recoveryClock.Elapsed.TotalSeconds, 3)
      transfer = $Transfer
      sharedText = $SharedText
      recovery = $Recovery
      gracefulWindowClose = $true
      endpointClosed = $true
      residualProcesses = 0
      arm64RuntimeMeasured = $false
   }
   $json = $report | ConvertTo-Json -Depth 10
   [IO.File]::WriteAllText((Join-Path $EvidenceRoot "WEBVIEW2_SMOKE.json"), $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
   $json
} catch {
   # Failure output intentionally excludes UI trees, response bodies, paths and logs.
   $failure = [ordered]@{ schemaVersion = 1; phase = $Stage; lastCheck = $LastCheck; errorType = $_.Exception.GetType().Name; passed = $false }
   [IO.File]::WriteAllText((Join-Path $EvidenceRoot "WEBVIEW2_SMOKE_FAILURE.json"), ($failure | ConvertTo-Json) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
   [Console]::Error.WriteLine("WEBVIEW2_SMOKE_FAILURE=" + ($failure | ConvertTo-Json -Compress))
   throw "WebView2 preview smoke failed in phase $Stage"
} finally {
   $JoinUrl = $null
   try {
      if ($PreviousClipboard) { [Windows.Forms.Clipboard]::SetText($PreviousClipboard) } else { [Windows.Forms.Clipboard]::Clear() }
   } catch { }
   foreach ($process in @(Get-RelatedProcesses)) {
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
   }
   $Http.Dispose()
   $HttpHandler.Dispose()
   if ((Split-Path -Leaf $RunRoot).StartsWith("lft-webview2-smoke-")) {
      Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction SilentlyContinue
   }
}

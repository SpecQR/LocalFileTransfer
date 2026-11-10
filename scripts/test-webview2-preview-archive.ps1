param(
   [Parameter(Mandatory = $true)]
   [ValidateSet("x64", "arm64")]
   [string] $Architecture
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Root = Split-Path -Parent $PSScriptRoot
$Manifest = Get-Content -LiteralPath (Join-Path $Root "apps/webview2/preview.json") -Raw | ConvertFrom-Json
$Stage = [IO.Path]::GetFullPath((Join-Path $Root "apps/webview2/release/$Architecture"))
$Archive = Join-Path $Root "apps/webview2/release/Local.File.Transfer-WebView2-Preview-$($Manifest.version)-$Architecture.zip"
$TempParent = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$RunRoot = Join-Path $TempParent ("lft-webview2-archive-" + [guid]::NewGuid().ToString("N"))
$Extracted = Join-Path $RunRoot "package"
$Phase = "prepare"

function File-Digest {
   param([string] $Path)
   $hash = [Security.Cryptography.SHA256]::Create()
   $stream = [IO.File]::OpenRead($Path)
   try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() }
   finally { $stream.Dispose(); $hash.Dispose() }
}

function File-Inventory {
   param([string] $Directory)
   $prefix = [IO.Path]::GetFullPath($Directory).TrimEnd("\") + "\"
   $files = [Collections.Generic.SortedDictionary[string, string]]::new([StringComparer]::Ordinal)
   foreach ($path in [IO.Directory]::EnumerateFiles($Directory, "*", [IO.SearchOption]::AllDirectories)) {
      $relative = $path.Substring($prefix.Length).Replace("\", "/")
      $files.Add($relative, (File-Digest $path))
   }
   return ,$files
}

try {
   New-Item -ItemType Directory -Path $RunRoot, $Extracted | Out-Null
   $Phase = "archive-entry-boundary"
   $prefix = [IO.Path]::GetFullPath($Extracted).TrimEnd("\") + "\"
   $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
   try {
      foreach ($entry in $zip.Entries) {
         $path = [IO.Path]::GetFullPath((Join-Path $Extracted $entry.FullName))
         if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Archive entry escapes the isolated package directory"
         }
      }
   } finally { $zip.Dispose() }

   $Phase = "extract-archive"
   [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Extracted)
   $Phase = "compare-all-file-hashes"
   $expected = File-Inventory $Stage
   $actual = File-Inventory $Extracted
   if ($expected.Count -eq 0 -or $expected.Count -ne $actual.Count) { throw "Archive file count differs from the verified stage" }
   foreach ($name in $expected.Keys) {
      if (-not $actual.ContainsKey($name) -or $actual[$name] -ne $expected[$name]) {
         throw "Archive content differs from the verified stage"
      }
   }
   [ordered]@{
      architecture = $Architecture
      archiveContentsMatchedStage = $true
      validatedArchiveFiles = $actual.Count
   } | ConvertTo-Json -Compress
} catch {
   [Console]::Error.WriteLine("WEBVIEW2_ARCHIVE_FAILURE=" + $Phase)
   exit 1
} finally {
   if ((Split-Path -Leaf $RunRoot) -match '^lft-webview2-archive-[a-f0-9]{32}$') {
      Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction SilentlyContinue
   }
}

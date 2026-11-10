# ビルドとリリース

## Release model

Local File Transfer の public artifact は Windows Portable EXE です。`v<package version>` tag だけが `.github/workflows/release.yml` を起動し、同じ Windows runner 上で検証、x64/ARM64 build、evidence 生成、GitHub Artifact Attestation、GitHub Release 公開までを行います。SemVer に prerelease suffix がある場合だけ prerelease、それ以外は stable / Latest として公開します。

Release workflow は途中の test result や手元で作った EXE を再利用しません。Tag の source と 4 scope の lockfile から clean install し、公開する exact artifact をその run 内で作ります。

`electron-builder` は全 release script で `--publish never` とし、tag event と `GH_TOKEN` を検出して draft へ先行 upload しないよう固定します。GitHub Release の作成、asset upload、publish は、すべての gate と staging が完了した後に workflow の明示 step だけが行います。Stable の `--latest` は draft 作成時には渡さず、`--draft=false` と同時にだけ指定します。

Source と lockfile は rebuild 可能な入力として固定しますが、Electron/NSIS metadata 等のため bit-for-bit reproducible build は主張しません。公開 EXE と build workflow/source commit の結び付けは GitHub Artifact Attestation、実体の同一性は SHA-256 で確認します。

## Toolchain

- Node.js 22
- npm
- Windows 10/11 compatible GitHub-hosted Windows runner
- Portable package と local packaged smoke を手動実行する場合は Windows
- ARM64 runtime を検証済みと表記する場合は物理 Windows on ARM
- Authenticode signing を行う場合だけ、release environment から渡す code-signing certificate

Root、server、web、desktop は独立した lockfile scope です。

```powershell
npm ci
npm ci --prefix apps/server
npm ci --prefix apps/web
npm ci --prefix apps/desktop
```

## Source gate

```powershell
npm run audit:public
npm run test:all
npm run build
npm run test:e2e
npm run verify:release-config
```

Dependency audit:

```powershell
npm audit --audit-level=high
npm audit --audit-level=high --prefix apps/server
npm audit --audit-level=high --prefix apps/web
npm audit --audit-level=high --prefix apps/desktop
```

`audit:public` は、version の全 scope 一致、互換性を検証した SpecQR 3.0.0-rc.2 exact pin、必須文書、private path、credential-like text、database、EXE、key material、private work log を検査します。

## Portable build

```powershell
npm run dist:windows
npm run dist:windows:arm64
```

Current package version:

```text
Local.File.Transfer-<version>-x64-Portable.exe
Local.File.Transfer-<version>-arm64-Portable.exe
```

Executable は Git に commit せず、GitHub Release asset としてだけ公開します。

### Portable の起動時展開

次回 release 向けの source は `portable.useZip: true` と `compression: normal` を使用します。固定した electron-builder 26.15.3 では、この組合せは NSIS の non-solid zlib/Deflate により、アプリのファイルを実行先の一時フォルダーへ直接展開します。配布物は従来どおり 1 個の Portable EXE です。

従来の既定値は、内蔵した 7z/LZMA archive を一度別の一時フォルダーへ展開し、その内容を実行先へ全てコピーする経路でした。新しい方式では、その追加コピーも省きます。圧縮率より展開時間を優先するため EXE は大きくなる見込みですが、増加量と起動時間は同じ source から作った両方式の artifact で比較します。公開済み v2.0.1 との直接比較には、それ以降の Electron / dependency 更新も混ざります。

一時展開と終了時の削除は継続します。`unpackDirName` の固定は展開済みファイルの再利用を意味せず、起動キャッシュの代わりにはなりません。永続的な実行ファイルキャッシュやインストーラーは追加していません。

#### ARM64 の build-time workaround

electron-builder 26.15.3 の `portable.nsi` には、`useZip` を使って ARM64 だけを package した場合の direct-extraction branch がありません。Portable target では installer 向けの `script` / `include` override も使えないため、`apps/desktop/scripts/prepare-portable.cjs` を `beforePack` hook として実行し、この branch だけを補います。

Hook は `app-builder-lib` の version と template 全体の SHA-256 を照合し、既知の原文または適用済みの結果だけを受け入れます。内容が変わった場合は build を停止するため、dependency 更新時には workaround の継続要否を確認してください。Launcher の実行待ち、終了コード、一時フォルダー削除、Electron fuse は変更しません。

参照する source は lockfile で固定した `app-builder-lib@26.15.3` package 内の次のファイルです。

- `out/targets/nsis/NsisTarget.js`: Portable target と圧縮設定
- `templates/nsis/portable.nsi`: Portable launcher
- `templates/nsis/include/extractAppPackage.nsh`: 従来の archive 展開とコピー

#### 同一 source の起動比較

`.github/workflows/portable-startup.yml` は関連 source の Pull Request で、Windows 2022 runner 上の E2E、従来の 7z 方式、変更後の x64 / ARM64 build、PE / fuse check を実行します。比較用 baseline だけ `--config.portable.useZip=false` を指定し、runtime と dependency の差が結果に混ざらないようにします。

`scripts/compare-portable-startup.ps1` は baseline と optimized の EXE path を受け取り、それぞれ 1 回の warm-up 後に 3 回ずつ順番を交互にして実行します。各回は新しい隔離 storage を使い、起動後に既存 packaged smoke の service recovery と graceful shutdown も検証します。

計測の開始点は `Start-Process` 直前の Stopwatch です。最初の `service-ready` log の観測、`/healthz` の HTTP 200、`/app` の HTTP 200 を別々の秒数として記録します。Polling 間隔は 200 ms であり、画面や QR の描画完了、OS の cold boot、物理 Windows on ARM の時間は測っていません。従来の smoke evidence の `launchSeconds` は復旧試験開始までの時間を含むため、起動性能の比較には使用しません。

Workflow はサイズ、SHA-256、各回の秒数、中央値、測定条件を含む `STARTUP_COMPARISON.json` と `PACKAGING_VALIDATION.json` だけを Actions artifact に保存します。EXE の公開は従来の tag-driven release workflow が担当します。Benchmark が通っただけで release gate や物理端末の確認を完了したとは扱いません。

## Electron security gate

```powershell
npm run verify:release-config
npm run verify:fuses --prefix apps/desktop
npm run verify:fuses:arm64 --prefix apps/desktop
```

Gate は Portable-only target、version/architecture を含む artifact name、signing secret の非埋め込み、renderer sandbox/isolation、navigation/permission denial、ASAR integrity、cookie encryption、RunAsNode/Node options/CLI inspect/file privilege の無効化を確認します。

## Browser、DPI、packaged recovery

```powershell
npm run test:e2e
npm run test:visual
npm run test:packaged
```

- E2E は iPhone-sized WebKit と Android-sized Chromium を使用します。
- Visual gate は Windows scale 100%、125%、150%、200% で 300 CSS px geometry、QR square、dialog、overflow を検査します。
- Packaged smoke は生成した x64 Portable EXE を `--disable-gpu` と `LFT_SMOKE_LOOPBACK_ONLY=1` で起動し、health/app response、SQLite creation、Utility Process の強制終了と自動復旧、graceful close、endpoint close、residual process 0 を確認します。非対話 CI では Windows Firewall prompt に依存せず `127.0.0.1` bind を検証します。本番 runtime は従来どおり `0.0.0.0` bind で、GPU/rendering と LAN/Firewall は native Electron visual gate と manual checklist が担当します。

ARM64 artifact は PE machine と Electron fuse を自動検証します。物理 Windows on ARM で起動していない限り、runtime verified と記載しません。

## Evidence と release asset

両 EXE、packaged smoke、visual report が揃った後に実行します。

```powershell
npm run release:evidence
npm run release:static-validation
npm run release:stage
```

`release:evidence` は `docs/release/<version>` に次を生成します。

- 4 scope の CycloneDX SBOM
- 4 scope の npm audit JSON
- Dependency と license inventory
- Third-party license reference
- EXE size、SHA-256、architecture、Authenticode status

`release:static-validation` は PE、Electron fuse、packaged recovery、DPI geometry、Shared text storage claim、missing signing input rejection を 1 つの machine-readable report にまとめます。

`release:stage` は `release-assets/v<version>` に exact EXE と公開可能な evidence だけを集め、tag/version、artifact hash、evidence version を再検証します。Local absolute path、live credential、user file は `BUILD_PROVENANCE.json` に含めません。

GitHub Actions で attestation bundle を追加した後、次を実行して最終 manifest と checksum を再生成します。

```powershell
npm run release:finalize
```

主な asset:

1. x64 Portable EXE
2. ARM64 Portable EXE
3. `SHA256SUMS.txt`
4. `RELEASE_MANIFEST.json`
5. `BUILD_PROVENANCE.json`
6. Build provenance Sigstore bundle
7. Desktop SBOM Sigstore bundle
8. 4 scope の CycloneDX SBOM
9. Audit、dependency、license、static/package evidence
10. 日本語 release notes

## GitHub Artifact Attestation

Release workflow は immutable commit SHA に pin した `actions/attest` を使い、両 EXEへ次の 2 種類を作成します。

- SLSA build provenance
- Desktop CycloneDX SBOM attestation

Attestation は Authenticode の代替ではありません。

- GitHub Attestation: artifact、repository、workflow、source commit の来歴と integrity を検証する。
- Authenticode: Windows publisher identity と code-signing certificate chain を検証する。

Artifact が Authenticode 未署名なら、Release Notes と evidence に `NotSigned` を残します。Publisher identity があるように見せてはいけません。

Release tooling は PowerShell module に依存せず、Node.js で SHA-256 を計算し、PE security directory と `WIN_CERTIFICATE` table の構造を検査します。Certificate table が存在しない場合は `NotSigned`、構造上存在するが trust chain を検証していない場合は `PresentUnverified` です。後者を `Valid` と読み替えてはいけません。将来 Authenticode signing を有効にする場合は、Windows trust policy による別の署名検証 gate が必要です。

Download 後の検証:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\Local.File.Transfer-<version>-x64-Portable.exe
gh attestation verify .\Local.File.Transfer-<version>-x64-Portable.exe --repo SpecQR/LocalFileTransfer
```

GitHub CLI を使用しない場合も、`SHA256SUMS.txt` と EXE の SHA-256 は照合できます。

## Tag と publication

1. Source、test、文書、version を review する。
2. `main` の reviewed commit に annotated tag `v<version>` を付ける。
3. Tag を push する。
4. `Windows release` workflow が全 gate を clean runner で再実行する。
5. Workflow が artifact を attest し、version に対応する prerelease または stable Release draft を作成する。
6. Workflow が release asset count、release channel、tag commit、attestation を再検証してから公開する。
7. Maintainer が public Release page の asset、size、SHA-256、workflow result を確認する。

Tag 以外から release workflow を起動しても release job は実行されません。失敗した run は修正 commit と新しい tag を原則とし、同じ tag の付け替えで不一致を隠しません。

## Signing

Signing command は environment-only credential を要求します。

```powershell
npm run dist:windows:signed:x64
npm run dist:windows:signed:arm64
```

`WIN_CSC_LINK` と `WIN_CSC_KEY_PASSWORD` 等は release environment だけから渡します。Certificate、password、encoded key、`.env`、secret を source、workflow log、evidence に含めません。

現在の公開 artifact は Authenticode 未署名です。自己署名で公開ユーザーへ誤った安心を与えず、SignPath Foundation、Microsoft Store MSIX、OV certificate などの採用条件が整った場合だけ Windows trust-policy gate とともに有効化します。判断根拠は [コード署名方針](CODE_SIGNING.md) に記録します。

## Verification truth

Release Notes は次を区別して記載します。

- Automated browser profile と物理 iPhone/Android
- x64 packaged smoke と実利用環境
- ARM64 static check と物理 Windows on ARM runtime
- SHA-256/GitHub Attestation と Authenticode
- Encrypted at rest と E2EE

未実施の gate を positive claim に変更しません。Evidence と source behavior が一致しない場合は publication を停止します。

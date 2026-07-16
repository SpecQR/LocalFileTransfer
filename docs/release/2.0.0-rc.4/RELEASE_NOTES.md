# Local File Transfer 2.0.0-rc.4

RC.2 の compact な 1 room UI と操作方法を維持しながら、upload durability、通信断復帰、service lifecycle、公開 API、release supply chain を強化した prerelease です。

RC.4 の app 機能は RC.3 candidate と同じです。RC.3 は Windows Server 2025 hosted runner の packaged smoke で公開前に停止したため Release を作成せず、tag を履歴として保持しました。RC.4 は release qualification を Windows Server 2022 に固定し、loopback probe と失敗証跡を強化しています。

## 主な変更

- Browser upload の write、`fsync`、SQLite commit、ACK 境界へ fault injection test を追加しました。
- Commit 前に file だけが進んだ場合は rollback/startup truncate、SQLite offset が実在 byte より進んだ場合は startup rewind します。
- Final checkpoint の commit 後に ACK が失われても、idempotent replay で duplicate byte なしに completion を回復します。
- SSE、5 秒 polling、`online`/`offline`、`pageshow`、`visibilitychange` を統合し、通信断中だけ reconnect UI を表示します。
- Windows の sleep/resume、unlock、adapter change 後に local origin と QR を再評価します。
- Diagnostics に匿名化した recovery counter を追加しました。File name、path、content、capability は含めません。
- 旧 `/api/local/*` は test-only opt-in とし、通常の Portable runtime から外しました。
- 旧 `PUT .../chunks` endpoint を廃止し、upload protocol を `HEAD` + resumable `PATCH` に一本化しました。
- Tag-driven GitHub Actions release、CycloneDX SBOM、SHA-256 manifest、build provenance、Sigstore attestation bundle を追加しました。

## 維持したもの

- Windows Portable EXE 1 個で起動
- 300 CSS px の compact desktop UI
- SpecQR 2.4.0、SVG、4 module quiet zone
- 1 QR、1 room、双方向 file queue、Shared text
- 3 row まで window auto-grow、それ以上は queue-local scroll
- Account、cloud、relay、telemetry、updater なし

## 実行ファイル

- `Local.File.Transfer-2.0.0-rc.4-x64-Portable.exe`: 通常の Intel/AMD Windows
- `Local.File.Transfer-2.0.0-rc.4-arm64-Portable.exe`: Windows on ARM

両 artifact は **Authenticode 未署名** です。Windows SmartScreen が警告を表示する場合があります。GitHub Artifact Attestation は build provenance を検証しますが、Windows publisher identity を証明する Authenticode の代替ではありません。

SHA-256 は同じ Release の `SHA256SUMS.txt` を使用してください。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath .\Local.File.Transfer-2.0.0-rc.4-x64-Portable.exe
gh attestation verify .\Local.File.Transfer-2.0.0-rc.4-x64-Portable.exe --repo SpecQR/LocalFileTransfer
```

## セキュリティ上の前提

Browser page と file traffic は local HTTP です。**信頼できる LAN 内だけで使用してください。**

File transfer は E2EE ではなく、active LAN attacker から confidentiality を提供しません。Shared text は SQLite 上で AES-256-GCM encrypted at rest ですが、authorized client へ返す local service が復号するため E2EE ではありません。

QR は room lifetime 中の bearer capability です。使用後は Reset し、live QR screenshot を公開しないでください。

## 検証範囲

Release workflow は unit/integration/release-script 100 件、browser/Electron E2E 2 件、production build、dependency audit、x64/ARM64 Portable build、PE/fuse、DPI geometry、x64 packaged service recovery、SBOM/evidence、attestation を実行します。Exact result は添付の `RELEASE_EVIDENCE.json`、`STATIC_VALIDATION.json`、`PACKAGED_SMOKE.json` を参照してください。

x64 packaged smoke は HTTP、SQLite、utility-process restart、graceful shutdown を分離して検証するため `--disable-gpu` と `LFT_SMOKE_LOOPBACK_ONLY=1` で起動します。非対話 CI では Windows Firewall prompt に依存せず `127.0.0.1` bind を検証し、本番 runtime は従来どおり `0.0.0.0` bind です。QR と renderer の描画は別の Chromium/WebKit E2E と 100%/125%/150%/200% DPI geometry gate で検証します。

次は automated browser profile または static gate であり、物理 device verification ではありません。

- iPhone-sized WebKit
- Android-sized Chromium
- ARM64 PE/fuse/static validation

物理 iPhone Safari、Android Chrome、Windows on ARM runtime、および実機での sleep/adapter 切替は未実施の manual qualification item として明記します。

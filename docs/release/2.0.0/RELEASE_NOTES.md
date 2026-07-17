# Local File Transfer 2.0.0

Local File Transfer の最初の stable release です。Windows で Portable EXE を 1 つ起動し、同じローカルネットワーク上の iPhone、iPad、Android、macOS、別の Windows と、QR から双方向にファイルと短いテキストを受け渡せます。

RC.6 から転送 protocol、保存形式、UI の機能変更はありません。実運用で確認した候補をそのまま正式版とし、今後は具体的な不具合が見つかるまで機能追加を止めます。

## 主な機能

- Install、account、cloud storage、public relay、telemetry、automatic updater が不要な Windows Portable application
- [SpecQR 2.4.0](https://github.com/SpecQR/SpecQR) による、4 module quiet zone を含む SVG QR
- Windows から Browser、Browser から Windows の双方向 file transfer
- 複数 file、HTTP Range、streaming ZIP、SHA-256 verification
- 1 MiB checkpoint、`fsync`、SQLite commit、idempotency key に基づく resumable upload
- Page reload、sleep/resume、network adapter refresh、Utility Process restart 後の state recovery
- 明示的な Shared text、revision conflict、64 KiB UTF-8 limit、AES-256-GCM encrypted at rest
- 日本語・英語、keyboard、touch target、reduced motion、100-200% Windows DPI へ対応する compact UI

## 検証

- Protocol、release tooling、server、web の unit / integration test
- iPhone-sized WebKit と Android-sized Chromium の双方向 file / Shared text E2E
- 15 MiB JPEG と複数 file の mobile upload regression
- x64 Portable の起動、local service、SQLite、Utility Process recovery、graceful shutdown、residual process 0
- x64 / ARM64 build、PE architecture、Electron fuse、release configuration
- Windows scale 100%、125%、150%、200% の QR geometry、overflow、dialog、manual resize
- Dependency audit、CycloneDX SBOM、SHA-256、GitHub build provenance / SBOM attestation
- 物理 iPhone SE（第2世代）と iPhone 16e の Safari で、Shared text 入力時にページが自動拡大されないこと

物理 Android と Windows on ARM の runtime は未確認です。Automated browser profile と ARM64 static validation を物理 device test として扱いません。

## セキュリティ上の前提

- 信頼できる同一 LAN 内だけで使用してください。
- Browser UI と file transfer は local HTTP で、E2EE ではありません。
- QR は room が有効な間の bearer capability です。使用後は Reset してください。
- Shared text は Windows 上で encrypted at rest ですが、認可済み client へ返すため service が復号します。
- Portable EXE は Authenticode 未署名です。GitHub Artifact Attestation は Windows publisher signing の代替ではありません。

署名を急いで自己署名に置き換えず、現在の判断と将来の採用条件を [コード署名方針](https://github.com/SpecQR/LocalFileTransfer/blob/v2.0.0/docs/CODE_SIGNING.md) に記録しています。

## Download

- Intel / AMD Windows: `Local.File.Transfer-2.0.0-x64-Portable.exe`
- Windows on ARM: `Local.File.Transfer-2.0.0-arm64-Portable.exe`

`SHA256SUMS.txt` で download file を照合してください。GitHub CLI を利用できる場合は、次でも provenance を確認できます。

```powershell
gh attestation verify .\Local.File.Transfer-2.0.0-x64-Portable.exe --repo SpecQR/LocalFileTransfer
```

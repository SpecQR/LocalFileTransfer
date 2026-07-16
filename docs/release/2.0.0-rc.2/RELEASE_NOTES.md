# Local File Transfer 2.0.0-rc.2

Local File Transfer の最初の public release です。1 つの Windows Portable application で、trusted local network 上の双方向 file transfer と、明示操作による Shared text を提供します。

## 主な機能

- SpecQR 2.4.0 の SVG QR を 1 回 scan し、両 endpoint から同じ room を利用できます。
- iPhone、iPad、Android、macOS、別の Windows browser から Windows へ upload できます。
- Windows で選択した file を、HTTP Range 対応 download で browser へ送れます。
- Browser upload は、SHA-256 を検証して disk へ commit 済みの checkpoint から resume します。
- Ready file が複数ある場合は、streaming ZIP としてまとめて download できます。
- 64 KiB の Shared text を 1 件共有でき、revision conflict を明示的に解決できます。
- 日本語・英語の compact desktop/mobile UI を備えます。
- Account、cloud storage、public relay、telemetry、installation、hosted service は不要です。

## 実行ファイルの選択

- `Local.File.Transfer-2.0.0-rc.2-x64-Portable.exe`: 通常の Intel/AMD Windows PC
- `Local.File.Transfer-2.0.0-rc.2-arm64-Portable.exe`: Windows on ARM

両 artifact は **Authenticode 未署名** です。Windows SmartScreen が警告を表示する場合があります。

- x64 artifact は packaged launch、Utility Process recovery、clean shutdown smoke を通過しました。
- ARM64 artifact は build、PE machine、Electron fuse、static validation を通過しましたが、物理 ARM64 hardware では実行していません。

## セキュリティ上の前提

Certificate installation なしで Camera scan から利用できるよう、browser page と file traffic は local HTTP を使用します。**信頼できる network 内だけで使用してください。**

File transfer は end-to-end encrypted ではなく、active LAN attacker から保護しません。Shared text は SQLite 上で AES-256-GCM により encrypted at rest ですが、authorized room client へ返すため local Windows service が復号します。Shared text も E2EE ではありません。

QR は一時的な bearer capability です。使用後は Reset し、live QR の screenshot を公開しないでください。

## SHA-256

```text
2A204299CAF932DF4BD13202E8A9F0D0FD44B4973CCDB28B13D5A70165FF1DAD  Local.File.Transfer-2.0.0-rc.2-x64-Portable.exe
07FE5DB06E8059E4F81A35689C522D6414F4D67C0D7C0B60AF9B149E7B4E0172  Local.File.Transfer-2.0.0-rc.2-arm64-Portable.exe
```

Release asset には `SHA256SUMS.txt`、4 scope の CycloneDX SBOM、dependency/license inventory、third-party license inventory、machine-readable validation evidence も含まれます。

## 検証状況

- Unit/integration test: 86
- Desktop/mobile E2E scenario: 2
- Total automated scenario: 88
- Dependency audit: 4 scope、生成時点で known vulnerability 0
- x64 packaged smoke: passed
- x64/ARM64 architecture/fuse/static check: passed
- Windows DPI geometry: 100%、125%、150%、200%

物理 iPhone Safari、Android Chrome、Windows on ARM は、RC qualification の manual item として残っています。Device-specific result を報告する場合は、version と個人情報を含まない reproduction detail を添えてください。

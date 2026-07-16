# Local File Transfer

Local File Transfer is a portable Windows application for bidirectional file transfer and explicit text sharing between devices on the same local network. Scan one SpecQR-generated QR code with iPhone, iPad, Android, macOS, or another Windows device and use the room in a modern browser. No account, cloud storage, public relay, installation, or telemetry is required.

## 概要

Local File Transfer は、Windows 上で一時的な転送ルームを開き、同じローカルネットワーク上の端末とファイルや短いテキストを受け渡す Portable アプリケーションです。

Windows 側に表示された QR コードを端末の標準カメラで読み取ると、通常のブラウザから同じルームへ参加できます。Windows から相手端末へ送る場合も、iPhone・iPad・Android・macOS・別の Windows から Windows へ送る場合も、同じ画面と同じ QR を使用します。

この公開リポジトリは **2.0.0-rc.2** から始まります。また、[SpecQR 2.4.0](https://github.com/SpecQR/SpecQR) の実用的な統合例でもあります。ブラウザ UI は、4 module の quiet zone を含む SVG QR を生成し、QR Version を増やさずに利用できる範囲でより強い error correction level を選択します。

## 主な機能

- 1 つの QR で双方向の転送ルームを開き、どちらの端末からでもファイルを追加できます。
- Browser から Windows への upload は、`fsync` と SQLite commit が完了した offset から再開できます。
- 通信断、page reload、Windows sleep/resume、Utility Process restart 後に authoritative state へ再同期します。
- Windows から Browser への download は HTTP Range とファイル単位の SHA-256 に対応します。
- 複数の送信ファイルを、一時 ZIP を作らず streaming ZIP としてまとめて download できます。
- ルームごとに 1 件の Shared text を明示的に共有でき、同時編集時は revision conflict を表示します。
- Desktop window は最大 3 行まで内容に合わせて自動的に伸び、それ以上は queue だけを scroll します。
- 日本語・英語 UI、keyboard 操作、mobile touch target、reduced-motion に対応します。
- Release EXE には SHA-256、CycloneDX SBOM、GitHub build provenance/SBOM attestation を添付します。
- Account、cloud storage、public relay、telemetry、automatic updater はありません。

## 重要なセキュリティ境界

Camera scan だけで利用できるよう、参加ページは証明書を必要としない local HTTP で配信されます。**信頼できる LAN 内だけで使用してください。**

LAN 上で通信を改変できる攻撃者は、HTTP traffic や最初に読み込む JavaScript を変更できる可能性があります。そのため、ファイル転送は end-to-end encrypted ではなく、本プロジェクトは hostile network 上の confidentiality を保証しません。

QR の URL fragment には、一時的な room capability が入ります。Fragment は最初の HTTP request には含まれず、認可後に `HttpOnly; SameSite=Strict` cookie の room ticket へ交換されます。Shared text は SQLite 上で AES-256-GCM により encrypted at rest ですが、認可済み client へ返すため Windows service が復号します。したがって Shared text も E2EE ではありません。

詳しくは [セキュリティモデル](docs/SECURITY_MODEL.md) と [プライバシー](docs/PRIVACY.md) を参照してください。

## ダウンロードと使い方

1. [v2.0.0-rc.3 Release](https://github.com/SpecQR/LocalFileTransfer/releases/tag/v2.0.0-rc.3) を開きます。
2. 通常の Intel/AMD Windows PC では `x64-Portable.exe`、Windows on ARM では `arm64-Portable.exe` を選びます。
3. `SHA256SUMS.txt` と download したファイルの SHA-256 が一致することを確認します。GitHub CLI がある場合は `gh attestation verify <EXE> --repo SpecQR/LocalFileTransfer` でも provenance を検証できます。
4. EXE を起動します。Windows Firewall が表示された場合は、信頼できる private network だけに許可します。
5. 同じ LAN に接続した端末から QR を読み取ります。
6. File を追加し、upload または download します。Reset すると新しいルームが作成され、古い QR は無効になります。

RC.3 の実行ファイルは Authenticode 未署名です。Windows SmartScreen が警告を表示する場合があります。

- x64 build: packaged launch、Utility Process recovery、clean shutdown を含む runtime smoke 済み。
- ARM64 build: build、PE architecture、Electron fuse、static validation 済み。物理 Windows on ARM での runtime test は未実施。

## 開発

必要な環境:

- Node.js 22 以上
- npm
- Portable package と packaged runtime test を行う場合は Windows

4 つの独立した lockfile scope を install します。

```powershell
npm ci
npm ci --prefix apps/server
npm ci --prefix apps/web
npm ci --prefix apps/desktop
```

Build と test:

```powershell
npm run audit:public
npm run test:all
npm run build
npm run test:e2e
```

Windows 用の未署名 Portable build:

```powershell
npm run dist:windows
npm run dist:windows:arm64
```

Signing 用 command は、文書化された certificate 環境変数がない場合に意図的に失敗します。

```powershell
npm run dist:windows:signed:x64
npm run dist:windows:signed:arm64
```

完全な再現手順と release gate は [ビルドとリリース](docs/BUILD_AND_RELEASE.md) に記載しています。

## リポジトリ構成

```text
apps/desktop   Electron shell、validated IPC、Utility Process、packaging
apps/server    Fastify room API、SQLite state、streaming/resumable transfer engine
apps/web       React room UI、browser transfer client、SpecQR integration
packages/      共通 protocol と utility contract
tests/e2e      Desktop/mobile browser の transfer と Shared text flow
scripts/       Build、packaged smoke、evidence、publication safety gate
docs/          Architecture、protocol、security、test、release evidence
```

## ドキュメント

- [Architecture](docs/ARCHITECTURE.md)
- [Room と転送 protocol](docs/PROTOCOL.md)
- [セキュリティモデル](docs/SECURITY_MODEL.md)
- [プライバシー](docs/PRIVACY.md)
- [SpecQR 2.4.0 integration](docs/SPECQR_INTEGRATION.md)
- [Shared text 設計](docs/SHARED_TEXT_DESIGN.md)
- [Reliability design](docs/RELIABILITY.md)
- [Test strategy](docs/TEST_STRATEGY.md)
- [ビルドとリリース](docs/BUILD_AND_RELEASE.md)
- [Maintainer / AI agent 向け context](docs/AI_CONTEXT.md)
- [プロジェクト言語方針](docs/PROJECT_LANGUAGE.md)

## RC.3 の検証状況

Tag-driven release workflow は unit/integration、browser/Electron E2E、x64/ARM64 build、PE/fuse、DPI geometry、x64 packaged service recovery、dependency audit、SBOM、SHA-256、GitHub Artifact Attestation を clean Windows runner で実行します。Exact count と結果は Release に添付した machine-readable evidence を参照してください。

物理 iPhone Safari、Android Chrome、Windows on ARM は release qualification の manual gate です。Automated browser profile や ARM64 static check を物理 device test として扱いません。

## ライセンス

[MIT License](LICENSE) で公開します。日本語の参考説明は [LICENSE_JA.md](docs/LICENSE_JA.md) を参照してください。法的に優先される正文は英語の `LICENSE` です。

Third-party component にはそれぞれの license が適用されます。Release には CycloneDX SBOM と third-party license inventory を添付します。

# 変更履歴

公開上重要な変更をこの文書へ記録します。この repository の公開履歴は RC.2 から始まります。非公開 prototype と公開前 artifact は履歴に含めません。

## [2.0.0] - 2026-07-18

### 正式公開

- RC.6 で確認した転送、復旧、Shared text、compact UI の挙動を変更せず、最初の stable release として公開しました。
- Release workflow が SemVer から prerelease / stable を判定し、stable を GitHub の Latest release として公開後に状態を再検証するようにしました。
- Authenticode は未署名です。SHA-256、CycloneDX SBOM、GitHub build provenance / SBOM attestation を公開し、署名の採用条件を文書化しました。

## [2.0.0-rc.6] - 2026-07-18

### 修正

- Browser client の共有テキスト入力欄を 16 px 以上にし、iPhone Safari でフォーカス時に画面が自動拡大される挙動を防止しました。
- `maximum-scale` や `user-scalable=no` は使用せず、ユーザーが行う通常のピンチズームは維持します。
- Android Chromium と iPhone WebKit の E2E に、入力文字サイズと viewport policy の回帰検査を追加しました。
- 物理 iPhone SE（第2世代）と iPhone 16e の Safari で、自動ズームが発生しないことを確認しました。

## [2.0.0-rc.5] - 2026-07-17

### Release engineering

- Portable artifact の SHA-256 と Authenticode certificate-table presence を Node.js で検査し、PowerShell module の暗黙読み込みへの依存を削除しました。
- PE/DOS signature、optional header、security directory、certificate table の境界を検証し、署名テーブルがあるだけで有効署名とは主張しない保守的な evidence contract を追加しました。
- Packaged smoke と release evidence generator は同じ inspector を使用します。
- Utility Process 復旧後も `localUrl` が同じ場合は BrowserWindow を強制再読み込みせず、既存 renderer の reconnect state を維持します。
- `v2.0.0-rc.4` は service recovery の全検証後、Windows Server 2022 hosted runner で `Get-FileHash` が利用できず evidence 作成前に停止しました。GitHub Release は公開せず、Tag は履歴として書き換えません。

## [2.0.0-rc.4] - 2026-07-17

### Release engineering

- RC.3 の app/reliability changes を維持したまま、release qualification runner を `windows-2022` に固定しました。
- Packaged smoke の loopback probe を proxy 非依存の `curl.exe --ipv4 --noproxy "*"` に変更しました。
- Packaged smoke failure は匿名化 JSON を Actions log と workflow artifact に残します。
- `v2.0.0-rc.3` は Windows Server 2025 hosted runner 上の release gate で停止し、GitHub Release は公開されませんでした。Tag は履歴として書き換えません。

## [2.0.0-rc.3] - 2026-07-16

### 強化

- Upload の write、fsync、SQLite commit、ACK 境界へ fault injection と recovery test を追加。
- Partial file truncate、SQLite offset rewind、ACK loss 後の idempotent completion recovery を実装。
- SSE/polling/online lifecycle と sleep/resume/adapter refresh を統合し、失敗時だけ reconnect UI を表示。
- Recovery diagnostics を匿名化し、通常の compact UX を維持。
- Legacy `/api/local/*` を既定無効化し、旧 `PUT .../chunks` public endpoint を廃止。
- Tag-driven x64/ARM64 release、SBOM、SHA-256 manifest、GitHub Artifact Attestation を追加。

### 検証上の注意

- Authenticode: 未署名。
- 物理 iPhone Safari、Android Chrome、Windows on ARM runtime: manual qualification item。
- GitHub Artifact Attestation は build provenance を証明するが、publisher identity を証明しない。

## [2.0.0-rc.2] - 2026-07-16

### 追加

- SpecQR 2.4.0 の SVG QR から参加できる、双方向 local-network transfer room。
- Content fingerprint、committed offset、checkpoint SHA-256、idempotency key、pause、retry、restart recovery を備えた resumable browser upload。
- HTTP Range、source revalidation、whole-file SHA-256 と、複数 file 用 streaming ZIP download。
- 64 KiB UTF-8 limit、optimistic revision、明示的な conflict resolution、revision-only event、encrypted-at-rest storage を備えた Shared text。
- 日本語・英語に対応した compact responsive desktop/mobile UI。
- Redacted diagnostics、rotating log、resource limit、hardened Electron renderer/fuse、SBOM、audit、packaged check。

### 検証状況

- x64 Portable runtime smoke: 通過。
- ARM64 Portable build、PE、fuse、static validation: 通過。
- 物理 ARM64 runtime: 未実施。
- Authenticode: 未署名。
- 物理 iPhone Safari と Android Chrome: manual qualification gate として未実施。

[2.0.0-rc.2]: https://github.com/SpecQR/LocalFileTransfer/releases/tag/v2.0.0-rc.2
[2.0.0]: https://github.com/SpecQR/LocalFileTransfer/releases/tag/v2.0.0
[2.0.0-rc.6]: https://github.com/SpecQR/LocalFileTransfer/releases/tag/v2.0.0-rc.6
[2.0.0-rc.5]: https://github.com/SpecQR/LocalFileTransfer/releases/tag/v2.0.0-rc.5
[2.0.0-rc.4]: https://github.com/SpecQR/LocalFileTransfer/tree/v2.0.0-rc.4
[2.0.0-rc.3]: https://github.com/SpecQR/LocalFileTransfer/tree/v2.0.0-rc.3

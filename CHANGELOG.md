# 変更履歴

公開上重要な変更をこの文書へ記録します。この repository の公開履歴は RC.2 から始まります。非公開 prototype と公開前 artifact は履歴に含めません。

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

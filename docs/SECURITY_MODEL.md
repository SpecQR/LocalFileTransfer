# セキュリティモデル

## Security statement

Local File Transfer は trusted LAN 上で、偶発的な公開と無許可の room access を減らします。

Browser application と data は local HTTP で配信されるため、active network attacker に対する confidentiality は提供しません。これは zero-setup UX のための明示的な tradeoff であり、未実装の E2EE を暗示するものではありません。

## 保護対象

- User-selected source file と received file
- File name、size、media type、digest、transfer state
- Room capability と browser ticket
- Shared text content
- Windows source path と destination directory
- Process diagnostics と log

## Trust boundary

1. Untrusted LAN HTTP input が Fastify に入る。
2. Untrusted web content が sandboxed Electron renderer で動く。
3. Validated IPC が renderer から Electron main へ渡る。
4. Typed/validated message が main から Utility Process へ渡る。
5. Utility Process が SQLite、partial upload、selected native file に access する。
6. Windows `safeStorage` が restorable room capability を casual disk inspection から保護する。

## 対象とする threat と control

### Room access の推測・replay

- 128-bit 以上の random room ID と 256-bit random capability
- SQLite には verifier hash だけを保存
- Random browser ticket も verifier hash として room expiry まで保存
- Room-specific `HttpOnly; SameSite=Strict` cookie
- Reset/expiry による credential invalidation と cascade cleanup
- Ticket、event、idempotency record の bounded retention

### Cross-site request と malformed input

- Current local adapter に対する exact Host/Origin check
- Mutation に same-origin を要求
- `Content-Type`、`Content-Length`、ID、metadata、offset、range、revision、JSON shape の runtime validation
- Request、connection、SSE、file count、file size、room size、free space の limit
- Privileged operation は validated process message だけに公開

### File corruption と replay

- Resume identity 用 content fingerprint
- Committed checkpoint ごとの SHA-256 と completion 時の whole-file SHA-256
- Room、item、offset、length、digest に bind した deterministic idempotency key
- Offset acknowledgement 前の `fsync`
- SQLite offset と file length の recovery reconciliation/truncation
- `Range`、ETag、`If-Range`、native source revalidation
- Atomic completion と collision-safe Windows file naming

### Renderer と navigation abuse

- `nodeIntegration: false`、`contextIsolation: true`、renderer sandbox
- Narrow preload API と IPC sender validation
- Navigation、new window、permission request、remote content を拒否
- Content Security Policy
- CDN、remote script、analytics、update feed を使用しない
- Electron fuse により RunAsNode、Node options、CLI inspect、extra file-protocol privilege を無効化
- ASAR integrity と cookie encryption を有効化

### Sensitive data の diagnostic leakage

- Authorization、cookie、credential、room/item ID、URL、path、name、fingerprint、content、text、body、clipboard、draft を structured log で redact
- Bounded rotating log
- Shared text を event と room snapshot から除外
- Full source path を renderer/browser contract の外側に保持
- Publication audit が local path、environment file、key、database、executable を拒否

### Shared text の disk storage

- HKDF-SHA-256 が capability と room ID から purpose-separated key を導出
- AES-256-GCM は fresh 96-bit nonce を使用
- Room、revision、timestamp を AAD として authenticate
- SQLite/WAL は plaintext ではなく ciphertext、nonce、tag を保存
- Reset、expiry、replacement、shutdown で key material を zeroize

これは storage protection です。Authorized local service は memory 上で note を復号するため、trusted endpoint です。

## 明示的な non-goal

- LAN、router、DNS、HTTP response を control する active attacker からの保護
- Windows、Electron、browser、administrator account compromise 後の保護
- Anonymous internet transfer、NAT traversal、cloud relay、public hosting
- Malware scan、content classification、data-loss-prevention policy
- Authorized endpoint から file metadata を隠すこと
- Silent clipboard sync または clipboard history

## Application-layer E2EE を主張しない理由

WebCrypto は local HTTP origin で一貫して利用できず、HTTPS-hosted controller から local HTTP へ active mixed content を安全に取得することもできません。

より根本的には、active LAN attacker が最初の HTTP JavaScript を置き換えられます。その後の message を暗号化しても、実行している code の authenticity は保証されません。

Hostile-network security を正直に提供するには、local service の trusted HTTPS certificate または各 device の native endpoint が必要です。これは zero-install product boundary を変える別の設計です。

## Residual risk

- QR は bearer capability です。Room lifetime 中に撮影・copy した人は、到達可能な LAN から参加できます。
- Local HTTP traffic と metadata は network observer から見える可能性があります。
- Unsigned build は SmartScreen warning を表示し、publisher identity を証明できません。
- Physical mobile file provider は automation で完全再現できない suspend behavior を持ちます。
- Configured limit 内でも、大量の有効 workload は disk と CPU を消費します。

Security report は [SECURITY.md](../SECURITY.md) に従ってください。

# Shared text 設計

Local File Transfer `2.0.0-rc.2` は、file queue と同じ room に 1 件の note を持ちます。

これは chat、character-by-character collaborative editing、clipboard monitoring、history service ではありません。

## Product behavior

- Existing desktop/browser toolbar に Shared text icon を 1 つ表示する。
- File と text は同じ QR と room capability で認可する。
- Icon を開いたとき current note を local draft へ読み込む。
- Share は明示操作。Typing だけでは data を送信しない。
- Copy は visible draft を OS clipboard へ書き込む。Clipboard を読まない。
- Clear draft は Share を押すまで local state だけを変更する。
- Limit は UTF-8 で 64 KiB。JavaScript character count ではなく byte count を表示する。
- HTML/Markdown に見える input も inert plain text として扱う。
- 日本語 IME composition 中は Share を実行せず、command を disable にする。

## Revision protocol

Note は単調増加する revision を持ちます。Write request は editor が load した revision を含みます。

```text
GET /api/v2/rooms/:roomId/shared-text
-> { content, revision, updatedAt }

PUT /api/v2/rooms/:roomId/shared-text
<- { content, expectedRevision }
-> { content, revision, updatedAt }
```

Stale write は HTTP `409` と current note を返します。UI は user の draft を保持し、次のどちらかを明示的に選択させます。

- **Use latest**: Remote note で draft を置き換える。
- **Replace with draft**: Response の current revision を使って draft を再送する。

Successful write は、revision と timestamp だけを持つ `shared-text-updated` event を追加します。Text を SSE journal または room snapshot に複製しません。

Missed event は snapshot revision polling、reconnect、reload、visibility reconciliation で収束します。

## Storage protection

SQLite schema v3 は room ID、revision、timestamp、random 96-bit nonce、AES-256-GCM ciphertext、128-bit tag を保存します。

Runtime key derivation:

```text
HKDF-SHA-256(
   input = room capability,
   salt/context = room ID,
   info = versioned shared-text purpose
)
```

Room ID、revision、timestamp を additional authenticated data として使用します。Capability と derived key は SQLite に書き込みません。

Electron は Utility Process restart 後、Windows DPAPI-backed `safeStorage` を介して capability を復元できます。Memory 上の key buffer は room reset、expiry、replacement、shutdown で overwrite します。

これは **encrypted at rest であり、end-to-end encryption ではありません**。Local Windows service は authorized browser へ返すため note を memory 上で復号します。

この仕組みは database、WAL、diagnostic artifact からの casual plaintext disclosure を減らしますが、compromised Windows software または active LAN attacker から保護するものではありません。

## Cleanup と redaction

Reset と expiry は room row を削除し、encrypted note state を cascade-delete します。

Structured log は content、text、body、clipboard、draft に関係する field を redact します。Diagnostics、event payload、room snapshot に note を含めません。

## Verification

Automated coverage:

- UTF-8 boundary、CRLF normalization、Unicode、NUL rejection
- Nonce uniqueness、wrong-capability failure、metadata authentication、key zeroization
- Schema migration、compare-and-swap、restart recovery、reset/expiry cleanup
- Raw SQLite/WAL plaintext scan
- Authorization と same-origin rejection
- Inert markup と log/event redaction
- IME guard、conflict、reload convergence
- Mobile browser flow と DPI layout

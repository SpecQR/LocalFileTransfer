# Room と転送 protocol

## Status

Current product protocol は `lft-resume-v1`、HTTP namespace は `/api/v2` です。Offset の考え方は tus を参考にしていますが、tus implementation ではありません。Checkpoint checksum、mobile file-provider materialization、room authorization、native download requirement は本製品固有です。

ID、length、offset、revision、metadata、IPC message、response shape はすべて runtime で検証します。TypeScript type だけを network boundary として扱いません。

## Join と authorization

Desktop は次と同等の URL を作成します。

```text
http://<private-ip>:8787/room/<roomId>#token=<roomCapability>
```

Capability は 32 random bytes の base64url です。Browser は fragment を読み、1 回だけ次へ送信します。

```http
POST /api/v2/rooms/:roomId/authorize
Content-Type: application/json

{"token":"<roomCapability>"}
```

Service は verifier を比較し、random ticket を room-specific な `HttpOnly; SameSite=Strict; Path=/` cookie として返します。以後の browser request は cookie を使用します。

Capability 本体は SQLite と log に書き込みません。Desktop service recovery path だけが Windows `safeStorage` を介して保持します。

Mutating browser request は、許可した Origin と完全一致する必要があります。Host と Origin は current adapter candidate と照合します。Room creation、native source registration、reset、log folder などの privileged operation は、validated Electron process message からだけ実行できます。

## Room API

| Method | Route | 用途 |
| --- | --- | --- |
| `POST` | `/api/v2/rooms/:roomId/authorize` | Fragment capability を browser ticket へ交換 |
| `GET` | `/api/v2/rooms/:roomId` | Authoritative room snapshot を取得 |
| `GET` | `/api/v2/rooms/:roomId/events` | SSE change、heartbeat、replay |
| `GET` | `/api/v2/rooms/:roomId/diagnostics` | Redacted support snapshot を取得 |
| `POST` | `/api/v2/rooms/:roomId/uploads` | Browser upload を register または recover |
| `HEAD` | `/api/v2/rooms/:roomId/uploads/:itemId` | Committed offset と state を reconcile |
| `PATCH` | `/api/v2/rooms/:roomId/uploads/:itemId` | 検証済み checkpoint を commit |
| `DELETE` | `/api/v2/rooms/:roomId/items/:itemId` | Item を idempotently cancel |
| `GET`, `HEAD` | `/api/v2/rooms/:roomId/files/:itemId/content` | 1 source を stream または range-download |
| `GET` | `/api/v2/rooms/:roomId/files/archive` | Ready outbound file を streaming ZIP で取得 |
| `GET` | `/api/v2/rooms/:roomId/shared-text` | Current note と revision を取得 |
| `PUT` | `/api/v2/rooms/:roomId/shared-text` | Compare-and-swap で note を更新 |

RC.3 の public upload surface は `HEAD` と `PATCH` だけです。旧 `PUT .../chunks` endpoint は current client から参照されず、default runtime でも register しません。`/api/local/*` も test fixture が `enableLegacyRoutes` を明示した場合だけ有効です。

## Upload fingerprint

Register 前に browser は次を計算します。

```text
SHA-256(
   "lft-fingerprint-v1\0" ||
   UTF8(name) || "\0" ||
   uint64(size) ||
   uint64(lastModified) ||
   first up to 64 KiB ||
   last up to 64 KiB
)
```

Base64url result により、user が同じ file を再選択したとき、browser `File` handle を保存せず incomplete item を探せます。

Resume record は room ID、fingerprint、item ID、observed offset、timestamp を IndexedDB に保持し、上限付き localStorage fallback を持ちます。Capability と Windows path は保存しません。

## Upload registration と reconciliation

Registration には file name、media type、size、last modified time、fingerprint を含めます。同じ room、direction、fingerprint の incomplete item に対して idempotent です。

`HEAD` は次の authoritative value を返します。

```http
Upload-Offset: <durably committed bytes>
Upload-Length: <total bytes>
Upload-Fingerprint: <base64url SHA-256>
Upload-State: pending | transferring | ready | failed | cancelled
```

## Checkpoint commit

通常の checkpoint size は 4 MiB です。

```http
PATCH /api/v2/rooms/:roomId/uploads/:itemId
Content-Type: application/offset+octet-stream
Upload-Offset: <expected offset>
Upload-Checksum: sha256 <base64 digest of this plaintext checkpoint>
Idempotency-Key: <base64url deterministic checkpoint key>
Content-Length: <checkpoint bytes>
```

Deterministic key は room、item、offset、length、digest に bind します。同じ committed key の replay は、現在の committed offset を返します。別 checkpoint による stale offset は `409` と authoritative offset を返します。

Configured limit より大きい checkpoint と、`Content-Length` に一致しない body は拒否します。

Server は write、checksum verify、`fsync`、idempotency key と offset の SQLite transaction commit を完了してから response を返します。Commit 前に process が終了した場合、recovery は partial file を SQLite offset まで truncate します。SQLite offset が実在する partial byte より進んでいる場合は offset を file length まで rewind します。

Commit 後、response 前に終了した checkpoint は idempotency replay で ACK を再構成します。Final checkpoint では、full partial file または既存 final file から completion state も回復します。詳細は [Reliability design](RELIABILITY.md) を参照してください。

全 byte の受信後に whole-file digest を検証し、成功時だけ desktop queue へ atomic に公開します。

## Download

Individual download:

- `HEAD` は size、media type、digest、ETag、range support を返す。
- `Range: bytes=...` は `206` と正しい `Content-Range` を返す。
- Invalid/unsatisfiable range は `416`。
- `If-Range` により異なる source version の byte 混在を防ぐ。
- Stream 前に source type、size、mtime を再検証する。

Archive endpoint は entry name を sanitize し、重複を uniquify します。一時 ZIP は作成しません。Streaming 中に source が変わった場合は archive を終了し、不整合な byte を成功 response として返しません。

## Event と state convergence

SSE event ID は room ごとに単調増加します。Repository は 256 event の bounded history を保持します。

Reconnect は `Last-Event-ID` を使用し、history だけで replay できない場合は complete room snapshot を取得します。Heartbeat は state を変更しません。Shared text event に含めるのは revision と timestamp だけです。

## Shared text conflict

```http
GET /api/v2/rooms/:roomId/shared-text
-> {"content":"...","revision":3,"updatedAt":...}

PUT /api/v2/rooms/:roomId/shared-text
<- {"content":"...","expectedRevision":3}
```

古い `expectedRevision` は、current note を含む `409` を返します。Browser は local draft を保持し、最新値を読み込むか、明示的に draft で置き換えるかを user に選ばせます。

Input は plain text です。NUL を拒否し、line ending を normalize し、UTF-8 encoding 後の 64 KiB を上限とします。

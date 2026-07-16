# Reliability design

## 目的

Local File Transfer 2.0.0-rc.3 は、通常時の 300 CSS px UI と操作数を増やさず、失敗時の回復可能性と観測可能性を強化します。中心となる契約は次です。

> Browser に acknowledged offset を返した checkpoint は、partial file の `fsync` と SQLite transaction commit の両方が完了している。

Queued byte、socket write 完了、memory 上の offset は progress の根拠にしません。

## Upload checkpoint state machine

```text
validate request
-> verify expected offset/idempotency
-> write partial file
-> fsync partial file
-> commit item offset + idempotency record in SQLite
-> recover/finalize completed item when applicable
-> return acknowledged offset
```

Checkpoint は room、item、start offset、length、SHA-256 に bind した deterministic idempotency key を持ちます。

### Fault injection boundary

Test-only hook は次の境界で exception または crash-equivalent interruption を注入できます。

| Phase | Persistent file | SQLite offset | Expected recovery |
| --- | --- | --- | --- |
| `before-write` | unchanged | unchanged | Same checkpoint を再送 |
| `after-write-before-fsync` | extra byte が見える場合がある | unchanged | 同一 process rollback または起動時 truncate |
| `after-fsync-before-commit` | durable extra byte | unchanged | 同一 process rollback または起動時 truncate |
| `after-commit-before-ack` | committed byte | advanced | Idempotent replay が duplicate write なしで ACK を再構成 |

SQLite transaction 内にも `after-item-update` と `before-commit` の fault phase があります。Repository failure 時は file を checkpoint start まで戻します。File rollback 自体も失敗した場合は最初の failure を隠さず `AggregateError` とします。

## Startup reconciliation

RoomStore startup は SQLite の committed offset と partial/final file を照合します。

1. Partial file が committed offset より長い場合、余分を truncate する。
2. Partial file が committed offset より短い場合、SQLite offset を実在 byte まで rewind する。
3. Final checkpoint が commit 済みで final file が揃っている場合、ready state を回復する。
4. Full partial file が commit 済みなら whole-file verification と atomic completion を再開する。
5. Idempotency replay は committed result を返し、同じ byte を追加しない。

Recovery counter:

- `startupTruncations`
- `startupTruncatedBytes`
- `startupRewinds`
- `startupRewoundBytes`
- `checkpointRollbacks`
- `idempotentReplays`
- `recoveredCompletions`

Counter は support 用集計値であり、room/item ID、path、name、content、capability を含みません。

## Browser connection recovery

Browser UI は room snapshot を authoritative state とし、SSE を低遅延通知として扱います。

```text
SSE opening
-> connected
-> error: reconnecting
-> fallback polling
-> SSE open: connected
```

補助 trigger:

- `online` / `offline`
- `pageshow`
- `visibilitychange`
- 5 秒 polling fallback

通常時は追加 UI を表示しません。`reconnecting` または `offline` の間だけ compact recovery strip と Retry command を表示します。Retry は file byte を推測せず、room snapshot と upload `HEAD` から再同期します。

## Desktop lifecycle recovery

Electron main process は Utility Process を監視し、異常終了後に上限付き再起動を行います。`powerMonitor` の `resume` と `unlock-screen` では adapter と room origin を再評価します。

Room、SQLite、listener を不要に作り直さず、到達可能な preferred origin が変わった場合だけ renderer の QR state を更新します。

## Compatibility surface

RC.3 の既定 runtime は canonical `/api/v2` room API だけを公開します。

- `/api/local/*` は `buildApp({ enableLegacyRoutes: true })` の test-only opt-in 時だけ register する。
- 旧 `PUT /api/v2/rooms/:roomId/uploads/:itemId/chunks` は public route から削除した。
- Current browser は `HEAD` と `PATCH application/offset+octet-stream` だけを使用する。

Regression test は legacy implementation の意図しない破損検出には残しますが、production desktop が legacy route を公開しているという意味ではありません。

## Failure UI と diagnostics

Diagnostics は failure investigation に必要な state と recovery count だけを返します。Shared text、file content、file name、path、capability、cookie、fingerprint、full room/item ID は含めません。

UI は通常の transfer flow を増やさず、failure 時だけ reconnect state と redacted recovery summary を見せます。

## Release gate

Reliability change は次をすべて通過して初めて release candidate とします。

1. Fault injection unit/integration test
2. SQLite/partial-file restart recovery
3. Browser EventSource lifecycle test
4. Offline/online E2E convergence
5. Electron service restart packaged smoke
6. x64/ARM64 PE/fuse check
7. Public tree audit
8. SBOM、SHA-256、build provenance attestation

物理 iPhone/Android の provider suspend と物理 Windows on ARM runtime は別の manual qualification gate です。

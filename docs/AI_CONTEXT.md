# Maintainer と AI agent のための context

## Canonical product definition

Local File Transfer は、Windows 上で一時的な双方向 transfer room を host する Portable application です。同じ LAN 上の browser が 1 つの SpecQR SVG を読み取って参加し、どちらの endpoint からでも file を追加できます。Room には、明示的に共有する 1 件の plain-text note もあります。

この public repository は `2.0.0-rc.2` から始まります。`rc1.css`、compatibility route、migration test などの file name から、RC.2 より前の public history を推測・再構成しないでください。それらは implementation ancestry を示す名前であり、公開 release を示すものではありません。

## Product invariant

1. Cloud、relay、account、telemetry、subscription、updater、public server を持たない。
2. End user が利用する artifact は、runtime install を必要としない Windows Portable EXE 1 個。
3. 同じ到達可能な LAN と trusted-network assumption を前提とする。
4. Room と QR は 1 つ。Send/Receive mode switch は設けない。
5. Bidirectional file queue と、明示操作で共有する Shared text 1 件を提供する。
6. Desktop content width は 300 CSS pixel を維持し、state transition で変動させない。
7. Queue row 3 件までは window を自動拡張し、それ以上は queue 内部を scroll する。
8. Browser upload progress は queued byte ではなく durably confirmed byte を表す。
9. Large data は stream または checkpoint で扱い、全 file を memory に保持しない。
10. Security と validation の claim は evidence と正確に一致させる。

## 固定した技術判断

- TypeScript、3-space indentation
- Self-contained Windows shell として Electron 43
- Electron Utility Process 内の Fastify 5
- Desktop/browser UI は React 18 と Vite 6
- Repository boundary の背後に Node built-in SQLite
- SpecQR exactly `2.4.0`、SVG output、`margin: 4`、automatic version、conditional L/M
- `lft-resume-v1`、4 MiB SHA-256 checkpoint、persistent idempotency
- Download は whole-file SHA-256 と HTTP Range
- Shared text の at-rest storage だけに AES-256-GCM と HKDF-SHA-256

## Module ownership

### `apps/desktop`

- `main.ts`: BrowserWindow policy、single instance、native dialog、`safeStorage`、power-save blocker、Utility Process supervision、window geometry
- `preload.ts`: narrow renderer API
- `service.ts`: Utility Process bootstrap と typed command dispatch
- `serviceProtocol.ts`: process-message validation contract
- `scripts/`: package config、signing input、fuse gate

### `apps/server`

- `app.ts`: 共通 Fastify assembly と security hook
- `v2/roomStore.ts`: authoritative room state machine と transfer operation
- `v2/sqliteRoomRepository.ts`: migration と durable state
- `v2/routes.ts`: authenticated room HTTP protocol
- `v2/roomDownload.ts`、`roomArchive.ts`: source streaming
- `v2/sourceHashPool.ts`: bounded worker hash と cache
- `v2/sharedTextCrypto.ts`: at-rest key derivation と authenticated encryption
- `security/`: request/connection limit
- `observability/`: redacted rotating log

`local/` directory と `/r`、`/u`、`/send` browser page は、`app.ts` が現在も register する compatibility surface です。Regression coverage があるため、current desktop が `/room/...` を開くという理由だけで削除しないでください。削除する場合は route、test、migration を含む明示的な deprecation review が必要です。

### `apps/web`

- `TransferRoomPage.tsx`: RC.2 の canonical room UI と queue orchestration
- `roomClient.ts`: authorization、SSE、resumable upload、download、Shared text
- `uploadSource.ts`: mobile file-provider materialization。Large iPhone image regression の修正箇所を含む
- `resumeStore.ts`: secret を含まない IndexedDB/localStorage resume metadata
- `QRPanel.tsx`、`qrOptions.ts`: SpecQR SVG generation と error-correction policy
- `SharedTextDialog.tsx`: draft、IME、conflict、copy、byte limit
- `rc1.css` と `rc2.css`: 累積して適用する現行 style。File name は public version claim ではない

### `packages`

- `protocol`: 共通 constant、runtime parser、transfer math、event/item shape
- `shared`: base64url、byte、digest utility

## Critical flow

### Browser upload

```text
Fingerprint
-> item register/recover
-> HEAD authoritative offset
-> next file slice materialization
-> SHA-256
-> deterministic idempotency key
-> PATCH
-> fsync
-> SQLite commit
-> acknowledged offset
-> whole-file verification
-> atomic ready
```

Large iPhone image の修正は source materialization path にあります。長時間生存する lazy `Blob.slice()` を retry の間で直接使い回さず、network submission の前に checkpoint byte を materialize し、concurrency を抑えてください。

### Native download

Validated IPC が、renderer の外側で path と immutable metadata を register します。HTTP response ごとに source identity を再検証し、conditional/range semantics で disk から stream します。

Source が変化した場合は error とし、異なる version の byte を暗黙に混在させてはいけません。

### Shared text

```text
GET revision
-> local draft edit
-> explicit PUT with expected revision
-> 409 conflict choice
-> revision-only SSE
-> snapshot reconciliation
```

Plaintext は event JSON、room snapshot、SQLite、WAL、log に含めません。

## 維持すべき security reasoning

Camera から開く page は local HTTP です。Application-layer encryption を追加しただけで E2EE と呼ばないでください。Active LAN attacker は最初の JavaScript 自体を置き換えられるため、その後の message encryption は code authenticity を保証しません。

Hostile-network confidentiality を本当に提供するには、local service の trusted HTTPS certificate または各端末の native endpoint が必要であり、zero-install product boundary が変わります。

次を維持してください。

- Capability は authorization まで fragment に置く。
- SQLite には verifier だけを保存する。
- Browser ticket は `HttpOnly` cookie にする。
- Host、Origin、input shape を runtime で検証する。
- Privileged API を LAN へ公開しない。
- Electron renderer isolation と fuse を維持する。
- Live QR value を log または public evidence に含めない。

## Repository 公開時点の release truth

- Version/tag: `2.0.0-rc.2` / `v2.0.0-rc.2`
- License: MIT、copyright SpecQR contributors
- x64 Portable: unsigned、packaged runtime smoke 通過
- ARM64 Portable: unsigned、build/PE/fuse/static check 通過、physical runtime 未実施
- Automated suite: 86 unit/integration + 2 E2E scenario
- Physical iPhone Safari、Android Chrome、Windows on ARM は manual qualification gate

未実施の check を positive claim に変更しないでください。Artifact が変わった場合は hash と evidence を必ず再生成します。

## よくある誤り

- Allowlist した public tree ではなく private development workspace を公開する。
- EXE、database、upload、log、generated report、`.env`、signing material、absolute path、personal email、live QR screenshot を commit する。
- Queued upload byte を committed progress として表示する。
- `HEAD` reconciliation なしに stale offset から retry する。
- Physical file-provider test なしに mobile upload concurrency を増やす。
- Desktop fixed width を変化させる viewport scaling を CSS に追加する。
- Queue-local scroll の代わりに 2 本目の page scrollbar を追加する。
- Shared text を event または diagnostics に含める。
- Encrypted at rest の Shared text を E2EE と呼ぶ。
- Directory name だけを理由に compatibility code を削除する。

## Change playbook

### Transfer または persistence

Protocol parser と repository migration、room state、route、client、UI の順で変更します。Unit/fault integration coverage を追加し、all tests、E2E、packaged recovery、audit、evidence generation を実行します。

### UI geometry

Stable grid track と explicit square `aspect-ratio` を維持します。Empty、1 row、3 rows、many rows、両言語、mobile sticky action、manual resize、Windows 100-200% scale を確認します。

### Dependency または Electron

Release note と transitive license を確認し、該当 scope の exact lockfile を更新します。Audit、両 architecture build、fuse、PE header、x64 packaged smoke を再実行します。Physical ARM64 test が終わるまで disclaimer を残します。

### SpecQR

Dependency の exact pin を維持し、estimated selected version、4-module quiet zone、SVG output を確認します。最長 URL を物理 phone で scan し、QR、browser、DPI、fixed-width test を再実行します。

## 文書の優先順位

Current public behavior の判断には、次の順序を使用します。

1. Runtime-validated source と test
2. `README.md`、`ARCHITECTURE.md`、`PROTOCOL.md`、`SECURITY_MODEL.md`
3. 同じ artifact hash に対応する generated evidence
4. Issue / Pull Request discussion

Document と executable behavior が一致しない場合は publication を停止し、原因を調査し、どちらかを修正して evidence を再生成します。Release Notes だけで差異を取り繕わないでください。

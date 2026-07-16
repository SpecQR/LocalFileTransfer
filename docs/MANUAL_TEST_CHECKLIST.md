# Manual release checklist

各 test run について、date、artifact SHA-256、Windows edition/build、CPU architecture、network type、browser/device version、result を記録します。

Public evidence に personal file name、network name、local path、QR screenshot、room credential を含めないでください。

## 1. Artifact と起動

- [ ] SHA-256 が `SHA256SUMS.txt` と一致する。
- [ ] Artifact architecture が実行 machine と一致する。
- [ ] Unsigned/SmartScreen behavior が Release Notes と一致する。
- [ ] Terminal や setup prompt なしで app が開く。
- [ ] App は single instance で動作する。
- [ ] Window は compact に始まり、不要な下部空白がない。
- [ ] QR は正方形、完全に領域内、鮮明で、4-module quiet zone を持つ。
- [ ] Windows Firewall は private network だけに許可できる。

## 2. Browser から参加

- [ ] iPhone Safari が標準 Camera から開く。
- [ ] Android Chrome が標準 Camera から開く。
- [ ] 別 desktop browser が copied link から開く。
- [ ] Network 不一致または unreachable adapter で有用な diagnostics が表示される。
- [ ] Reset で old page が無効になり、異なる QR が表示される。
- [ ] 撮影した old QR は reset または expiry 後に使用できない。

## 3. Browser から Windows への upload

- [ ] Empty file。
- [ ] Small text と PDF。
- [ ] Camera で撮影した約 15 MiB 以上の JPEG または HEIC。
- [ ] 1 回の選択で 5 file 以上。
- [ ] 長い日本語名と emoji を含む file name。
- [ ] Duplicate file name が安全な unique destination になる。
- [ ] 3 row まで desktop window が自動的に伸びる。
- [ ] 4 row 目以降は queue だけが scroll し、action へ到達できる。
- [ ] Pause/resume が confirmed offset から続行する。
- [ ] Wi-Fi interruption 後、completed byte を再送せず retry する。
- [ ] Browser background/screen lock で item が破損しない。
- [ ] Page reload と file re-selection で matching fingerprint を resume する。
- [ ] 1 file の reject/cancel が後続 file を停止しない。
- [ ] Completed file の SHA-256 が original と一致する。

## 4. Windows から Browser への download

- [ ] Small file 1 件を正しく download できる。
- [ ] 100 MiB 以上の file 1 件を正しく download できる。
- [ ] Browser が Range を support する場合、中断後に resume できる。
- [ ] Narrow mobile でも各 Download action へ到達できる。
- [ ] Ready outbound file が 2 件以上の場合だけ Download all が表示される。
- [ ] Streaming ZIP の name が正しく、unique で、path traversal を含まない。
- [ ] Windows source を変更・削除すると、stale byte を返さず error になる。
- [ ] Completed SHA-256 が source と一致する。

## 5. Shared text

- [ ] 英語と日本語を両方向へ同期できる。
- [ ] Emoji と multiline text が UTF-8 content を保持する。
- [ ] HTML-like text は inert plain text として表示される。
- [ ] 日本語 IME composition 中に Share が実行されない。
- [ ] Copy command を明示した場合だけ clipboard へ書き込む。
- [ ] Clear draft は Share するまで remote state を変えない。
- [ ] Concurrent edit は latest/replace の明示的な choice を表示する。
- [ ] Reload 後に latest revision へ収束する。
- [ ] 64 KiB boundary を UTF-8 byte count で enforcement する。
- [ ] Reset が previous note を削除する。

## 6. Window と accessibility

- [ ] Room state または scrollbar state で control position が動かない。
- [ ] View/state transition を繰り返しても desktop width が増えない。
- [ ] Empty state は未使用の下部空白を残さず縮む。
- [ ] 3 row までは auto-grow、4 row 以上は internal scroll になる。
- [ ] 手動で height を増やすと、より多くの row が表示され、その height が保持される。
- [ ] Windows scale 100%、125%、150%、200% で利用できる。
- [ ] Keyboard order、focus indication、Enter/Space、Escape、tooltip が動作する。
- [ ] Icon-only command に screen-reader name がある。
- [ ] Reduced-motion で不要な animation が停止する。
- [ ] 日本語・英語 label が overlap しない。

## 7. Recovery と cleanup

- [ ] Utility Process failure 後に window を閉じず recovery する。
- [ ] Committed partial upload が service recovery 後に resume する。
- [ ] App restart で partial length を SQLite committed offset に reconcile する。
- [ ] Windows sleep/resume 後、必要に応じて adapter と QR を更新する。
- [ ] Wi-Fi/adapter switch で window width が増えず、layout が不安定にならない。
- [ ] Low disk space failure が他 item と分離され、理解できる message を表示する。
- [ ] Reset が unfinished data を削除し、ticket を無効化する。
- [ ] Expiry が unfinished data と encrypted Shared text を削除する。
- [ ] App close で listener が停止し、app process が残らない。

## 8. ARM64 固有 gate

- [ ] Physical Windows on ARM で Portable EXE が起動する。
- [ ] 別 device から QR join できる。
- [ ] 15 MiB 以上の file で両方向の transfer が通る。
- [ ] Shared text、restart recovery、DPI、clean shutdown が通る。
- [ ] Physical result を記録した後だけ Release Notes の runtime status を更新する。

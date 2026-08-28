# Local File Transfer 2.0.1

Local File Transfer 2.0.1 は、長時間接続または端末のロックをまたいだ Room 更新を修正する保守リリースです。Windows アプリを再起動しなくても新しい QR を発行し、iPhone などの Browser から新しい Room へ参加し直せます。

ファイル転送、Shared text、300 CSS px の compact UI、SpecQR 2.4.0 による SVG QR の利用方法は 2.0.0 から変更していません。

## 修正

- 15 分の無通信期限または 1 時間の絶対期限を過ぎた Room を Electron main process が保持し続ける問題を修正しました。
- Cached Room が有効なら同じ Room を再開し、期限切れまたは削除済みの場合だけ新しい Room、QR、desktop ticket、暗号化済み vault record へ切り替えます。
- Reset は古い Room の削除結果が 404 でも新しい Room を作成します。有効な Room に対する誤った token の 401 は従来どおり拒否します。
- Refresh、system resume、network adapter change、file add、Reset の Room lifecycle を直列化し、異なる Room の token、cookie、QR が混在しないようにしました。
- Stable Release の `Latest` 指定と asset upload を、全 gate と staging が完了した後の公開 step だけで行うよう固定しました。
- 公開直前の dependency audit で検出した high severity advisory に対応し、server、web、desktop の lockfile を修正版 dependency へ更新しました。

## 検証

- RoomStore の fake clock test で、有効 Room の再開、hard expiry 後の作成、soft expiry 後の Reset、invalid token の拒否を確認します。
- 短縮した実期限を使う Electron E2E で、Android-sized Chromium と iPhone-sized WebKit の自動 Room 更新、新 QR への参加、続く Reset を確認します。
- 物理 iPhone の Safari で、長時間接続した後もアプリを再起動せず Room を再作成し、新しい Room へ再接続できることを確認済みです。
- Tag-driven release workflow は unit/integration、browser/Electron E2E、x64/ARM64 build、PE/fuse、DPI geometry、x64 packaged service recovery、dependency audit、SBOM、SHA-256、GitHub Artifact Attestation を clean Windows runner で再実行します。
- Root、server、web、desktop の全 dependency scope で `npm audit --audit-level=high` を通過することを公開 gate とします。

物理 Android と Windows on ARM の runtime は未確認です。Automated browser profile と ARM64 static validation を物理 device test として扱いません。

## セキュリティ上の前提

- 信頼できる同一 LAN 内だけで使用してください。
- Browser UI と file transfer は local HTTP で、E2EE ではありません。
- QR は Room が有効な間の bearer capability です。使用後は Reset してください。
- Shared text は Windows 上で encrypted at rest ですが、認可済み client へ返すため service が復号します。
- Portable EXE は Authenticode 未署名です。GitHub Artifact Attestation は Windows publisher signing の代替ではありません。

現在の判断と将来の採用条件は [コード署名方針](https://github.com/SpecQR/LocalFileTransfer/blob/v2.0.1/docs/CODE_SIGNING.md) に記録しています。

## Download

- Intel / AMD Windows: `Local.File.Transfer-2.0.1-x64-Portable.exe`
- Windows on ARM: `Local.File.Transfer-2.0.1-arm64-Portable.exe`

`SHA256SUMS.txt` で download file を照合してください。GitHub CLI を利用できる場合は、次でも provenance を確認できます。

```powershell
gh attestation verify .\Local.File.Transfer-2.0.1-x64-Portable.exe --repo SpecQR/LocalFileTransfer
```

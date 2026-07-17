# Local File Transfer 2.0.0-rc.6

RC.5 の転送プロトコル、復旧処理、compact desktop UI を維持したまま、スマートフォンで共有テキストを編集するときの表示を修正する release candidate です。

## 修正

- Browser client の共有テキスト入力欄を 16 px にし、iPhone Safari がフォーカス時にページを自動拡大する条件を回避しました。
- Electron desktop の入力文字サイズと compact layout は変更していません。
- `maximum-scale` や `user-scalable=no` は設定していないため、ユーザーが意図して行うピンチズームは引き続き利用できます。

## 自動検証

- Protocol、release tooling、server、web のテスト 103 件
- Android-sized Chromium と iPhone-sized WebKit の双方向 file/shared-text E2E 2 件
- Mobile browser の共有テキスト入力欄が算出値 16 px 以上であること
- Viewport policy が `maximum-scale` と `user-scalable` でズームを禁止していないこと
- Production server、web、Electron desktop build

## 実機確認

この候補は iPhone-sized WebKit で自動検証していますが、物理 iPhone Safari でのフォーカス挙動は利用者による再確認前です。公開判断時には物理 iPhone で、入力欄を選択してもページ倍率が変わらないことを確認します。

## セキュリティ上の前提

- 信頼できる同一 LAN 内だけで使用してください。
- File transfer と Shared text は E2EE ではありません。
- QR は room が有効な間の bearer capability です。使用後は Reset してください。
- Portable EXE は Authenticode 未署名です。GitHub Artifact Attestation は Windows publisher signing の代替ではありません。

# WebView2 試作版 0.1.0

起動時間と配布サイズの両方を改善するための、Windows 向け比較試作です。既存の Electron Portable 版とは別の配布物・保存領域を使用します。既存版のデータを移行・変更する機能はありません。

## 起動方法

1. 使用する Windows の「設定 → システム → バージョン情報」でシステムの種類を確認します。Intel / AMD の Windows は `x64`、Windows on Arm は `arm64` の ZIP を選びます。
2. ZIP を右クリックして「すべて展開」を実行します。
3. 展開したフォルダー内の `LocalFileTransferPreview.exe` を起動します。`LocalFileTransferService.exe` と `web` フォルダーは隣に置いたまま使用します。
4. 同じ信頼できる LAN に接続した端末から QR を読み取り、ファイル転送や共有テキストを試します。

Windows 10 / 11 と Microsoft Edge WebView2 Evergreen Runtime が必要です。Runtime がない環境では、[Microsoft の配布ページ](https://developer.microsoft.com/microsoft-edge/webview2/)から使用する Windows のアーキテクチャに合う Evergreen Runtime をインストールしてください。試作版が Runtime を自動ダウンロードすることはありません。アプリの転送機能はインターネット接続を必要としません。

この試作版の実行ファイルには Authenticode 署名がありません。公開した GitHub Release の配布物と SHA-256 を確認して使用してください。セキュリティソフトの無効化や除外設定は必要条件にしていません。

## 変更点

| 項目 | Electron Portable 版 | WebView2 試作版 |
|---|---|---|
| 画面 | 同梱 Electron / Chromium | Tauri 2 と OS にインストール済みの WebView2 |
| 配布 | 単一 Portable EXE | 一度展開する ZIP フォルダー |
| 展開 | Portable 起動時に展開 | ZIP の初回展開時のみ |
| 転送サーバー | Electron utility process | Node.js SEA の専用プロセス |
| 起動順序 | サーバー準備後に画面を作成 | 小さな準備画面を表示し、サーバー起動後に転送画面へ移動 |
| 保存領域 | 既存版の保存領域 | 試作版専用のユーザー保存領域 |

ファイルのストリーミング、チェックポイントからの再開、共有テキスト、QR の room capability、HTTP cookie 認可、SQLite の room 管理は既存実装を共用します。ファイル選択とドロップは native host が扱い、ブラウザーから任意のローカルファイルパスを登録する API は追加していません。

試作版のデータは `%LOCALAPPDATA%\LocalFileTransferWebView2Preview` に保存します。受信済みファイルはアプリ内のフォルダーボタンから開けます。試作を終える際はアプリを閉じてから展開フォルダーを削除できます。受信済みファイルを残すかどうかは、データフォルダーを削除する前に確認してください。

ZIP 自体は配布サイズを小さくするために圧縮しています。起動時に ZIP を解凍する方式ではありません。WebView2 Runtime の容量は OS 側で別途使用します。

## 比較するときの確認項目

- 起動してからウィンドウが見えるまでの時間と、QR / 接続状態が表示されるまでの時間を分けて比較します。
- Windows の「＋」からのファイル追加、ウィンドウへのファイルドロップ、別端末へのダウンロードを確認します。
- 別端末からのアップロード、受信ファイルを開く操作、共有テキストの往復を確認します。
- 転送完了後にウィンドウを閉じ、再起動して room / 受信済みファイルの復旧を確認します。
- 初回起動と繰り返し起動を分けます。Defender、ストレージ、WebView2 の状態によって計測値は変わります。

実際のサイズ・起動時間・検証範囲は各 GitHub Release に添付する証跡を参照してください。x64 の Windows runner で行う実動作テストと、ARM64 の cross build / 静的検証は別の検証です。実機の Windows on Arm、スマートフォン、ファイアウォールを経由した物理 LAN での動作を、CI の loopback テストだけで確認済みとは扱いません。

## 実装とセキュリティ境界

`apps/webview2/native` の Rust host は、ウィンドウ、ファイル選択、DPAPI による credential 保管、スリープ抑止、子プロセスの監視・終了を担当します。Rust はこの native host に限定した技術選択です。転送処理と bridge のソースは TypeScript で、既存 Electron 版も維持します。

`apps/webview2/service` は Electron と共用の service runtime を、親子プロセス間の bounded JSON-lines protocol で呼び出します。標準出力は private RPC 専用です。credential は native host と service の間だけで保持し、renderer には既存 QR 用の一時 capability を含む bootstrap のみを渡します。DPAPI の復号ができない場合や保存データに問題がある場合は、既存データを黙って捨てず起動エラーを表示します。

native command は main window と現在の loopback `/app` の origin を検証します。LAN 側のページに native bridge の権限は付与しません。外部ページへの移動、新規ウィンドウ、不要な WebView 権限を許可しない構成です。Electron の sandbox / isolation / fuse 設定は変更しません。

LAN 通信の信頼境界は従来と同じです。HTTPS / end-to-end 暗号化を追加した試作ではありません。アカウント、telemetry、cloud relay、アプリ updater は追加していません。OS の WebView2 Runtime の更新管理はアプリの機能とは別です。

## 開発・配布

`apps/webview2/preview.json` が試作版のバージョンと Node.js / Rust の固定バージョンを定義します。npm の依存は `apps/webview2/package-lock.json`、Rust の依存は `apps/webview2/native/Cargo.lock` で固定します。SpecQR は既存の `3.0.0-rc.2` を維持します。

各 npm scope を `npm ci` した後、repository root で通常の検証を実行します。

```powershell
npm ci
npm ci --prefix apps/server
npm ci --prefix apps/web
npm ci --prefix apps/desktop
npm ci --prefix apps/webview2
npm run audit:public
npm run test:all
npm run build
npm run test:e2e
```

Windows SDK / MSVC build tools と固定 Rust toolchain を用意し、対応する Rust target を追加した Windows 環境で配布物を作成します。

```powershell
node apps/webview2/scripts/build.mjs --arch x64
node apps/webview2/scripts/build.mjs --arch arm64
```

SEA は公式 Node.js executable を公式 SHA-256 一覧で検証して作成します。追加 Node.js CLI / `NODE_OPTIONS` は受け付けない構成です。両 architecture に対応するため、architecture に依存する snapshot / code cache は使用しません。既存の Node.js 署名を取り除いた上で bundle を埋め込みます。

GitHub Actions の専用 workflow は、PR では検証のみを行います。専用の `release/webview2-preview` branch への push または `webview2-preview-v<version>` tag の検証成功時だけ、同じ source から再構築して配布 ZIP を検証し、GitHub の prerelease として公開します。branch からの公開も固定した source commit を対象に同じ preview tag を作成します。通常版の `v*` release workflow と tag を分けています。実行ファイルは Git repository や Actions artifact に含めず、GitHub Release asset としてのみ提供します。

## 一次資料

- [Tauri の process model](https://v2.tauri.app/concept/process-model/)
- [Microsoft WebView2 の配布方法](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)
- [Node.js 24.22.1 の SEA](https://nodejs.org/download/release/v24.22.1/docs/api/single-executable-applications.html)

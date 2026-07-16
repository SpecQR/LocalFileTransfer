# プライバシー

## 概要

Local File Transfer は hosted service を持たず、telemetry を送信しません。Application traffic は、Windows host と、その local room に参加した device の間だけで発生します。

本プロジェクトは account database、analytics endpoint、crash collector、advertising SDK、update server、cloud object store を運用しません。

## Windows 側で扱う data

- User が選択した source file は、browser が download する間だけ元の場所から読み取ります。
- Browser upload は private application data directory の partial file へ書き込み、検証後に user が選択した destination へ完成 file として配置します。
- SQLite は room/transfer metadata、verifier hash、committed offset、checksum、bounded event、encrypted Shared text を保存します。
- Bounded rotating log は、redact 済み operational event と error code だけを保存します。
- Electron `safeStorage` は、Utility Process restart 後に local service を recovery するための active capability を保存します。

## Browser 側で扱う data

- Upload 中に user が選択した `File` object
- IndexedDB の non-secret resume metadata と、上限付き localStorage fallback
- `HttpOnly` cookie 内の room ticket
- Dialog を開いている間の current Shared text と unsent local draft

Clipboard へ書き込むのは、user が Copy を明示的に実行した場合だけです。Clipboard を自動で読み取り、監視し、同期することはありません。

## Retention

Default room は 15 分の sliding TTL と 1 時間の hard TTL を持ちます。Activity により sliding TTL は延長されますが、hard limit は超えません。

Reset または expiry は、room record、ticket、unfinished data、event、encrypted note state を削除します。

Windows に保存済みの completed file と、browser が download した user file は room cleanup の対象ではありません。

## Metadata exposure

Authorized room participant は、transfer に必要な file name、size、direction、state、digest を確認できます。LAN 上の device は HTTP traffic を観測できる可能性があります。

本プロジェクトは hostile-network 上の metadata confidentiality を保証しません。

## Public repository hygiene

Source control から次を除外します。

- Executable artifact
- Database と upload
- Test result と log
- Environment file と signing material
- Absolute local path
- Personal email address
- Private work log

Synthetic test は generic path と generated data だけを使用します。`npm run audit:public` は、publication 前と CI で exact public tree を scan します。

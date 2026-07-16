# Coding agent 向けリポジトリガイド

このリポジトリは Local File Transfer の公開 source です。Architecture または security boundary に関わる変更を行う前に、`docs/AI_CONTEXT.md` を読んでください。公開文書の言語は `docs/PROJECT_LANGUAGE.md` に従います。

## 維持すべき不変条件

- Product は local-only とし、account、telemetry、cloud relay、updater、public service を追加しない。
- LAN は trusted network として扱い、file transfer に HTTPS または end-to-end confidentiality があると主張しない。
- QR capability は、認可処理で room cookie と交換するまで URL fragment に保持する。
- Capability、cookie、Shared text、file content、完全な source path を log に記録しない。
- Electron renderer の isolation、sandbox、navigation denial、permission denial、IPC validation、hardened fuse を維持する。
- Large file は streaming または resumable checkpoint で扱い、全体を memory に buffer しない。
- 明示的な compatibility review なしに `specqr` の exact pin `2.4.0` を変更しない。
- Application code は TypeScript、indent は 3 spaces とする。
- Security claim と verification claim は、実際の evidence より強く書かない。

## 必須検証

変更後は repository root で次を実行します。

```powershell
npm run audit:public
npm run test:all
npm run build
```

User-visible behavior、protocol、transfer、Shared text を変更した場合は `npm run test:e2e` も実行します。

Executable を公開する前に、`docs/BUILD_AND_RELEASE.md` の packaged test と release evidence 手順を実施します。

## 公開時の安全性

Git repository に executable、database、upload file、environment file、signing material、local absolute path、personal email address、private work log を含めてはいけません。Release executable は GitHub Release の asset としてのみ公開します。

`npm run audit:public` は必須 gate ですが、人による確認の代わりではありません。AI agent が作業を引き継げる情報は公開設計書へ残し、個人情報や private path を含む作業ログは公開ツリーへ入れません。

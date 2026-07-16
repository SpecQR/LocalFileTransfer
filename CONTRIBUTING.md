# コントリビューション

Issue と、目的を絞った Pull Request を歓迎します。Protocol、security boundary、persistence、UI architecture に大きく影響する変更は、実装前に Issue で相談してください。

## 開発環境

Node.js 22 以上を使用し、[README](README.md) に記載した 4 つの lockfile scope を install します。生成 dependency と artifact は Git に含めないでください。

## コードスタイル

- Application code は TypeScript。
- Indent は 3 spaces。
- User-facing text または既存 Unicode test に必要な場合を除き、identifier は ASCII。
- Behavior が自明でない箇所だけに短い comment を置く。
- 新しい abstraction より、既存 module ownership と protocol validation pattern を優先する。
- 公開文書は [プロジェクト言語方針](docs/PROJECT_LANGUAGE.md) に従う。

## Pull Request 前の確認

```powershell
npm run audit:public
npm run test:all
npm run build
```

Transfer、Shared text、API、Electron、layout、browser behavior を変更した場合は `npm run test:e2e` も実行してください。Behavioral fix には、原因を再現する focused test を追加します。

Pull Request には、実施した automated/manual check と、確認できなかった platform を明記してください。未実施の検証を通過済みと書かないでください。

## セキュリティとプライバシー

実際に転送した file、database、log、capability、cookie、absolute local path、personal email address、signing credential、`.env`、executable artifact を commit しないでください。公開 test fixture は synthetic data だけを使用します。

[AGENTS.md](AGENTS.md) の invariant と [セキュリティモデル](docs/SECURITY_MODEL.md) に従ってください。

## Commit とライセンス

個人の email address を commit metadata に残したくない場合は、verified GitHub identity または GitHub が提供する no-reply address を使用してください。

Contribution を提出すると、その contribution が repository の MIT License で提供されることに同意したものとします。

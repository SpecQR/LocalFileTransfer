# プロジェクト言語方針

この文書は、Local File Transfer `2.0.0-rc.2` 以降の公開文書と開発記録で使用する言語方針を定めます。

Local File Transfer は、設計・実装・検証の判断を日本語で詳しく残します。一方で、GitHub や検索エンジンでの発見性、技術識別子の検索性、海外利用者への最低限の導線は英語で維持します。

この方針は runtime behavior、public API、package version、package exports を変更するものではありません。

## 日本語を主言語にする範囲

次の文書・記録は日本語本文を基本にします。

- `README.md` の詳細本文
- `docs/*`
- `CHANGELOG.md`
- GitHub Release notes
- commit message
- Pull Request の説明
- Issue template
- Codex を含む AI agent 向けの設計・引き継ぎ記録

## 英語を維持する範囲

次の項目は、検索性・互換性・規格準拠のため英語を維持します。

- `package.json` の `description` と `keywords`
- README 冒頭の短い English summary
- product name、package name、version、tag
- API 名、route、HTTP header、type 名、error code
- script 名、command、file path、環境変数名
- library、standard、decoder、license の正式名称
- code block、source identifier、machine-readable JSON の key
- SBOM、npm audit、release evidence など外部形式に従う機械生成データ

英語の専門語を不自然に訳すより、実装や外部仕様を検索できる識別子を保持することを優先します。

## README

README の最初には、用途が非日本語話者にも伝わる 1 段落の English summary を置きます。以降は日本語で、次の事項を明確に説明します。

- 何ができるか
- 利用条件と信頼境界
- インストールと使い方
- 検証済みの範囲
- 未検証事項と既知の制約
- 開発・ビルド手順

## Release Notes と CHANGELOG

GitHub Release notes と `CHANGELOG.md` は日本語本文を基本にします。ただし、version、tag、artifact 名、hash、command、API 名は英語の正式表記を維持します。

Release Notes は、利用者が次を短時間で判断できる構成にします。

- 何が利用できるか
- どの実行ファイルを選ぶか
- セキュリティ上の前提
- どこまで検証したか
- 何をまだ保証していないか

## コミットと Pull Request

commit message は日本語を基本にし、変更種別が明確になる場合だけ `docs:`、`fix:`、`test:` などの conventional prefix を使用します。

Pull Request の説明と AI agent の最終報告は、原則として次の順で記録します。

1. 変更内容
2. 検証
3. 変更しなかったこと
4. 残る制約またはリスク

## 文書スタイル

- code block 内の識別子は翻訳しません。
- API shape や response shape は TypeScript または HTTP の正式な表記を使います。
- security claim と verification claim は、実際の証跡より強く書きません。
- `E2EE`、`encrypted at rest`、`trusted LAN` など意味の異なる用語を混同しません。
- 日本語と英語が混在しても、検索可能性と技術的な正確さを優先します。

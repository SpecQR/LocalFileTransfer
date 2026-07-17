# セキュリティポリシー

## サポート対象

Security fix は、最新の正式版を対象に開発します。現在のサポート対象は `2.0.0` です。RC 系列は比較・移行確認用の旧 prerelease です。

## 脆弱性の報告

悪用可能な脆弱性を公開 Issue へ投稿しないでください。Repository の **Security** tab から private vulnerability report を送信してください。

https://github.com/SpecQR/LocalFileTransfer/security/advisories/new

可能な範囲で、次を含めてください。

- 影響を受ける version
- Windows、browser、device の version
- 想定する network 条件
- 再現手順
- 想定される影響
- 第三者の data を含まない proof of concept

機密性のない hardening proposal は、secret と個人情報を除いたうえで通常の Issue に投稿できます。

## Product boundary

Local File Transfer は trusted local network で使用する製品です。Browser UI は HTTP で配信され、file traffic は end-to-end encrypted ではありません。

Active hostile LAN を前提とする報告でも、authorization bypass、remote code execution、persistent compromise、unsafe file handling、secret leakage、または実装と矛盾する security claim を示す場合は重要です。一方、hostile-network confidentiality がないこと自体は、文書化済みの設計上の制約です。

本プロジェクトには cloud service、account system、telemetry endpoint、update service、remote support channel はありません。

# コード署名方針

## 現在の状態

Local File Transfer 2.0.0 の Windows Portable EXE は Authenticode 未署名です。Release には、実体確認用の SHA-256、CycloneDX SBOM、GitHub build provenance / SBOM attestation を添付します。

GitHub Artifact Attestation は、artifact と repository、workflow、source commit の来歴を確認するものです。Windows publisher identity を証明する Authenticode の代替ではありません。

自己署名 certificate は、公開ユーザーの Windows では既定で信頼されません。開発用 certificate を付けて「署名済み」に見せることはせず、未署名である事実を UI 外の公開文書と release evidence に明記します。

## 2.0.0 の判断

2.0.0 は未署名のまま公開します。理由は次のとおりです。

- Portable-only の小さな配布体験を維持する。
- Certificate、外部署名 account、審査前の仮実装を release secret に追加しない。
- Publisher trust を検証できない署名を導入しない。
- SignPath Foundation などの審査と運用条件が整うまで、現在の reproducible input、SHA-256、attestation、SBOM を維持する。

Windows SmartScreen の警告が表示される場合があります。利用者は GitHub Release の `SHA256SUMS.txt` と、可能であれば `gh attestation verify` で download artifact を確認してください。

## 将来の第一候補

[SignPath Foundation](https://signpath.org/) は、条件を満たす open-source project に managed code signing を無償提供しています。Local File Transfer は MIT license、公開 source、tag-driven GitHub-hosted build、SBOM、release evidence を備えているため、技術面では候補になります。

ただし、採用は自動ではありません。[SignPath Foundation conditions](https://signpath.org/terms.html) に従い、少なくとも次が必要です。

- Project が既に公開・維持・文書化され、審査に足る reputation を持つこと。
- GitHub App と trusted build integration を許可すること。
- Author、reviewer、approver の責任を明示し、repository access に MFA を使用すること。
- Signing request ごとに人間が承認すること。
- Source から signing artifact までを GitHub-hosted runner 上で検証可能にすること。
- Home page と download page に code signing policy、team role、privacy policy を掲載すること。

本 repository は、現時点で SignPath Foundation へ参加しておらず、SignPath certificate で署名されているとは主張しません。Application は、公開実績ができ、maintainer が GitHub App access、役割の公開、毎回の手動承認を受け入れると判断した後に行います。

## その他の選択肢

Microsoft は、Windows app の主な選択肢として Microsoft Store の MSIX signing、Azure Artifact Signing、CA 発行の OV certificate を案内しています。

- Microsoft Store MSIX は Store が署名しますが、現在の Portable-only 配布とは別の packaging と審査が必要です。
- Azure Artifact Signing は CI と統合できますが、個人開発者の利用可能地域に制限があります。
- OV certificate は世界的に利用できますが、identity validation、費用、HSM または hardware token の運用が必要です。

最新条件は [Microsoft の Windows code signing options](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options) を確認してください。

## 有効化の gate

将来 Authenticode を有効化する場合、certificate を設定しただけでは完了としません。

1. Signing provider の審査と repository integration を完了する。
2. Certificate と token を source、artifact、log に残さない。
3. x64 / ARM64 の両 artifact を同じ policy で署名する。
4. Windows trust policy と timestamp chain で signature を検証する。
5. Signed artifact に対して packaged recovery smoke、PE/fuse、SBOM、SHA-256、GitHub Attestation を再実行する。
6. Release Notes、README、evidence を実際の signature status と一致させる。

署名導入が user experience、release reproducibility、security boundary を悪化させる場合は、未署名の明示と検証可能な provenance を維持します。

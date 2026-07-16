## 変更内容

<!-- 何を、なぜ変更したかを日本語で記載してください。API 名、file path、command は英語の正式表記で構いません。 -->

## 検証

<!-- 実行した test、manual check、確認環境を記載してください。 -->

- [ ] `npm run audit:public`
- [ ] `npm run test:all`
- [ ] `npm run build`
- [ ] User-visible / protocol change の場合は `npm run test:e2e`

## 変更しなかったこと

<!-- Scope 外とした事項、互換性のため残した事項を記載してください。 -->

## 残る制約・リスク

<!-- 未検証 platform や、evidence で確認できていない事項を記載してください。 -->

## 公開安全性

- [ ] Executable、database、upload、log、`.env`、signing material を含めていない。
- [ ] Absolute local path、personal email、live QR、private work log を含めていない。
- [ ] Security claim と verification claim が実際の evidence を超えていない。

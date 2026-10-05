# SpecQR 統合と v3 RC 互換性レビュー

Local File Transfer の main は、[SpecQR](https://github.com/SpecQR/SpecQR) `3.0.0-rc.2` の実用的な integration example です。これは正式版ではなくリリース候補版です。

2026-10-05 に GitHub Release と npm dist-tags を確認しました。正式版 latest は 2.4.0、next は 3.0.0-rc.2 です。ユーザーが RC 採用を明示選択したため、次回向け source を更新しました。公開済み Local File Transfer v2.0.1 EXE とその evidence は SpecQR 2.4.0 のままです。

Dependency は `apps/web/package.json` で exact pin しています。

```json
"specqr": "3.0.0-rc.2"
```

Lockfile も resolved package と integrity を固定します。明示的な compatibility decision なしに別 package または floating version へ変更しないでください。

## QR 生成の担当範囲と言語版の選定

QR の符号化、誤り訂正、matrix 配置、mask 選択、quiet zone、SVG の出力まで、SpecQR の JavaScript package が担当します。旧 2.4.0 統合も既にこの構成でした。Local File Transfer 側の処理は URL の用意、L/M の選択、SVG の表示だけです。

SpecQR JavaScript package の runtime dependency はゼロです。別の QR encoder、画像生成サービス、C# / C++ bridge は必要ありません。`jsQR 1.4.0` は独立した読み戻し検証のためだけに root devDependency として追加しています。QR 生成には使わず、Electron main / preload / service と Vite UI の runtime import に含めません。

[SpecQR-CSharp](https://github.com/SpecQR/SpecQR-CSharp) と [SpecQR-CPP](https://github.com/SpecQR/SpecQR-CPP) も、それぞれ .NET / C++ の標準ライブラリを使って QR と SVG / PNG を生成できます。C# / C++ 製品に統合する場合の選択肢です。本製品は Electron と browser で同じ React / TypeScript UI を使うため、公式 JavaScript API を直接使う構成を採用します。

## 2.4.0 からの互換性判断

- 利用する API は `QRCode.estimate(value, options)` と `QRCode.generate(value, { output: "svg", ...options })` です。
- v3 の API shape breaking change は `generateSegmentsStructuredAppend()` の診断詳細にあり、本製品はその API を呼びません。
- 容量超過の planning result で `CAPACITY_NEAR_LIMIT` を返さなくなった correctness change があります。本製品の L/M 判定は `ok` と `selectedVersion` を使用し、warning 配列には依存しません。
- Package は floating な `next` ではなく `3.0.0-rc.2` に固定し、lockfile の registry URL と integrity も保存します。upstream main の未公開変更は取り込みません。
- 移行前の 2.4.0 で合成 URL の SVG SHA-256 を採取し、同じ payload、ECC、Version、4 module の余白、SVG bytes が維持されることを回帰検証します。全 payload での同一性を主張するものではありません。

参照: [v3 移行ガイド](https://github.com/SpecQR/SpecQR/blob/v3.0.0-rc.2/docs/v3-migration.md)、[RC.2 Release](https://github.com/SpecQR/SpecQR/releases/tag/v3.0.0-rc.2)、[npm package](https://www.npmjs.com/package/specqr/v/3.0.0-rc.2)。

## 2026-10-05 の検証範囲

- Unit / integration: 111 件成功（protocol/shared 14、release 10、server 58、web 29）。
- Production build と公開ツリー監査に成功。root / web / server / desktop の dependency audit は全て既知の通知ゼロ。
- Electron E2E: Android Chromium と iPhone WebKit で計 4 件成功。実 SVG の独立 decode、15 MiB 相当を含む複数ファイル転送、Shared text、Room 期限更新と再接続を検証。
- Windows scale 100 / 125 / 150 / 200% で幅 300 CSS px、QR 276 x 276 CSS px、document overflow なしを確認。
- x64 / ARM64 の Portable QA build、PE architecture と Electron fuse の検証に成功。既存 release asset は置換していません。
- x64 QA EXE は起動、HTTP 200、SQLite 作成、Utility Process 強制終了後の復旧、正常終了、残存 process ゼロを確認。署名は未付与で、物理 ARM64 での動作確認は未実施です。
- 上記は自動化ブラウザーと Windows の検証です。物理 iPhone / Android の Camera による今回の再スキャンは未実施であり、読み取り速度の向上は主張しません。

## Error-correction selection

`apps/web/src/ui/qrOptions.ts` は payload を 2 回 estimate します。

```ts
const low = QRCode.estimate(value, { errorCorrectionLevel: "L" });
const medium = QRCode.estimate(value, { errorCorrectionLevel: "M" });
```

Level M が同じ QR Version に収まる場合は M を使用します。M により Version が上がる場合だけ L を選択します。

この方針により、module 数が増えない場合はより強い recovery を得て、Version boundary を超える場合は同じ物理サイズ内の module pitch を大きく保ちます。

Requested QR Version を手動で下げる必要はありません。SpecQR は URL と error correction level が収まる最小 Version を選びます。Payload capacity より低い Version を強制すると、読み取りが改善するのではなく generation が失敗します。

## SVG generation

`apps/web/src/ui/QRPanel.tsx`:

```ts
QRCode.generate(url, {
   errorCorrectionLevel,
   margin: 4,
   output: "svg",
   scale: 1
});
```

- `margin: 4`: QR standard の quiet zone を 1 回だけ生成する。
- `output: "svg"`: Windows DPI factor が変わっても edge を鮮明に保つ。
- `scale: 1`: Symbol 内へ固定 pixel size を埋めず、final size を responsive CSS に任せる。
- Generated SVG は 1 つの square layout region を width/height 100% で満たす。

SVG 内に追加の white padding は入れません。Surrounding panel は UI frame としてのみ存在し、正方形です。

これにより、fixed raster dimension や unequal container padding で QR が clip されたり、左右と上下の余白が異なったりする問題を避けます。

SVG string は pinned SpecQR encoder から直接得ます。Encoded value は locally generated join URL です。Dedicated element へ挿入し、uploaded SVG または arbitrary HTML は受け付けません。

## Payload と privacy

QR は local room URL と random capability を fragment に含みます。Fragment は initial HTTP request には含まれませんが、load された browser code から読めます。

Live QR の screenshot は、room が reset または expire するまで credential として扱ってください。Public document には expired または synthetic QR だけを使用します。

SpecQR は payload を encode しますが、transport encryption や access control は提供しません。それらは room protocol の責務です。

## Test

`apps/web/src/ui/qrOptions.test.ts` は Version-sensitive な L/M selection を検証します。

`apps/web/src/ui/qrCompatibility.test.ts` は合成した IPv4、長い IPv4/port、IPv6、hostname の 4 URL について、2.4.0 と SVG SHA-256、selected Version、4 module の quiet zone が一致することを検査します。実環境の capability は fixture に保存しません。

`tests/e2e/room-transfer.spec.ts` は Electron が実際に生成した SVG を取得し、Chromium / WebKit それぞれで表示寸法へ rasterize します。jsQR で読み戻した URL が bootstrap と一致することを確認し、その decoded URL で Room に参加して双方向転送を実行します。判定は boolean で比較し、失敗時に live capability を assertion log へ出しません。

Browser/DPI suite:

- Non-empty SVG が render される。
- Width と height が等しい。
- Windows scale 100%、125%、150%、200% で desktop viewport 内に収まる。
- Room state が変化しても surrounding control が移動しない。
- QR payload が mobile browser context から同じ room を開く。

SpecQR upgrade 時は、これらをすべて再実行し、short URL と longest expected room URL を物理 phone の標準 Camera で scan します。

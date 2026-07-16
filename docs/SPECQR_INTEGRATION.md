# SpecQR 2.4.0 integration

Local File Transfer は、[SpecQR](https://github.com/SpecQR/SpecQR) `2.4.0` の実用的な integration example です。

Dependency は `apps/web/package.json` で exact pin しています。

```json
"specqr": "2.4.0"
```

Lockfile も resolved package と integrity を固定します。明示的な compatibility decision なしに別 package または floating version へ変更しないでください。

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

Browser/DPI suite:

- Non-empty SVG が render される。
- Width と height が等しい。
- Windows scale 100%、125%、150%、200% で desktop viewport 内に収まる。
- Room state が変化しても surrounding control が移動しない。
- QR payload が mobile browser context から同じ room を開く。

SpecQR upgrade 時は、これらをすべて再実行し、short URL と longest expected room URL を物理 phone の標準 Camera で scan します。

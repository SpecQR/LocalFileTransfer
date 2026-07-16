# ビルドとリリース

## Toolchain

- Node.js 22 以上
- npm
- Portable package と runtime smoke を行う Windows 10 / 11
- ARM64 runtime を検証済みと表記する場合は、物理 Windows on ARM device
- Signing を行う場合だけ、build environment から渡す Authenticode certificate

Root、server、web、desktop は意図的に独立して install するため、4 つの lockfile を使用します。

## Clean install

```powershell
npm ci
npm ci --prefix apps/server
npm ci --prefix apps/web
npm ci --prefix apps/desktop
```

Release preparation と同時に広範な dependency update を行わないでください。Lockfile change は別の変更として review と test を行います。

## Source gate

```powershell
npm run audit:public
npm run test:all
npm run build
npm run test:e2e
npm run verify:release-config
```

各 lockfile scope の audit:

```powershell
npm audit --audit-level=high
npm audit --audit-level=high --prefix apps/server
npm audit --audit-level=high --prefix apps/web
npm audit --audit-level=high --prefix apps/desktop
```

## 未署名 Portable build

```powershell
npm run dist:windows
npm run dist:windows:arm64
```

RC.2 の expected artifact name:

```text
Local.File.Transfer-2.0.0-rc.2-x64-Portable.exe
Local.File.Transfer-2.0.0-rc.2-arm64-Portable.exe
```

Portable executable は Git へ commit せず、GitHub Release asset としてのみ公開します。

## Electron security fuse

electron-builder が各 architecture を unpack した後に実行します。

```powershell
npm run verify:fuses --prefix apps/desktop
npm run verify:fuses:arm64 --prefix apps/desktop
```

Release configuration は、RunAsNode、Node options、CLI inspect、extra file-protocol privilege が無効であること、ASAR integrity と cookie encryption が有効であることを要求します。

`verify:release-config` は renderer sandbox、navigation/permission policy、package invariant も確認します。

## Packaged runtime smoke

x64 Windows:

```powershell
npm run test:packaged
```

Script は development server ではなく Portable artifact 自体を起動し、次を確認します。

1. Local health endpoint と app page が応答する。
2. Utility Process failure を注入する。
3. Service が再起動し、endpoint が復旧する。
4. Window を閉じる。
5. Endpoint が停止する。
6. App process が残らない。

Evidence に local absolute path、live QR credential、user data を含めてはいけません。

ARM64 を runtime verified と記載する前に、物理 Windows on ARM で同等の user-level matrix を実行します。

## DPI と browser verification

```powershell
npm run test:visual
npm run test:e2e
```

Windows scale 100%、125%、150%、200% の screenshot と machine-readable geometry report を確認します。生成 screenshot と report は local evidence です。Live QR、file name、個人情報がないことを確認した場合だけ公開できます。

## SBOM、audit、license、artifact evidence

両 EXE を `apps/desktop/release` に置き、4 scope の dependency を install した状態で実行します。

```powershell
npm run release:evidence
npm run release:static-validation
```

`release:evidence` は `docs/release/<version>` に次を生成します。

- Scope ごとの CycloneDX SBOM
- npm audit JSON
- Dependency inventory
- License inventory と third-party license reference
- Artifact size、SHA-256、architecture、Authenticode status

`release:static-validation` は次を確認します。

- PE machine value
- Electron fuse
- Packaged smoke evidence
- Signing input がない場合の拒否
- Shared text storage claim
- DPI geometry

物理 ARM64 evidence がなければ、ARM64 runtime は未実施として記録します。

## Signing

Signing command は意図的に gate されています。

```powershell
npm run dist:windows:signed:x64
npm run dist:windows:signed:arm64
```

Release environment だけで、electron-builder compatible な `WIN_CSC_LINK` と `WIN_CSC_KEY_PASSWORD` を渡します。

Certificate、password、encoded key、`.env`、secret を含む CI log を commit または公開しないでください。Unsigned artifact は必ず unsigned と表示し、publisher identity があるように示さないでください。

## RC.2 reference artifact

Initial public RC.2 の expected value:

| Architecture | Bytes | SHA-256 | Runtime status |
| --- | ---: | --- | --- |
| x64 | 105186228 | `2A204299CAF932DF4BD13202E8A9F0D0FD44B4973CCDB28B13D5A70165FF1DAD` | Packaged smoke passed |
| ARM64 | 96761317 | `07FE5DB06E8059E4F81A35689C522D6414F4D67C0D7C0B60AF9B149E7B4E0172` | Build/static passed; physical runtime not run |

Upload する exact file から hash を再計算します。予期せず異なる場合は publication を中止します。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath <artifact>
```

## GitHub prerelease

Reviewed source commit に tag `v2.0.0-rc.2` を付け、GitHub Release を prerelease として作成します。

添付する asset:

1. x64 Portable EXE
2. ARM64 Portable EXE
3. `SHA256SUMS.txt`
4. Scope ごとの CycloneDX SBOM JSON
5. `THIRD_PARTY_LICENSES.md`
6. Dependency/license inventory
7. Machine-readable validation evidence

Release Notes には、unsigned status、x64 runtime result、ARM64 physical-test gap、trusted-LAN boundary、iPhone/Android の未実施 manual qualification を明記します。

Upload 後は public Release page から各 asset を確認し、size と SHA-256 を照合します。

## Reproducibility

Source と package lock は固定していますが、Portable wrapper が machine 間で bit-for-bit reproducible であるとは主張しません。Electron/NSIS metadata と upstream package delivery により byte が変わる場合があります。

Release identity は、公開した SHA-256、tagged source、SBOM の組み合わせで確認します。

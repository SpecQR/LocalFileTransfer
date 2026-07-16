const {
   FuseState,
   FuseV1Options,
   getCurrentFuseWire
} = require("@electron/fuses");

const executable = process.argv[2];

if (!executable) {
   throw new Error("Usage: node scripts/verify-fuses.cjs <electron-executable>");
}

const expected = new Map([
   [FuseV1Options.RunAsNode, FuseState.DISABLE],
   [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
   [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
   [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
   [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
   [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
   [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
   [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE]
]);

void getCurrentFuseWire(executable).then((wire) => {
   const report = {};

   for (const [option, state] of expected) {
      const name = FuseV1Options[option];
      const actual = wire[option];

      report[name] = FuseState[actual];

      if (actual !== state) {
         throw new Error(name + " expected " + FuseState[state] + " but found " + FuseState[actual]);
      }
   }

   process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}).catch((error) => {
   console.error(error);
   process.exitCode = 1;
});

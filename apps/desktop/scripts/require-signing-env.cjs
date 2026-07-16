const linkVariable = process.env.WIN_CSC_LINK
   ? "WIN_CSC_LINK"
   : process.env.CSC_LINK ? "CSC_LINK" : undefined;
const passwordVariable = process.env.WIN_CSC_KEY_PASSWORD
   ? "WIN_CSC_KEY_PASSWORD"
   : process.env.CSC_KEY_PASSWORD ? "CSC_KEY_PASSWORD" : undefined;

if (!linkVariable || !passwordVariable) {
   throw new Error(
      "Signed Windows builds require WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD "
      + "(or electron-builder's CSC_LINK and CSC_KEY_PASSWORD fallbacks)."
   );
}

process.stdout.write(
   "Windows signing inputs are present in "
   + linkVariable
   + " and "
   + passwordVariable
   + ". Values were not read or printed.\n"
);

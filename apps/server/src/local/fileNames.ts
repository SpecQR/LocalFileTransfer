import { access } from "node:fs/promises";
import { extname, join } from "node:path";

const invalidWindowsCharacters = /[<>:"/\\|?*\u0000-\u001f]/gu;
const reservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const maxFileNameLength = 180;

export function sanitizeFileName(input: string): string {
   const normalized = input.normalize("NFC").replace(invalidWindowsCharacters, "_").trim().replace(/[. ]+$/u, "");
   const safe = normalized || "file";
   const unrestricted = reservedWindowsName.test(safe) ? `_${safe}` : safe;

   if (unrestricted.length <= maxFileNameLength) {
      return unrestricted;
   }

   const extension = extname(unrestricted);
   const stemLength = Math.max(1, maxFileNameLength - extension.length);

   return `${unrestricted.slice(0, stemLength)}${extension}`;
}

export async function availableFilePath(
   directory: string,
   requestedName: string,
   reservedPaths: ReadonlySet<string> = new Set()
): Promise<string> {
   const safeName = sanitizeFileName(requestedName);
   const extension = extname(safeName);
   const stem = extension ? safeName.slice(0, -extension.length) : safeName;

   for (let index = 0; index < 10_000; index += 1) {
      const suffix = index === 0 ? "" : ` (${index})`;
      const candidate = join(directory, `${stem}${suffix}${extension}`);

      if (!reservedPaths.has(candidate) && !(await pathExists(candidate))) {
         return candidate;
      }
   }

   throw new Error("Could not allocate a unique destination filename");
}

async function pathExists(path: string): Promise<boolean> {
   try {
      await access(path);
      return true;
   } catch {
      return false;
   }
}
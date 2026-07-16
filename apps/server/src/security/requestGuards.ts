export function parseRequestHostname(host: string | undefined): string | undefined {
   if (!host || host.length > 255 || /[\u0000-\u0020\u007f]/u.test(host)) {
      return undefined;
   }

   try {
      const url = new URL("http://" + host);

      if (
         url.protocol !== "http:"
         || url.username
         || url.password
         || url.pathname !== "/"
         || url.search
         || url.hash
      ) {
         return undefined;
      }

      return unbracket(url.hostname).toLowerCase();
   } catch {
      return undefined;
   }
}

export function isSameHttpOrigin(
   origin: string | string[] | undefined,
   host: string | undefined
): boolean {
   if (origin === undefined) {
      return true;
   }

   if (Array.isArray(origin) || !host || origin.length > 512) {
      return false;
   }

   try {
      const originUrl = new URL(origin);
      const hostUrl = new URL("http://" + host);

      return origin === originUrl.origin
         && originUrl.protocol === "http:"
         && !originUrl.username
         && !originUrl.password
         && originUrl.pathname === "/"
         && !originUrl.search
         && !originUrl.hash
         && originUrl.origin === hostUrl.origin;
   } catch {
      return false;
   }
}

function unbracket(value: string): string {
   return value.startsWith("[") && value.endsWith("]")
      ? value.slice(1, -1)
      : value;
}

export async function copyText(value: string): Promise<void> {
   if (navigator.clipboard?.writeText) {
      try {
         await navigator.clipboard.writeText(value);
         return;
      } catch {
         // Plain HTTP LAN origins may not expose the asynchronous Clipboard API.
      }
   }

   const field = document.createElement("textarea");

   field.value = value;
   field.setAttribute("aria-hidden", "true");
   field.style.inset = "0 auto auto -10000px";
   field.style.position = "fixed";
   document.body.append(field);
   field.focus();
   field.select();

   try {
      if (!document.execCommand("copy")) {
         throw new Error("Clipboard copy was rejected");
      }
   } finally {
      field.remove();
   }
}

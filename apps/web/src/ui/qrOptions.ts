import { QRCode } from "specqr";

export type QrErrorCorrectionLevel = "L" | "M";

/**
 * Preserve M-level recovery whenever it fits the same QR version as L.
 * Use L only when it reduces the number of modules on screen.
 */
export function selectQrErrorCorrectionLevel(value: string): QrErrorCorrectionLevel {
   const low = QRCode.estimate(value, {
      errorCorrectionLevel: "L"
   });
   const medium = QRCode.estimate(value, {
      errorCorrectionLevel: "M"
   });

   if (
      low.ok
      && (!medium.ok || low.selectedVersion < medium.selectedVersion)
   ) {
      return "L";
   }

   return "M";
}
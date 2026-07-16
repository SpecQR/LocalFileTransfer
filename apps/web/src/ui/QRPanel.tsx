import { Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { QRCode } from "specqr";
import { selectQrErrorCorrectionLevel } from "./qrOptions.ts";

interface QRPanelProps {
   url: string;
   label: string;
   compact?: boolean;
}

export function QRPanel({ url, label, compact = false }: QRPanelProps): JSX.Element {
   const [copied, setCopied] = useState(false);
   const errorCorrectionLevel = useMemo(() => selectQrErrorCorrectionLevel(url), [url]);
   const svg = useMemo(
      () => QRCode.generate(url, {
         errorCorrectionLevel,
         margin: 4,
         output: "svg",
         scale: 1
      }),
      [errorCorrectionLevel, url]
   );

   return (
      <div className={compact ? "qr-panel qr-panel-compact" : "qr-panel"}>
         <div
            aria-label={label}
            className="qr-vector"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
         />
         {!compact ? (
            <>
               <code className="qr-url">{url}</code>
               <button
                  className="secondary-button"
                  type="button"
                  onClick={async () => {
                     await navigator.clipboard.writeText(url);
                     setCopied(true);
                     window.setTimeout(() => setCopied(false), 1800);
                  }}
               >
                  <Copy size={18} />
                  {copied ? "Copied" : "Copy link"}
               </button>
            </>
         ) : null}
      </div>
   );
}

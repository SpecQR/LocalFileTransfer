import { formatBytes, formatEta } from "../utils/format.ts";

interface ProgressViewProps {
   label: string;
   confirmedBytes: number;
   totalBytes: number;
   startedAt?: number | undefined;
}

export function ProgressView({
   label,
   confirmedBytes,
   totalBytes,
   startedAt
}: ProgressViewProps): JSX.Element {
   const ratio = totalBytes > 0 ? confirmedBytes / totalBytes : 0;
   const elapsedSec = startedAt ? Math.max(0.1, (Date.now() - startedAt) / 1000) : 0;
   const speed = elapsedSec > 0 ? confirmedBytes / elapsedSec : 0;
   const eta = speed > 0 ? (totalBytes - confirmedBytes) / speed : Number.NaN;

   return (
      <div className="progress-view">
         <div className="progress-meta">
            <span>{label}</span>
            <span>{formatBytes(confirmedBytes)} / {formatBytes(totalBytes)}</span>
         </div>
         <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.min(100, ratio * 100)}%` }} />
         </div>
         <div className="progress-meta subtle">
            <span>{formatBytes(speed)}/s</span>
            <span>ETA {formatEta(eta)}</span>
         </div>
      </div>
   );
}

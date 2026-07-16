export function formatBytes(bytes: number): string {
   if (bytes === 0) {
      return "0 B";
   }

   const units = [
      "B",
      "KiB",
      "MiB",
      "GiB"
   ];
   const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
   const value = bytes / (1024 ** index);

   return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatEta(seconds: number): string {
   if (!Number.isFinite(seconds) || seconds < 0) {
      return "--";
   }

   if (seconds < 60) {
      return `${Math.ceil(seconds)}s`;
   }

   return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}

export class ConnectionGate {
   private readonly maxTotal: number;
   private readonly maxPerKey: number;
   private readonly counts = new Map<string, number>();
   private total = 0;

   constructor(maxTotal: number, maxPerKey: number) {
      if (
         !Number.isSafeInteger(maxTotal)
         || !Number.isSafeInteger(maxPerKey)
         || maxTotal < 1
         || maxPerKey < 1
         || maxPerKey > maxTotal
      ) {
         throw new RangeError("Invalid connection limits");
      }

      this.maxTotal = maxTotal;
      this.maxPerKey = maxPerKey;
   }

   acquire(key: string): (() => void) | undefined {
      const keyCount = this.counts.get(key) ?? 0;

      if (!key || this.total >= this.maxTotal || keyCount >= this.maxPerKey) {
         return undefined;
      }

      this.total += 1;
      this.counts.set(key, keyCount + 1);
      let released = false;

      return () => {
         if (released) {
            return;
         }

         released = true;
         this.total = Math.max(0, this.total - 1);
         const next = (this.counts.get(key) ?? 1) - 1;

         if (next <= 0) {
            this.counts.delete(key);
         } else {
            this.counts.set(key, next);
         }
      };
   }

   diagnostics(): { total: number; keys: number } {
      return { total: this.total, keys: this.counts.size };
   }
}

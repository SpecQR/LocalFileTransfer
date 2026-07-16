export interface RateLimitResult {
   allowed: boolean;
   retryAfterSeconds: number;
}

interface RateBucket {
   count: number;
   resetAt: number;
}

export class MemoryRateLimiter {
   private readonly buckets = new Map<string, RateBucket>();
   private readonly now: () => number;

   constructor(now: () => number = Date.now) {
      this.now = now;
   }

   check(key: string, limit: number, windowMs: number): RateLimitResult {
      const now = this.now();
      const existing = this.buckets.get(key);
      const bucket = !existing || existing.resetAt <= now
         ? { count: 0, resetAt: now + windowMs }
         : existing;

      bucket.count += 1;
      this.buckets.set(key, bucket);

      if (this.buckets.size > 2_000) {
         this.sweep(now);
      }

      return {
         allowed: bucket.count <= limit,
         retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      };
   }

   private sweep(now: number): void {
      for (const [key, bucket] of this.buckets) {
         if (bucket.resetAt <= now) {
            this.buckets.delete(key);
         }
      }
   }
}
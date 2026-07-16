import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import {
   uploadChunkSize,
   type LocalNetworkCandidate,
   type LocalTransferLimits
} from "../../../packages/protocol/src/index.ts";

const appRoot = resolve(process.cwd());

export interface ServerConfig {
   port: number;
   storageDir: string;
   sessionTtlMs: number;
   sessionHardTtlMs: number;
   limits: LocalTransferLimits;
   staticRoot?: string | undefined;
}

export function loadConfig(env = process.env): ServerConfig {
   return {
      port: Number(env.PORT ?? 8787),
      storageDir: env.LOCAL_TRANSFER_DIR ?? resolve(appRoot, ".data", "local"),
      sessionTtlMs: Number(env.SESSION_TTL_SEC ?? 900) * 1000,
      sessionHardTtlMs: Number(env.SESSION_HARD_TTL_SEC ?? 3600) * 1000,
      limits: {
         maxFiles: Number(env.MAX_FILES ?? 100),
         maxFileSize: Number(env.MAX_FILE_SIZE ?? 4 * 1024 * 1024 * 1024),
         maxSessionSize: Number(env.MAX_SESSION_SIZE ?? 20 * 1024 * 1024 * 1024),
         uploadChunkSize: Number(env.UPLOAD_CHUNK_SIZE ?? uploadChunkSize)
      },
      staticRoot: env.WEB_STATIC_ROOT
   };
}

export function lanOrigins(port: number): string[] {
   return lanCandidates(port).map((candidate) => candidate.origin);
}

export function lanCandidates(port: number): LocalNetworkCandidate[] {
   const candidates: LocalNetworkCandidate[] = [
      {
         origin: `http://localhost:${port}`,
         address: "localhost",
         interfaceName: "Loopback",
         label: "Local device",
         priority: 100,
         warning: "Only this Windows PC can open this address."
      }
   ];
   const interfaces = networkInterfaces();

   for (const [name, entries] of Object.entries(interfaces)) {
      for (const entry of entries ?? []) {
         if (entry.family === "IPv4" && !entry.internal) {
            candidates.push(candidateForInterface(port, name, entry.address));
         }
      }
   }

   return candidates.sort((left, right) => left.priority - right.priority);
}

export function candidateForInterface(port: number, interfaceName: string, address: string): LocalNetworkCandidate {
   const assessment = assessInterface(interfaceName, address);

   return {
      origin: `http://${address}:${port}`,
      address,
      interfaceName,
      label: assessment.warning
         ? `${address} (${interfaceName}, check reachability)`
         : `${address} (${interfaceName})`,
      priority: assessment.priority,
      ...(assessment.warning ? { warning: assessment.warning } : {})
   };
}

export function assessInterface(interfaceName: string, address: string): { priority: number; warning?: string } {
   const lowerName = interfaceName.toLowerCase();
   const virtualPattern = /virtual|vmware|vbox|virtualbox|hyper-v|vethernet|wsl|docker|parallels|nat/u;
   const tunnelPattern = /vpn|wireguard|tailscale|zerotier|tunnel|\btap\b|\btun\b/u;

   if (address.startsWith("10.211.55.")) {
      return {
         priority: 60,
         warning: "This looks like a Parallels shared-network address. Other devices usually need bridged networking."
      };
   }

   if (virtualPattern.test(lowerName)) {
      return {
         priority: 55,
         warning: "This looks like a virtual network adapter and may not be reachable from another device."
      };
   }

   if (tunnelPattern.test(lowerName)) {
      return {
         priority: 45,
         warning: "This looks like a VPN or tunnel adapter and may not be shared by the receiving device."
      };
   }

   if (address.startsWith("169.254.")) {
      return {
         priority: 70,
         warning: "This link-local address is usually not reachable from another device."
      };
   }

   if (!isPrivateIpv4(address)) {
      return {
         priority: 40,
         warning: "This is not a typical private LAN address. Confirm that the other device can reach it."
      };
   }

   if (/wi-?fi|wireless|wlan/u.test(lowerName)) {
      return { priority: 5 };
   }

   if (/ethernet|\beth\d*\b/u.test(lowerName)) {
      return { priority: 8 };
   }

   return { priority: 10 };
}

function isPrivateIpv4(address: string): boolean {
   const parts = address.split(".").map(Number);

   if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
   }

   const [first = -1, second = -1] = parts;

   return first === 10
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
}
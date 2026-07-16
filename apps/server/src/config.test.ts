import assert from "node:assert/strict";
import test from "node:test";
import {
   assessInterface,
   candidateForInterface
} from "./config.ts";

test("ranks physical Wi-Fi ahead of virtual and VPN adapters", () => {
   const wifi = candidateForInterface(8787, "Wi-Fi", "192.168.1.20");
   const vpn = candidateForInterface(8787, "Tailscale", "10.2.3.4");
   const virtual = candidateForInterface(8787, "vEthernet (WSL)", "172.20.0.1");

   assert.ok(wifi.priority < vpn.priority);
   assert.ok(vpn.priority < virtual.priority);
   assert.equal(wifi.warning, undefined);
   assert.match(virtual.warning ?? "", /virtual/u);
});

test("flags link-local and Parallels shared addresses", () => {
   assert.match(assessInterface("Ethernet", "169.254.1.2").warning ?? "", /link-local/u);
   assert.match(assessInterface("Ethernet", "10.211.55.3").warning ?? "", /Parallels/u);
});
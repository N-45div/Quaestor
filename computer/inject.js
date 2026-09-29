// Quaestor Wallet's provider, added to every page the agent's browser opens.
// An EIP-1193 provider, announced under EIP-6963 and set as window.ethereum when
// no other wallet is: each request goes to the wallet on this computer
// (computer/wallet.ts, 127.0.0.1 only), which holds the key. Nothing here holds
// a key or signs; a page talking to it gets reads, or a governed buy.
(() => {
  if (window.__quaestorWallet) return;
  const WALLET = "http://127.0.0.1:8547";
  const listeners = {};
  let id = 0;
  const provider = {
    isQuaestor: true,
    async request({ method, params }) {
      const res = await fetch(WALLET, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
      });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
      if (method === "eth_requestAccounts") (listeners.connect ?? []).forEach((f) => f({ chainId: undefined }));
      return body.result;
    },
    on(event, fn) { (listeners[event] ??= []).push(fn); return provider; },
    removeListener(event, fn) { listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn); return provider; },
  };
  const info = {
    uuid: "8f0c4d1e-7a2b-4c3d-9e8f-0a1b2c3d4e5f",
    name: "Quaestor Wallet",
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%2315130c'/%3E%3Ccircle cx='15' cy='15' r='8' fill='none' stroke='%23d4a843' stroke-width='3'/%3E%3Cpath d='M19 19l6 6' stroke='%23d4a843' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E",
    rdns: "xyz.quaestor.wallet",
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
  if (!window.ethereum) window.ethereum = provider;
  window.__quaestorWallet = provider;
})();

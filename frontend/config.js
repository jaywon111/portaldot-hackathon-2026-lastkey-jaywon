// Frontend config. Loaded before the app module.
// Defaults are the Portaldot testnet values (the same ones the app used before this file existed).
// The local demo overwrites frontend/local-config.js (loaded after this file) with the local chain.
// API_BASE is the keeper claim service. Leave it empty to show the manual command instead.
window.LASTKEY_CONFIG = {
  chainId: 420420777,
  rpc: "https://test-evm-rpc-v3.portaldot.dev",
  explorer: "https://scanner-testnet-v3.portaldot.dev",
  currency: { name: "PDOT", symbol: "PDOT", decimals: 18 },
  // Set to the deployed keeper service, e.g. "https://keeper.example.com". Empty = no one-click claim.
  API_BASE: "",
  // Contract address default. Empty means the owner pastes it, as before.
  lastKeyAddress: "",
};

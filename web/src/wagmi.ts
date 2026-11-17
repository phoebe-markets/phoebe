import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { polygonAmoy } from "viem/chains";
import { NETWORKS } from "./chain";

/**
 * Browser-wallet plumbing for testnet. wagmi handles EIP-6963 wallet discovery (MetaMask, Rabby, ... each get their
 * own connector), per-chain permissions, chain switching/adding and reconnects. Local replays don't use it.
 */
export const wagmiConfig = createConfig({
  chains: [polygonAmoy],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [polygonAmoy.id]: http(NETWORKS.amoy.rpc) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

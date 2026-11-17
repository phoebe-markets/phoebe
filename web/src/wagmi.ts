import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { polygon, polygonAmoy } from "viem/chains";
import { NETWORKS } from "./chain";

/**
 * Browser-wallet plumbing for Amoy and Polygon mainnet. wagmi handles EIP-6963 wallet discovery (MetaMask, Rabby, ... each get their
 * own connector), per-chain permissions, chain switching/adding and reconnects. Local replays don't use it.
 */
export const wagmiConfig = createConfig({
  chains: [polygonAmoy, polygon],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [polygonAmoy.id]: http(NETWORKS.amoy.rpc), [polygon.id]: http(NETWORKS.polygon.rpc) },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

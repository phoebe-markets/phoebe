import { maxUint256, type Address } from "viem";
import { ABI, ABI_EXTRA, type Clients, type Deployment, fmtUsd, log, noId, yesId } from "./config";

const USD = 1_000_000n;

/**
 * Market-maker duties when the protocol trades through KeeperVenue (Path B, NOTES.md). The venue pulls shares and
 * USDC from this wallet via approvals; this keeps both approved and stocked.
 *
 * Inventory: on testnets the keeper may mint mock outcome tokens (MockCTF minter role), standing in for buying them on
 * Polymarket. On mainnet hedger.ts stocks inventory (adapter splits) and hedges on the CLOB instead.
 */
export class Maker {
  private extra = ABI_EXTRA();

  constructor(
    private c: Clients,
    private d: Deployment,
    private targetShares = 500_000n * USD,
    private targetUsdc = 1_000_000n * USD,
  ) {}

  async setup() {
    const me = this.c.account.address;
    // USDC: venue pulls it for buybacks, the PositionManager for liquidations
    for (const spender of [this.d.venue, this.d.positionManager] as Address[]) {
      const a = (await this.read(this.d.usdc, ABI.erc20, "allowance", [me, spender])) as bigint;
      if (a < maxUint256 / 2n) await this.write(this.d.usdc, ABI.erc20, "approve", [spender, maxUint256], `USDC approve ${spender}`);
    }
    const ok = (await this.read(this.d.ctf, this.extra.ctf, "isApprovedForAll", [me, this.d.venue])) as boolean;
    if (!ok) await this.write(this.d.ctf, this.extra.ctf, "setApprovalForAll", [this.d.venue, true], "CTF approve venue");
    await this.restock();
  }

  /** Top inventory and USDC back up to target (seized shares from liquidations also land here). */
  async restock() {
    if (this.d.mockCtf === false) return; // real outcome tokens: the hedger stocks inventory (split pUSD)
    const me = this.c.account.address;
    for (let i = 0; i < this.d.markets; i++) {
      for (const id of [yesId(this.d, i), noId(this.d, i)]) {
        const bal = (await this.read(this.d.ctf, this.extra.ctf, "balanceOf", [me, id])) as bigint;
        if (bal < this.targetShares / 2n) {
          await this.write(this.d.ctf, this.extra.ctf, "mint", [me, id, this.targetShares - bal], `restock token ${id}`);
        }
      }
    }
    const usdc = (await this.read(this.d.usdc, ABI.erc20, "balanceOf", [me])) as bigint;
    if (usdc < this.targetUsdc / 2n) {
      await this.write(this.d.usdc, ABI.erc20, "mint", [me, this.targetUsdc - usdc], `top up USDC to ${fmtUsd(this.targetUsdc)}`);
    }
  }

  private read(address: Address, abi: (typeof ABI)[keyof typeof ABI], functionName: string, args: unknown[]) {
    return this.c.pub.readContract({ address, abi, functionName, args });
  }

  private async write(address: Address, abi: (typeof ABI)[keyof typeof ABI], functionName: string, args: unknown[], what: string) {
    const { request } = await this.c.pub.simulateContract({ account: this.c.account, address, abi, functionName, args });
    const hash = await this.c.wallet.writeContract(request as never);
    const r = await this.c.pub.waitForTransactionReceipt({ hash });
    log(`maker: ${what} (${r.status})`);
  }
}

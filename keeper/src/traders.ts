import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { foundry } from "viem/chains";
import { ABI, type Clients, type Deployment, fmtUsd, log, noId, yesId } from "./config";
import { revertName } from "./risk";

// Anvil dev account #4, funded and approved by script/Deploy.s.sol (public test key).
const ANVIL_TRADER_PK = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";

/**
 * Demo activity, mirroring the backtest's synthetic trader: opens a position at 90% of the max LTV the risk
 * engine allows right now, alternating YES / NO across markets, and closes each one after `holdTicks`.
 */
export class DemoTraders {
  private wallet;
  private side = 0;
  private held: { id: bigint; at: number }[] = [];
  opened = 0;

  constructor(
    private c: Clients,
    private d: Deployment,
    private margin = 5_000_000_000n, // $5k
    private holdTicks = 432, // 3 days of 10-min ticks
  ) {
    const account = privateKeyToAccount((process.env.TRADER_PK ?? ANVIL_TRADER_PK) as `0x${string}`);
    this.wallet = createWalletClient({ chain: foundry, transport: http(c.pub.transport.url), account });
  }

  async step(tick: number) {
    await this.closeExpired(tick);
    const m = this.side % this.d.markets;
    const tokenId = Math.floor(this.side / this.d.markets) % 2 === 0 ? yesId(m) : noId(m);
    this.side++;

    const [price] = (await this.read(this.d.oracle, ABI.oracle, "getPrice", [tokenId])) as [bigint, bigint];
    const allowed = (await this.read(this.d.risk, ABI.risk, "isOpenAllowed", [tokenId])) as boolean;
    const maxLtv = (await this.read(this.d.risk, ABI.risk, "maxLtvBps", [tokenId, price])) as bigint;
    if (!allowed || maxLtv === 0n) return;

    // LTV = B / ((M + B) * fill), fill ~= 1 - spread  =>  B = M * L * f / (1 - L * f)
    const target = (maxLtv * 9_000n) / 10_000n;
    const fill = 9_950n;
    const borrow = (this.margin * target * fill) / (10_000n * 10_000n - target * fill);
    try {
      const { result, request } = await this.c.pub.simulateContract({
        address: this.d.positionManager,
        abi: ABI.pm,
        account: this.wallet.account,
        functionName: "open",
        args: [tokenId, this.margin, borrow, 0n],
      });
      await this.c.pub.waitForTransactionReceipt({ hash: await this.wallet.writeContract(request as never) });
      this.held.push({ id: result as bigint, at: tick });
      this.opened++;
      const lev = Number(this.margin + borrow) / Number(this.margin);
      log(`trader opened #${result} on token ${tokenId} at ${(Number(price) / 1e18).toFixed(3)}: ${fmtUsd(this.margin)} x${lev.toFixed(2)}`);
    } catch (e) {
      const why = revertName(e);
      if (!why) throw e;
      log(`trader open skipped: ${why}`);
    }
  }

  private async closeExpired(tick: number) {
    const keep: typeof this.held = [];
    for (const h of this.held) {
      if (tick < h.at + this.holdTicks) {
        keep.push(h);
        continue;
      }
      const [owner] = (await this.read(this.d.positionManager, ABI.pm, "positions", [h.id])) as [string];
      if (owner === "0x0000000000000000000000000000000000000000") continue; // liquidated/absorbed meanwhile
      try {
        const { request } = await this.c.pub.simulateContract({
          address: this.d.positionManager,
          abi: ABI.pm,
          account: this.wallet.account,
          functionName: "close",
          args: [h.id, 0n],
        });
        await this.c.pub.waitForTransactionReceipt({ hash: await this.wallet.writeContract(request as never) });
      } catch (e) {
        if (revertName(e) !== "Underwater") throw e;
        keep.push(h); // keeper will deal with it
      }
    }
    this.held = keep;
  }

  private read(address: `0x${string}`, abi: (typeof ABI)[keyof typeof ABI], functionName: string, args: unknown[]) {
    return this.c.pub.readContract({ address, abi, functionName, args });
  }
}

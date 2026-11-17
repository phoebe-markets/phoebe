import { BaseError, ContractFunctionRevertedError, maxUint256 } from "viem";
import { ABI, LOG_CHUNK, type Clients, type Deployment, WAD, fees, fmtUsd, log, noId, yesId } from "./config";

type Health = {
  priceWad: bigint;
  value: bigint;
  debt: bigint;
  ltvBps: bigint;
  maxLtvBps: bigint;
  liqLtvBps: bigint;
  liquidatable: boolean;
};

type Lot = { tokenId: bigint; shares: bigint; at: bigint };

export type RiskKeeperOpts = {
  /** Sell absorbed inventory this long after absorbing (chain seconds). Backtested optimum: 6h. */
  coolOff: bigint;
  /** Haircut assumed when re-selling seized shares, to decide whether a liquidation is profitable (bps). */
  slipBufferBps: bigint;
  /** Re-sell seized shares through the venue right away (recycles liquidation capital). */
  recycle: boolean;
};

/**
 * Watches every open position. Each sweep it:
 *   - flags newly liquidatable positions (starts the Dutch-auction bonus clock), then liquidates once the
 *     growing bonus makes it profitable at the current price after a slippage buffer
 *   - absorbs underwater positions into the backstop inventory (the contract refuses to fire-sell them)
 *   - sells each absorbed lot once its cool-off has passed, or when its market has resolved (price 0 or 1)
 *   - once a market's CTF condition resolves: redeems everything the manager holds there (`redeem`), then pays out
 *     each remaining position at the resolved value (`settle`). Absorbed inventory is redeemed with it.
 */
export class RiskKeeper {
  private open = new Set<bigint>();
  private tokenOfPos = new Map<bigint, bigint>(); // from Opened events, so liquidations never rescan logs
  private lots: Lot[] = [];
  private resolved = new Set<bigint>(); // token ids of redeemed markets
  private fromBlock = 0n;
  stats = { liquidations: 0, absorbs: 0, inventorySales: 0, settled: 0, skippedUnprofitable: 0, failed: 0 };

  constructor(
    private c: Clients,
    private d: Deployment,
    private opts: RiskKeeperOpts,
  ) {
    this.fromBlock = BigInt(d.deployBlock ?? 0);
  }

  /** Pull new position events since the last sync. */
  async sync() {
    const head = await this.c.pub.getBlockNumber();
    if (head < this.fromBlock) return;
    const toBlock = head - this.fromBlock > LOG_CHUNK ? this.fromBlock + LOG_CHUNK - 1n : head; // catch up in chunks
    const logs = await this.c.pub.getContractEvents({
      address: this.d.positionManager,
      abi: ABI.pm,
      fromBlock: this.fromBlock,
      toBlock,
    });
    for (const l of logs) {
      const a = (l as unknown as { args: Record<string, bigint> }).args;
      switch (l.eventName) {
        case "Opened":
          this.open.add(a.id);
          this.tokenOfPos.set(a.id, a.tokenId);
          break;
        case "Closed":
        case "Settled":
        case "Liquidated":
          this.open.delete(a.id);
          break;
        case "Absorbed":
          this.open.delete(a.id);
          break;
      }
    }
    this.fromBlock = toBlock + 1n;
  }

  async sweep() {
    // catch up fully before acting (a fresh keeper on a long-lived chain may need several chunks)
    const head = await this.c.pub.getBlockNumber();
    while (this.fromBlock <= head) await this.sync();
    const now = (await this.c.pub.getBlock()).timestamp;
    await this.settleResolved();
    // read every position's health in parallel (batched into one HTTP request), then act sequentially
    const ids = [...this.open].filter((id) => !this.resolved.has(this.tokenOfPos.get(id) ?? -1n));
    const healths = (await Promise.all(
      ids.map((id) =>
        this.c.pub.readContract({ address: this.d.positionManager, abi: ABI.pm, functionName: "health", args: [id] }),
      ),
    )) as Health[];
    for (let i = 0; i < ids.length; i++) {
      if (!healths[i].liquidatable) continue;
      try {
        await this.flagIfNew(ids[i]);
        await this.handle(ids[i], healths[i], now);
      } catch (e) {
        // never die on one position: state can move between simulate and send. Retry next sweep.
        this.stats.failed++;
        log(`#${ids[i]}: action failed (${revertName(e) ?? (e as Error).message.split("\n")[0]}), will retry`);
      }
    }
    await this.sellDueLots(now);
  }

  private async handle(id: bigint, h: Health, now: bigint) {
    const pm = { address: this.d.positionManager, abi: ABI.pm, account: this.c.account } as const;
    try {
      const { result, request } = await this.c.pub.simulateContract({
        ...pm,
        functionName: "liquidate",
        args: [id, maxUint256],
      });
      const [paid, seized] = result as [bigint, bigint];
      const proceeds = (((seized * h.priceWad) / WAD) * (10_000n - this.opts.slipBufferBps)) / 10_000n;
      if (proceeds < paid) {
        this.stats.skippedUnprofitable++;
        return;
      }
      await this.send(request);
      this.stats.liquidations++;
      const pos = this.tokenOfPos.get(id);
      log(`liquidated #${id}: paid ${fmtUsd(paid)} for ${fmtUsd((seized * h.priceWad) / WAD)} of shares (LTV ${h.ltvBps}bps > ${h.liqLtvBps}bps)`);
      if (this.opts.recycle && pos !== undefined) await this.recycle(pos, seized);
    } catch (e) {
      if (revertName(e) !== "UseAbsorb") throw e;
      const tokenId = await this.tokenOf(id);
      const shares = await this.sharesOf(id);
      const { request } = await this.c.pub.simulateContract({ ...pm, functionName: "absorb", args: [id] });
      await this.send(request);
      this.stats.absorbs++;
      this.lots.push({ tokenId, shares, at: now });
      log(`absorbed #${id} (underwater: value ${fmtUsd(h.value)} < debt ${fmtUsd(h.debt)}); selling after cool-off`);
    }
  }

  /** Start the Dutch-auction clock the first time a position is seen liquidatable. */
  private async flagIfNew(id: bigint) {
    const since = (await this.c.pub.readContract({
      address: this.d.positionManager,
      abi: ABI.pm,
      functionName: "liquidatableSince",
      args: [id],
    })) as bigint;
    if (since !== 0n) return;
    const { request } = await this.c.pub.simulateContract({
      address: this.d.positionManager,
      abi: ABI.pm,
      account: this.c.account,
      functionName: "flag",
      args: [id],
    });
    await this.send(request);
  }

  private async sellDueLots(now: bigint) {
    const keep: Lot[] = [];
    for (const lot of this.lots) {
      if (this.resolved.has(lot.tokenId)) continue; // redeemed along with the market
      const [price] = (await this.c.pub.readContract({
        address: this.d.oracle,
        abi: ABI.oracle,
        functionName: "getPrice",
        args: [lot.tokenId],
      })) as [bigint, bigint];
      const resolved = price === 0n || price === WAD;
      if (!resolved && now < lot.at + this.opts.coolOff) {
        keep.push(lot);
        continue;
      }
      const { result, request } = await this.c.pub.simulateContract({
        address: this.d.positionManager,
        abi: ABI.pm,
        account: this.c.account,
        functionName: "sellInventory",
        args: [lot.tokenId, lot.shares, 0n],
      });
      await this.send(request);
      this.stats.inventorySales++;
      log(`sold inventory token ${lot.tokenId}: ${fmtUsd(result as bigint)} back to junior${resolved ? " (resolved)" : ""}`);
    }
    this.lots = keep;
  }

  /** Redeem newly resolved markets, then settle every open position in a redeemed market. */
  private async settleResolved() {
    if (!this.d.conditionIds) return; // deployment without settlement wiring
    const pm = { address: this.d.positionManager, abi: ABI.pm } as const;
    for (let i = 0; i < this.d.markets; i++) {
      const [yes, no, cond] = [yesId(this.d, i), noId(this.d, i), this.d.conditionIds[i]];
      if (this.resolved.has(yes)) continue;
      const done = (await this.c.pub.readContract({ ...pm, functionName: "redeemed", args: [cond] })) as boolean;
      if (!done) {
        const resolved = (await this.c.pub.readContract({ ...pm, functionName: "isResolved", args: [yes] })) as boolean;
        if (!resolved) continue;
        try {
          const { request } = await this.c.pub.simulateContract({ ...pm, account: this.c.account, functionName: "redeem", args: [cond] });
          await this.send(request);
          log(`market ${i} resolved: redeemed the manager's shares`);
        } catch (e) {
          this.stats.failed++;
          log(`market ${i}: redeem failed (${revertName(e) ?? (e as Error).message.split("\n")[0]}), will retry`);
          continue;
        }
      }
      this.resolved.add(yes);
      this.resolved.add(no);
    }
    for (const id of [...this.open]) {
      if (!this.resolved.has(this.tokenOfPos.get(id) ?? -1n)) continue;
      try {
        const { request } = await this.c.pub.simulateContract({ ...pm, account: this.c.account, functionName: "settle", args: [id] });
        await this.send(request);
        this.open.delete(id);
        this.stats.settled++;
        log(`settled #${id} at resolution`);
      } catch (e) {
        this.stats.failed++;
        log(`#${id}: settle failed (${revertName(e) ?? (e as Error).message.split("\n")[0]}), will retry`);
      }
    }
  }

  private async recycle(tokenId: bigint, shares: bigint) {
    const { request } = await this.c.pub.simulateContract({
      address: this.d.venue,
      abi: ABI.venue,
      account: this.c.account,
      functionName: "sell",
      args: [tokenId, shares, 0n],
    });
    await this.send(request);
  }

  // positions(id) -> (owner, tokenId, shares, scaledDebt)
  private async position(id: bigint) {
    return (await this.c.pub.readContract({
      address: this.d.positionManager,
      abi: ABI.pm,
      functionName: "positions",
      args: [id],
    })) as [string, bigint, bigint, bigint];
  }
  private async tokenOf(id: bigint) {
    return (await this.position(id))[1];
  }
  private async sharesOf(id: bigint) {
    return (await this.position(id))[2];
  }
  // ABIs are loaded at runtime (no static types), so simulateContract's request is passed through as-is.
  // biome-ignore lint/suspicious/noExplicitAny: see above
  private async send(request: any) {
    const hash = await this.c.wallet.writeContract({ ...request, ...(await fees(this.c)) });
    const r = await this.c.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") {
      const tx = await this.c.pub.getTransaction({ hash });
      if (r.gasUsed >= tx.gas) throw new Error(`tx out of gas (limit ${tx.gas}): ${hash}`);
      // a reverted tx leaves no state change, so replaying it on top of its block reproduces the reason
      try {
        await this.c.pub.call({ to: tx.to ?? undefined, data: tx.input, account: this.c.account, blockNumber: r.blockNumber });
      } catch (e) {
        throw new Error(`tx reverted (${revertName(e) ?? (e as Error).message.split("\n")[0]}): ${hash}`);
      }
      throw new Error(`tx reverted (reason not reproducible): ${hash}`);
    }
  }

  /** True once market i has been redeemed (no more price pushes needed). */
  isResolvedMarket(i: number) {
    return this.resolved.has(yesId(this.d, i));
  }

  get openCount() {
    return this.open.size;
  }
  get inventoryLots() {
    return this.lots.length;
  }
}

export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

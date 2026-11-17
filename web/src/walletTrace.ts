/**
 * Wallet diagnostics: wraps each connected wallet's EIP-1193 provider so every request is recorded (method, wallet,
 * outcome). When a transaction fails we can say exactly which wallet refused which call, instead of guessing.
 */
export type TraceEntry = { t: number; wallet: string; method: string; ok: boolean; code?: number; message?: string };

const trace: TraceEntry[] = [];
const wrapped = new WeakSet<object>();
(window as unknown as { __phoebeWalletTrace: TraceEntry[] }).__phoebeWalletTrace = trace;

type Provider = { request(args: { method: string; params?: unknown }): Promise<unknown> };

export function traceProvider(provider: unknown, walletName: string) {
  const p = provider as Provider | undefined;
  if (!p || typeof p.request !== "function" || wrapped.has(p)) return;
  wrapped.add(p);
  const original = p.request.bind(p);
  p.request = async (args) => {
    try {
      const r = await original(args);
      trace.push({ t: Date.now(), wallet: walletName, method: args.method, ok: true });
      return r;
    } catch (e) {
      const err = e as { code?: number; message?: string };
      const entry = { t: Date.now(), wallet: walletName, method: args.method, ok: false, code: err.code, message: err.message };
      trace.push(entry);
      console.error("[phoebe wallet]", entry, e);
      throw e;
    } finally {
      if (trace.length > 200) trace.splice(0, trace.length - 200);
    }
  };
}

/** The most recent failed wallet call (within the last minute), for error banners. */
export function lastWalletFailure(): TraceEntry | undefined {
  const f = [...trace].reverse().find((e) => !e.ok);
  return f && Date.now() - f.t < 60_000 ? f : undefined;
}

/** Wallets that announce over EIP-6963 but don't run on EVM testnets like Amoy. */
export const NON_EVM_HINT = /hashpack|tronlink|phantom|keplr|petra|solflare|xverse/i;

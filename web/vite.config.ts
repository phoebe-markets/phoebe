import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const ROOT = resolve(__dirname, "..");

const ABIS = ["PositionManager", "RiskEngine", "KeeperOracle", "LendingPool", "TrancheVault", "MockUSDC"];
const NETS = ["local", "amoy"];
const abiOf = (c: string) => {
  const f = resolve(ROOT, `contracts/out/${c}.sol/${c}.json`);
  return existsSync(f) ? JSON.stringify(JSON.parse(readFileSync(f, "utf8")).abi) : null;
};

/**
 * Dev: serve /deployments/<net>.json and /abi/<Contract>.json straight from the repo, so the UI always matches the
 * latest deploy. Build: copy them into dist/ so the site is fully static.
 */
function protocolFiles(): Plugin {
  const serve = (file: string) => (existsSync(file) ? readFileSync(file) : null);
  return {
    name: "phoebe-protocol-files",
    writeBundle(opts) {
      const out = opts.dir ?? resolve(__dirname, "dist");
      mkdirSync(resolve(out, "abi"), { recursive: true });
      mkdirSync(resolve(out, "deployments"), { recursive: true });
      for (const c of ABIS) {
        const a = abiOf(c);
        if (!a) throw new Error(`missing ABI ${c}: run forge build`);
        writeFileSync(resolve(out, `abi/${c}.json`), a);
      }
      for (const n of readdirSync(resolve(ROOT, "deployments")).filter((f) => NETS.includes(f.replace(/\.json$/, "")))) {
        writeFileSync(resolve(out, `deployments/${n}`), readFileSync(resolve(ROOT, `deployments/${n}`)));
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        let body: Buffer | null = null;
        const dep = url.match(/^\/deployments\/(\w+)\.json/);
        if (dep) body = serve(resolve(ROOT, `deployments/${dep[1]}.json`));
        const m = url.match(/^\/abi\/(\w+)\.json/);
        if (m) {
          const a = abiOf(m[1]);
          body = a ? Buffer.from(a) : null;
        }
        if (dep || m) {
          if (!body) {
            res.statusCode = 404;
            res.end(m ? "ABI not found: run forge build" : `no deployment ${dep?.[1]}: run demo/replay.sh (local) or demo/amoy.sh deploy`);
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(body);
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({ plugins: [react(), protocolFiles()], server: { port: 5173 } });

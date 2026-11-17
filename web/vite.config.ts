import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const ROOT = resolve(__dirname, "..");

/** Serve the live deployment + ABIs straight from the repo, so the UI always matches the latest deploy. */
function protocolFiles(): Plugin {
  const serve = (file: string) => (existsSync(file) ? readFileSync(file) : null);
  return {
    name: "phoebe-protocol-files",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        let body: Buffer | null = null;
        if (url.startsWith("/deployment.json")) body = serve(resolve(ROOT, "deployments/local.json"));
        const m = url.match(/^\/abi\/(\w+)\.json/);
        if (m) {
          const art = serve(resolve(ROOT, `contracts/out/${m[1]}.sol/${m[1]}.json`));
          body = art ? Buffer.from(JSON.stringify(JSON.parse(art.toString()).abi)) : null;
        }
        if (url.startsWith("/deployment.json") || m) {
          if (!body) {
            res.statusCode = 404;
            res.end(m ? "ABI not found: run forge build" : "no deployment: run demo/replay.sh");
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

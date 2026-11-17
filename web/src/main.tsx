import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { wagmiConfig } from "./wagmi";
import { mountStars } from "./brand/stars";
import "./brand/tokens.css";
import "./styles.css";

const queryClient = new QueryClient();

/** A bug in one component must never blank the whole app: show it, with a way to recover. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[phoebe] UI crashed", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app">
        <div className="banner">
          Something broke in the UI: {this.state.error.message}.{" "}
          <button className="btn ghost" onClick={() => location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

// the night sky behind the app (hidden by CSS on the light theme); a little dimmer than the landing page
const sky = document.createElement("canvas");
sky.className = "stars";
sky.setAttribute("aria-hidden", "true");
document.body.prepend(sky);
mountStars(sky, { brightness: 0.75, density: 0.8 });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

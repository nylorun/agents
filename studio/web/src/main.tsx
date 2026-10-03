import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startAnalytics } from "./analytics.ts";
import { embedded, startEmbed } from "./embed/index.ts";
import "./index.css";

// Before the first render, so embed mode never shows Studio's own chrome.
startEmbed(STUDIO_VERSION);
// Never in embed mode: the embedding app owns its own analytics.
startAnalytics({ embedded: embedded(), studioVersion: STUDIO_VERSION });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

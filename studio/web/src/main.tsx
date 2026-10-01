import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { startEmbed } from "./embed/index.ts";
import "./index.css";

// Before the first render, so embed mode never shows Studio's own chrome.
startEmbed(STUDIO_VERSION);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

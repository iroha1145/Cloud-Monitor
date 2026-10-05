import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist/wght.css";
import "@fontsource/geist-mono/latin-400.css";
import "./styles.css";
import "./motion.css";
import HostedRoot from "./HostedRoot";
import { AppErrorBoundary } from "./chunkLoad";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <HostedRoot />
    </AppErrorBoundary>
  </React.StrictMode>,
);

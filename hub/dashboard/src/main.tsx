import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "./styles.css";
import HostedRoot from "./HostedRoot";
import { AppErrorBoundary } from "./chunkLoad";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <HostedRoot />
    </AppErrorBoundary>
  </React.StrictMode>,
);

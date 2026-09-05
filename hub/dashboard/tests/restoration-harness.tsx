// Browser fixture only. This file is not an application build entry.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArchivePanel } from "../src/ArchivePanel";
import { SystemUpdate } from "../src/SystemUpdate";
import "../src/styles.css";

const demo = new URLSearchParams(location.search).has("demo");
const fallbackData = {
  timeZone: "Asia/Tokyo",
  activity: [{ day: "2026-09-04", totalTokens: 1234 }],
  trend: [
    {
      day: "2026-09-04",
      totalTokens: 1234,
      costUsd: null,
      models: { 测试模型: 1234 },
      components: null,
    },
  ],
};
function Harness() {
  const [expired, setExpired] = useState(false);
  return (
    <main style={{ maxWidth: 960, padding: 16, margin: "0 auto" }}>
      <p role="status">{expired ? "鉴权回调已执行" : "组件测试"}</p>
      <ArchivePanel
        accessToken="fixture-only"
        dataMode={demo ? "demo" : "live"}
        fallbackData={fallbackData}
        onAuthExpired={() => setExpired(true)}
      />
      <SystemUpdate
        accessToken="fixture-only"
        dataMode={demo ? "demo" : "live"}
        onAuthExpired={() => setExpired(true)}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);

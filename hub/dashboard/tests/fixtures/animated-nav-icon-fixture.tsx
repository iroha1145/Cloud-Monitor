import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatedNavIcon, ANIMATED_NAV_ICON_NAMES } from "../../src/AnimatedNavIcon";

function Fixture() {
  const [active, setActive] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [actions, setActions] = useState(0);
  return <main style={{ padding: 30 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 180px)", gap: 12 }}>
      {ANIMATED_NAV_ICON_NAMES.map(name => <button key={name} aria-label={`${name} control`} style={{ minHeight: 48, display: "flex", alignItems: "center", gap: 12, color: "rgb(30, 50, 70)" }} onClick={() => setActions(count => count + 1)}>
        {mounted && <AnimatedNavIcon name={name} active={active} size={19} />}{name}
      </button>)}
    </div>
    <button onClick={() => setActive(value => !value)}>Toggle active</button>
    <button onClick={() => setMounted(value => !value)}>Toggle mounted</button>
    <button disabled aria-label="disabled control"><AnimatedNavIcon name="settings" /></button>
    <a href="#action" aria-label="Link control"><AnimatedNavIcon name="download" size={16} />Link action</a>
    <output aria-label="Actions">{actions}</output>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

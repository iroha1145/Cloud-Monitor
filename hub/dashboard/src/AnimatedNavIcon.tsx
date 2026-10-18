import { memo, useEffect, useLayoutEffect, useRef } from "react";
import "./AnimatedNavIcon.css";

/** Adapted from lucide-animated; source links and MIT notice are adjacent. */
export const ANIMATED_NAV_ICON_NAMES = [
  "overview", "models", "devices", "quota", "history", "search",
  "settings", "download", "refresh", "close", "menu",
] as const;
export type AnimatedNavIconName = (typeof ANIMATED_NAV_ICON_NAMES)[number];
export interface AnimatedNavIconProps {
  name: AnimatedNavIconName;
  size?: number;
  active?: boolean;
  className?: string;
}

type StrokeMotion = { selector: string; frames: Keyframe[]; delay?: number };
const shift = (x: number, y: number): Keyframe[] => [
  { transform: "translate(0px, 0px)" },
  { transform: `translate(${x}px, ${y}px)`, offset: 0.4 },
  { transform: "translate(0px, 0px)" },
];
const turn = (degrees: number): Keyframe[] => [
  { transform: "rotate(0deg)" },
  { transform: `rotate(${degrees}deg)`, offset: 0.45 },
  { transform: "rotate(0deg)" },
];
const draw: Keyframe[] = [
  { strokeDasharray: "1 1", strokeDashoffset: "1", opacity: 0.3 },
  { strokeDasharray: "1 1", strokeDashoffset: "0", opacity: 1 },
];
const MOTIONS: Record<AnimatedNavIconName, StrokeMotion[]> = {
  overview: [
    { selector: '[data-part="tile-1"]', frames: shift(1.5, 0) },
    { selector: '[data-part="tile-2"]', frames: shift(0, 1.5), delay: 25 },
    { selector: '[data-part="tile-3"]', frames: shift(-1.5, 0), delay: 50 },
    { selector: '[data-part="tile-4"]', frames: shift(0, -1.5), delay: 25 },
  ],
  models: [
    { selector: '[data-part="middle-layer"]', frames: shift(0, -1.4) },
    { selector: '[data-part="bottom-layer"]', frames: shift(0, -2.4), delay: 35 },
  ],
  devices: [{ selector: '[data-part="screen-scan"]', frames: [
    { opacity: 0, transform: "translateY(-2px)" },
    { opacity: 0.8, offset: 0.3 },
    { opacity: 0, transform: "translateY(3px)" },
  ] }],
  quota: [{ selector: '[data-part="wallet-flap"]', frames: shift(0, -1.2) }],
  history: [
    { selector: '[data-part="hour-hand"]', frames: turn(-30) },
    { selector: '[data-part="minute-hand"]', frames: turn(-70), delay: 20 },
  ],
  search: [
    { selector: '[data-part="lens"]', frames: [{ transform: "scale(1)" }, { transform: "scale(1.08)", offset: 0.45 }, { transform: "scale(1)" }] },
    { selector: '[data-part="search-handle"]', frames: shift(0.6, 0.6), delay: 20 },
  ],
  settings: [{ selector: '[data-part="gear"]', frames: turn(45) }],
  download: [{ selector: '[data-part="download-arrow"]', frames: shift(0, 2) }],
  refresh: [
    { selector: '[data-part="refresh-upper"]', frames: turn(35) },
    { selector: '[data-part="refresh-lower"]', frames: turn(35), delay: 25 },
  ],
  close: [
    { selector: '[data-part="close-1"]', frames: draw },
    { selector: '[data-part="close-2"]', frames: draw, delay: 45 },
  ],
  menu: [
    { selector: '[data-part="menu-1"]', frames: shift(1.5, 0) },
    { selector: '[data-part="menu-2"]', frames: [{ transform: "scaleX(1)" }, { transform: "scaleX(0.75)", offset: 0.4 }, { transform: "scaleX(1)" }], delay: 25 },
    { selector: '[data-part="menu-3"]', frames: shift(-1.5, 0), delay: 50 },
  ],
};

type IconController = { play(): void; stop(): void };
type OwnerBinding = { icons: Set<IconController>; dispose(): void };
const ownerBindings = new WeakMap<Element, OwnerBinding>();
const motionSubscribers = new Set<IconController>();
let reducedQuery: MediaQueryList | null = null;

function onReducedMotionChange() {
  if (reducedQuery?.matches) for (const icon of motionSubscribers) icon.stop();
}

function subscribeMotion(icon: IconController) {
  if (!reducedQuery) reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!motionSubscribers.size) reducedQuery.addEventListener("change", onReducedMotionChange);
  motionSubscribers.add(icon);
  return () => {
    motionSubscribers.delete(icon);
    if (!motionSubscribers.size) {
      reducedQuery?.removeEventListener("change", onReducedMotionChange);
      reducedQuery = null;
    }
  };
}

/** One set of local listeners per owning control; no document/window input listeners. */
function bindOwner(owner: Element, icon: IconController) {
  let binding = ownerBindings.get(owner);
  if (!binding) {
    const icons = new Set<IconController>();
    const play = () => {
      if (owner.matches(":disabled") || owner.getAttribute("aria-disabled") === "true") return;
      for (const entry of icons) entry.play();
    };
    const enter = (event: Event) => { if ((event as PointerEvent).pointerType !== "touch") play(); };
    const key = (event: Event) => {
      const keyboard = event as KeyboardEvent;
      if (!keyboard.repeat && (keyboard.key === "Enter" || keyboard.key === " ")) play();
    };
    owner.addEventListener("pointerenter", enter, { passive: true });
    owner.addEventListener("pointerdown", play, { passive: true });
    owner.addEventListener("focusin", play);
    owner.addEventListener("keydown", key);
    binding = { icons, dispose() {
      owner.removeEventListener("pointerenter", enter);
      owner.removeEventListener("pointerdown", play);
      owner.removeEventListener("focusin", play);
      owner.removeEventListener("keydown", key);
    } };
    ownerBindings.set(owner, binding);
  }
  binding.icons.add(icon);
  return () => {
    binding.icons.delete(icon);
    if (!binding.icons.size) {
      binding.dispose();
      ownerBindings.delete(owner);
    }
  };
}

function geometry(name: AnimatedNavIconName) {
  switch (name) {
    case "overview": return <>
      <rect data-animated-part data-part="tile-1" x="3" y="3" width="7" height="7" rx="1" />
      <rect data-animated-part data-part="tile-2" x="14" y="3" width="7" height="7" rx="1" />
      <rect data-animated-part data-part="tile-3" x="14" y="14" width="7" height="7" rx="1" />
      <rect data-animated-part data-part="tile-4" x="3" y="14" width="7" height="7" rx="1" />
    </>;
    case "models": return <>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path data-animated-part data-part="middle-layer" d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
      <path data-animated-part data-part="bottom-layer" d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
    </>;
    case "devices": return <>
      <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M12 17v4M8 21h8" />
      <path data-animated-part data-part="screen-scan" d="M6 10h12" opacity="0" />
    </>;
    case "quota": return <>
      <path data-animated-part data-part="wallet-flap" d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" />
      <path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" />
    </>;
    case "history": return <>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
      <g data-animated-part data-part="hour-hand" className="animated-nav-icon-pivot"><path d="M12 12V7" /></g>
      <g data-animated-part data-part="minute-hand" className="animated-nav-icon-pivot"><path d="m12 12 4 2" /></g>
    </>;
    case "search": return <>
      <circle data-animated-part data-part="lens" cx="11" cy="11" r="8" />
      <path data-animated-part data-part="search-handle" d="m21 21-4.3-4.3" />
    </>;
    case "settings": return <>
      <path data-animated-part data-part="gear" d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>;
    case "download": return <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <g data-animated-part data-part="download-arrow"><path d="m7 10 5 5 5-5M12 15V3" /></g>
    </>;
    case "refresh": return <>
      <g data-animated-part data-part="refresh-upper" className="animated-nav-icon-pivot"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5" /></g>
      <g data-animated-part data-part="refresh-lower" className="animated-nav-icon-pivot"><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5" /></g>
    </>;
    case "close": return <>
      <path data-animated-part data-part="close-1" pathLength="1" d="M18 6 6 18" />
      <path data-animated-part data-part="close-2" pathLength="1" d="m6 6 12 12" />
    </>;
    case "menu": return <>
      <path data-animated-part data-part="menu-1" d="M4 6h16" />
      <path data-animated-part data-part="menu-2" d="M4 12h16" />
      <path data-animated-part data-part="menu-3" d="M4 18h16" />
    </>;
  }
}

/** Decorative glyph only: interaction, accessible naming and focus stay on the parent. */
export const AnimatedNavIcon = memo(function AnimatedNavIcon({ name, size = 19, active = false, className }: AnimatedNavIconProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const controllerRef = useRef<IconController | null>(null);
  const previousActive = useRef(active);
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const animations = new Set<Animation>();
    let lastPlayedAt = -Infinity;
    const controller: IconController = {
      stop() { for (const animation of animations) animation.cancel(); animations.clear(); },
      play() {
        // Focus can follow pointerdown for the same action; play that feedback once.
        if (reducedQuery?.matches || performance.now() - lastPlayedAt < 70) return;
        lastPlayedAt = performance.now();
        controller.stop();
        for (const { selector, frames, delay = 0 } of MOTIONS[name]) {
          const stroke = svg.querySelector<SVGElement>(selector);
          if (!stroke || typeof stroke.animate !== "function") continue;
          const animation = stroke.animate(frames, { duration: 380, delay, easing: "cubic-bezier(0.25, 1, 0.5, 1)", iterations: 1 });
          animations.add(animation);
          animation.onfinish = animation.oncancel = () => { animations.delete(animation); };
        }
      },
    };
    controllerRef.current = controller;
    const unsubscribe = subscribeMotion(controller);
    const unbind = bindOwner(svg.closest("button, a") || svg, controller);
    return () => { controller.stop(); unbind(); unsubscribe(); controllerRef.current = null; };
  }, [name]);
  useEffect(() => {
    if (previousActive.current !== active) controllerRef.current?.play();
    previousActive.current = active;
  }, [active]);
  return <svg ref={svgRef} className={["animated-nav-icon", className].filter(Boolean).join(" ")}
    data-animated-icon={name} data-active={active ? "true" : "false"}
    width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {geometry(name)}
  </svg>;
});

import { FileClock, Grid2X2, Layers3, Monitor, Wallet } from "lucide-react";
import { scrollToTop } from "./lib/scroll";
import { useSlidingIndicator } from "./lib/hooks/use-sliding-indicator";

const destinations = [
  { id: "overview", label: "总览", name: "总览", icon: Grid2X2 },
  { id: "models", label: "模型", name: "模型分析", icon: Layers3 },
  { id: "devices", label: "设备", name: "设备", icon: Monitor },
  { id: "quota", label: "配额", name: "配额与订阅", icon: Wallet },
  { id: "history", label: "历史", name: "历史记录", icon: FileClock },
] as const;

export type MobilePageId = (typeof destinations)[number]["id"];

export function MobileNavigation({
  page,
  onNavigate,
}: {
  page: MobilePageId;
  onNavigate: (page: MobilePageId) => void;
}) {
  const ref = useSlidingIndicator<HTMLElement>('a[aria-current="page"]');
  return (
    <nav className="mobile-bottom-nav" aria-label="移动端主导航" ref={ref}>
      <span data-sliding-indicator aria-hidden="true" />
      {destinations.map(({ id, label, name, icon: Icon }) => (
        <a
          key={id}
          href={`#${id}`}
          aria-label={name}
          aria-current={page === id ? "page" : undefined}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onNavigate(id);
            scrollToTop();
          }}
        >
          <Icon
            size={20}
            strokeWidth={page === id ? 2 : 1.7}
            aria-hidden="true"
          />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

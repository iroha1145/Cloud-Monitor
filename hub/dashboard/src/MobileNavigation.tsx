import { FileClock, Grid2X2, Layers3, Monitor, Wallet } from "lucide-react";

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
  return (
    <nav className="mobile-bottom-nav" aria-label="移动端主导航">
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
            window.scrollTo({ top: 0, behavior: "instant" });
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

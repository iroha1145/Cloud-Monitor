import { scrollToTop } from "./lib/scroll";
import { PAGES, type PageId } from "./pages";
import { useSlidingIndicator } from "./lib/hooks/use-sliding-indicator";

export function MobileNavigation({
  page,
  onNavigate,
}: {
  page: PageId;
  onNavigate: (page: PageId) => void;
}) {
  const ref = useSlidingIndicator<HTMLElement>('a[aria-current="page"]');
  return (
    <nav className="mobile-bottom-nav" aria-label="移动端主导航" ref={ref}>
      <span data-sliding-indicator aria-hidden="true" />
      {PAGES.map(({ id, short, name, icon: Icon }) => (
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
          <span>{short}</span>
        </a>
      ))}
    </nav>
  );
}

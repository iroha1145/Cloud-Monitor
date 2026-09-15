import { Component, lazy, type ComponentType, type ReactNode } from "react";

const reloadKey = (name: string) => `cm-chunk-reload:${name}`;

/** Lazy import that reloads once after a missing chunk (post-upgrade 404). */
export function lazyWithReload<T extends ComponentType<any>>(
  name: string,
  importer: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const mod = await importer();
      try {
        sessionStorage.removeItem(reloadKey(name));
      } catch {
        /* private mode */
      }
      return mod;
    } catch (error) {
      try {
        if (sessionStorage.getItem(reloadKey(name)) !== "1") {
          sessionStorage.setItem(reloadKey(name), "1");
          location.reload();
          return new Promise<{ default: T }>(() => undefined);
        }
      } catch {
        /* private mode */
      }
      throw error;
    }
  });
}

export class AppErrorBoundary extends Component<
  { title?: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page-loading" role="alert">
        <p>{this.props.title || "页面已更新，请刷新后继续。"}</p>
        <button type="button" onClick={() => location.reload()}>
          刷新页面
        </button>
      </div>
    );
  }
}

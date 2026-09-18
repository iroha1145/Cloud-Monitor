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
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          throw error;
        }
        if (sessionStorage.getItem(reloadKey(name)) !== "1") {
          sessionStorage.setItem(reloadKey(name), "1");
          location.reload();
          return new Promise<{ default: T }>(() => undefined);
        }
      } catch (inner) {
        if (inner === error) throw error;
        /* private mode */
      }
      throw error;
    }
  });
}

export class AppErrorBoundary extends Component<
  {
    title?: string;
    children: ReactNode;
    variant?: "page" | "dialog";
    onFail?: () => void;
    fallback?: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFail?.();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    if (this.props.variant === "dialog") {
      return <DialogErrorNotice title={this.props.title} />;
    }
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

export function DialogErrorNotice({ title, onDismiss }: { title?: string; onDismiss?: () => void }) {
  return (
    <div
      className="dialog-error-toast"
      role="alert"
      style={{
        position: "fixed",
        inset: "auto 16px 16px 16px",
        zIndex: 80,
        padding: "12px 16px",
        borderRadius: 12,
        background: "var(--surface, #fff)",
        boxShadow: "0 8px 24px #0003",
      }}
    >
      <p>{title || "对话框未能打开，请重试或刷新页面。"}</p>
      <button type="button" onClick={() => location.reload()}>
        刷新页面
      </button>
      {onDismiss && <button type="button" onClick={onDismiss}>关闭提示</button>}
    </div>
  );
}

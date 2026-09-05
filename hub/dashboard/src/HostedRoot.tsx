import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Cloud, LoaderCircle, LockKeyhole } from "lucide-react";
import App from "./App";
import { loadOverview, isAuthFailure } from "./api";
import { clearAccessToken, readAccessToken, saveAccessToken } from "./auth";
import type { DashboardData } from "./data";
import "./hosted.css";

const isolatedDemo = document.documentElement.dataset.cmDemo === "1" || import.meta.env.VITE_SHOWCASE_UI === "true";
const localPreview = import.meta.env.DEV && import.meta.env.VITE_HOSTED !== "true";

export default function HostedRoot() {
  const [session, setSession] = useState<{ token: string; data: DashboardData } | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const signOut = useCallback(() => {
    pending.current?.abort();
    clearAccessToken();
    setSession(null);
    setSecret("");
    setError("请重新输入访问密钥。");
    setBusy(false);
  }, []);
  const authenticate = useCallback(async (value: string) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError("");
    try {
      const data = await loadOverview(value, controller.signal);
      if (controller.signal.aborted) return;
      saveAccessToken(value);
      setSecret("");
      setSession({ token: value, data });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthFailure(error)) clearAccessToken();
      setError(error instanceof Error ? error.message : "连接未完成，请稍后重试。");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (isolatedDemo || localPreview) return;
    const token = readAccessToken();
    if (token) void authenticate(token);
    const hide = () => { pending.current?.abort(); setBusy(false); };
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted || sessionRef.current) return;
      setBusy(false);
      const saved = readAccessToken();
      if (saved) void authenticate(saved);
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", restored);
    return () => { pending.current?.abort(); window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", restored); };
  }, [authenticate]);
  if (isolatedDemo || localPreview) return <App isolatedDemo={isolatedDemo} />;
  if (session) return <App key={session.token} hosted initialData={session.data} initialToken={session.token} onSignOut={signOut} />;
  return <main className="access-page">
    <section className="access-card" aria-labelledby="access-heading">
      <span className="access-brand"><Cloud size={27} /> Cloud Monitor</span>
      <div className="access-symbol"><LockKeyhole size={26} /></div>
      <h1 id="access-heading">查看你的用量</h1>
      <p>输入访问密钥，连接这台服务器上的用量记录。</p>
      <form onSubmit={(event) => { event.preventDefault(); if (secret.trim() && !busy) void authenticate(secret.trim()); }}>
        <label htmlFor="login-token">访问密钥</label>
        <input id="login-token" type="password" autoComplete="current-password" autoCapitalize="none" spellCheck={false} value={secret} onChange={event => setSecret(event.target.value)} placeholder="输入面板访问密钥" required disabled={busy} />
        {error && <p className="access-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !secret.trim()}>{busy ? <><LoaderCircle size={18} className="access-spinner" /> 正在连接</> : <>进入工作台 <ArrowRight size={18} /></>}</button>
      </form>
      <small>浏览器标签页关闭后清除密钥。安装为独立应用时，会在此设备保存登录。</small>
    </section>
  </main>;
}

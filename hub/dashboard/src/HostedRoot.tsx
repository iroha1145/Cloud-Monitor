import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, LockKeyhole } from "lucide-react";
import App from "./App";
import { loadDashboard, isAuthFailure } from "./api";
import { clearAccessToken, readAccessToken, saveAccessToken } from "./auth";
import type { DashboardData } from "./data";
import { useErrorShake } from "./lib/hooks/use-error-shake";
import { BrandMark } from "./BrandMark";
import { COMPOSITION } from "./palette";
import "./hosted.css";

// The sign-in page quotes the usage spectrum as an emblem, not as data.
const SPECTRUM_SHARE = [58, 17, 11, 8, 6];

const isolatedDemo = document.documentElement.dataset.cmDemo === "1" || import.meta.env.VITE_SHOWCASE_UI === "true";
const localPreview = import.meta.env.DEV && import.meta.env.VITE_HOSTED !== "true";

export default function HostedRoot() {
  const [session, setSession] = useState<{ token: string; data: DashboardData } | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Only a key the user submitted and the server rejected shakes and turns red.
  const [keyRejected, setKeyRejected] = useState(false);
  const tokenField = useErrorShake<HTMLInputElement>(keyRejected);
  const refocusField = useRef(false);
  useEffect(() => {
    if (busy || !refocusField.current) return;
    refocusField.current = false;
    tokenField.current?.focus();
  }, [busy, tokenField]);
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
  const authenticate = useCallback(async (value: string, submitted = false) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true); setError(""); setKeyRejected(false);
    try {
      const data = await loadDashboard(value, controller.signal);
      if (controller.signal.aborted) return;
      saveAccessToken(value);
      setSecret("");
      setSession({ token: value, data });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthFailure(error)) {
        clearAccessToken();
        setKeyRejected(submitted);
      }
      // The field was disabled while connecting, which dropped its focus.
      refocusField.current = submitted;
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
    <section className="access-brand-panel" aria-hidden="true">
      <span className="access-brand"><BrandMark size={34} /> Cloud Monitor</span>
      <div className="access-statement">
        <p>每台设备、每个模型的词元、缓存与费用，按天归档。</p>
        <div className="access-spectrum">
          {COMPOSITION.map((part, index) => (
            <span key={part.key} style={{ background: part.color, flexGrow: SPECTRUM_SHARE[index] }} />
          ))}
        </div>
        <ul>
          {COMPOSITION.map((part) => (
            <li key={part.key}><i style={{ background: part.color }} />{part.label}</li>
          ))}
        </ul>
      </div>
    </section>
    <section className="access-card" aria-labelledby="access-heading">
      <span className="access-brand access-brand-compact"><BrandMark size={30} /> Cloud Monitor</span>
      <div className="access-spectrum access-spectrum-compact" aria-hidden="true">
        {COMPOSITION.map((part, index) => (
          <span key={part.key} style={{ background: part.color, flexGrow: SPECTRUM_SHARE[index] }} />
        ))}
      </div>
      <h1 id="access-heading">查看你的用量</h1>
      <p>输入访问密钥，连接这台服务器上的用量记录。</p>
      <form onSubmit={(event) => { event.preventDefault(); if (secret.trim() && !busy) void authenticate(secret.trim(), true); }}>
        <label htmlFor="login-token">访问密钥</label>
        <input ref={tokenField} aria-invalid={keyRejected || undefined} aria-describedby={error ? "login-error" : undefined} id="login-token" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} value={secret} onChange={event => setSecret(event.target.value)} placeholder="输入面板访问密钥" required disabled={busy} />
        {error && <p className="access-error" id="login-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !secret.trim()}>{busy ? <><LoaderCircle size={18} className="access-spinner" /> 正在连接</> : <>进入工作台 <ArrowRight size={18} /></>}</button>
      </form>
      <small><LockKeyhole size={13} aria-hidden="true" /> 浏览器标签页关闭后清除密钥。安装为独立应用时，会在此设备保存登录。</small>
    </section>
  </main>;
}

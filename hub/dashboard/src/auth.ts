const TOKEN_KEY = "cm_access_token";
export function readAccessToken(): string {
  try {
    return (matchMedia("(display-mode: standalone)").matches ? localStorage : sessionStorage).getItem(TOKEN_KEY) || "";
  } catch { return ""; }
}
export function clearAccessToken(): void {
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try { storage().removeItem(TOKEN_KEY); } catch { /* blocked storage */ }
  }
}
export function saveAccessToken(token: string): void {
  clearAccessToken();
  try { (matchMedia("(display-mode: standalone)").matches ? localStorage : sessionStorage).setItem(TOKEN_KEY, token); } catch { /* memory-only remains usable */ }
}

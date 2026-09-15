/** Quote every cell. Prefix-neutralize only strings; keep numeric negatives. */
export function escapeCsv(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const raw = value === null || value === undefined ? "" : String(value);
  const safe = /^(?:\s*[=+\-@]|[\t\r\n])/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8;" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

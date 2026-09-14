/** Quote every cell and neutralize formula prefixes before spreadsheet export. */
export function escapeCsv(value: unknown): string {
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

import { config } from "../config.js";
import type { StoredBseCircular } from "../types.js";

// Same visual design as the NSE digest (template.ts), but built directly from
// BSE's own notice shape. Every BSE downtime notice is treated as critical.
const ACCENT = "#b42318";
const ACCENT_BG = "#fef3f2";

function escapeHtml(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function payloadField(payload: string, key: string): string {
  try {
    const value = (JSON.parse(payload) as Record<string, unknown>)[key];
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

/** "2026-08-27T00:00:00" -> "August 27, 2026". */
function displayDate(noticeDate: string): string {
  const date = new Date(`${noticeDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return noticeDate;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "2-digit", year: "numeric" });
}

function fileExtension(fileName: string): string {
  try {
    return /\.([a-z0-9]+)$/i.exec(new URL(fileName).pathname)?.[1]?.toUpperCase() ?? "";
  } catch {
    return "";
  }
}

function details(circular: StoredBseCircular): string[] {
  return [
    displayDate(circular.noticeDate),
    payloadField(circular.payload, "Dept_Name") || config.bse.segment,
    payloadField(circular.payload, "category_name"),
  ].filter(Boolean);
}

export function buildBseSubject(circulars: StoredBseCircular[]): string {
  return `[ACTION NEEDED] BSE MF circulars — ${circulars.length} critical`;
}

export function buildBseHtml(circulars: StoredBseCircular[]): string {
  const generatedAt = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const cards = circulars
    .map((circular) => {
      const ext = fileExtension(circular.fileName);
      const label = !ext || ext === "PDF" ? "Download PDF" : `Download ${escapeHtml(ext)}`;
      const button = circular.fileName
        ? `<div style="margin-top:14px;">
              <a href="${escapeHtml(circular.fileName)}" style="display:inline-block;font:600 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#ffffff;background:#175cd3;border-radius:6px;padding:8px 16px;text-decoration:none;">&#128196; ${label}</a>
            </div>`
        : "";
      return `
      <tr><td style="padding:0 0 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e7ec;border-left:3px solid ${ACCENT};border-radius:6px;background:#ffffff;">
          <tr><td style="padding:16px 18px;">
            <div style="font:600 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:${ACCENT};">${escapeHtml(circular.noticeNo)}</div>
            <div style="margin-top:6px;font:600 15px/1.5 -apple-system,Segoe UI,sans-serif;color:#101828;">${escapeHtml(circular.subject.replace(/[\r\n]+/g, " "))}</div>
            <div style="margin-top:8px;font:400 12px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">
              ${details(circular).map(escapeHtml).join(" &nbsp;·&nbsp; ")}
            </div>
            <div style="margin-top:10px;">
              <span style="display:inline-block;font:600 11px/1.6 -apple-system,Segoe UI,sans-serif;letter-spacing:.4px;color:${ACCENT};background:${ACCENT_BG};border:1px solid ${ACCENT}22;border-radius:4px;padding:1px 7px;">DOWNTIME</span>
            </div>
            ${button}
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2f4f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
        <tr><td style="padding-bottom:18px;">
          <div style="font:700 20px/1.4 -apple-system,Segoe UI,sans-serif;color:#101828;">BSE Mutual Fund circulars</div>
          <div style="margin-top:4px;font:400 13px/1.6 -apple-system,Segoe UI,sans-serif;color:#667085;">
            ${circulars.length} new circular${circulars.length === 1 ? "" : "s"} detected &middot; ${escapeHtml(generatedAt)} IST
          </div>
        </td></tr>
        <tr><td style="padding:10px 0 6px;">
          <div style="font:700 12px/1.6 -apple-system,Segoe UI,sans-serif;letter-spacing:1px;text-transform:uppercase;color:${ACCENT};">
            Critical &nbsp;(${circulars.length})
          </div>
        </td></tr>
        ${cards}
        <tr><td style="padding-top:16px;border-top:1px solid #e4e7ec;">
          <div style="font:400 11px/1.6 -apple-system,Segoe UI,sans-serif;color:#98a2b3;">
            Sent automatically by circular-tracker. Open the PDF before acting.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function buildBseText(circulars: StoredBseCircular[]): string {
  const lines: string[] = [
    `BSE Mutual Fund circulars — ${circulars.length} new`,
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) + " IST",
    "",
    `== CRITICAL (${circulars.length}) ==`,
    "",
  ];
  for (const circular of circulars) {
    lines.push(
      `${circular.noticeNo} — ${displayDate(circular.noticeDate)}`,
      `  ${circular.subject.replace(/[\r\n]+/g, " ")}`,
      circular.fileName ? `  Download PDF: ${circular.fileName}` : "",
      "",
    );
  }
  lines.push("Open the PDF before acting.");
  return lines.join("\n");
}

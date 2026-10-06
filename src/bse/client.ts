import { chromium } from "playwright";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { NseCircular } from "../types.js";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** BSE's API expects YYYY-MM-DD, in India time. */
export function formatBseDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** "2026-10-01T00:00:00" -> "October 01, 2026", matching NSE's cirDisplayDate. */
function displayDate(noticeDate: string): string {
  const date = new Date(`${noticeDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return noticeDate;
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "2-digit", year: "numeric" });
}

/**
 * Maps one BSE notice onto the shared circular shape so it flows through the
 * same dedup → classify → store → digest path as NSE. Returns null for records
 * without a notice number or subject, which cannot be stored or classified.
 *
 * The notice number ("20261001-59") is globally unique and doubles as the
 * identity, so BSE and NSE ids can never collide.
 */
export function normalizeBseNotice(value: unknown): NseCircular | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const noticeNo = asText(record["Notice_No"]);
  const subject = asText(record["Subject"]).replace(/\s+/g, " ");
  if (!noticeNo || !subject) return null;

  const noticeDate = asText(record["Notice_Date"]);
  const fileLink = asText(record["FileName"]);
  const fileExt = /\.([a-z0-9]+)$/i.exec(fileLink.split("?")[0] ?? "")?.[1]?.toLowerCase() ?? "";

  return {
    cirDate: noticeDate.slice(0, 10).replace(/-/g, ""),
    cirDisplayDate: displayDate(noticeDate),
    circCategory: asText(record["category_name"]),
    circCompany: "BSE",
    circDepartment: asText(record["Dept_Name"]) || asText(record["Segment_Name"]) || config.bse.segment,
    circDisplayNo: noticeNo,
    circFileSize: "",
    circFilelink: /^https?:\/\//i.test(fileLink) ? fileLink : "",
    circFilename: fileLink.split("/").pop() ?? "",
    circNumber: noticeNo,
    fileDept: "",
    fileExt,
    sub: subject,
  };
}

async function fetchPayload(url: string): Promise<unknown> {
  const browser = await chromium.launch({
    headless: config.bse.headless,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(config.bse.pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const response = await page.evaluate(async (apiUrl) => {
      const result = await fetch(apiUrl, { signal: AbortSignal.timeout(20_000) });
      return { status: result.status, body: await result.text() };
    }, url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`BSE returned HTTP ${response.status}: ${response.body.slice(0, 300)}`);
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new Error(`BSE returned non-JSON body (${response.body.slice(0, 120)})`);
    }
  } finally {
    await browser.close();
  }
}

export class BseClient {
  /** Fetches every notice in the segment for the window, inclusive, across all departments and categories. */
  async fetchCirculars(fromDate: Date, toDate: Date): Promise<NseCircular[]> {
    const params = new URLSearchParams({
      strTxtNoticeNo: "",
      strTxtDate: formatBseDate(fromDate),
      strTxtTodate: formatBseDate(toDate),
      strScripcode: "",
      strDep: "",
      strSegment: config.bse.segment,
      subject: "",
      category: "",
      containgtext: "",
    });
    const url = `${config.bse.apiUrl}?${params.toString()}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= config.bse.maxRetries; attempt++) {
      try {
        const payload = await fetchPayload(url);
        const table = (payload as { Table?: unknown } | null)?.Table;
        // BSE answers an empty window with `"Table": null`.
        if (table === null) return [];
        if (!Array.isArray(table)) throw new Error("BSE response had no `Table` array");

        const circulars = table
          .map(normalizeBseNotice)
          .filter((circular): circular is NseCircular => circular !== null);
        if (circulars.length !== table.length) {
          log.warn(`Dropped ${table.length - circulars.length} invalid BSE record(s)`);
        }
        log.debug(`Fetched ${circulars.length} BSE circulars for ${params.get("strTxtDate")}..${params.get("strTxtTodate")}`);
        return circulars;
      } catch (error) {
        lastError = error;
        if (attempt < config.bse.maxRetries) {
          const backoff = config.bse.retryDelayMs * attempt;
          log.warn(`BSE fetch attempt ${attempt}/${config.bse.maxRetries} failed (${String(error)}); retrying in ${backoff}ms`);
          await sleep(backoff);
        }
      }
    }
    throw new Error(`BSE fetch failed after ${config.bse.maxRetries} attempts: ${String(lastError)}`);
  }
}

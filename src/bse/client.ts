import { chromium } from "playwright";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { BseCircular } from "../types.js";

const API_BASE = "https://api.bseindia.com/BseIndiaAPI/api/getDataAdvance_New/w";
const REFERER = "https://www.bseindia.com/markets/marketinfo/noticescirculars?id=0";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function fetchPayload(url: string): Promise<unknown> {
  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(REFERER, { waitUntil: "domcontentloaded", timeout: 30_000 });
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

function indiaDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

/** BSE's API expects calendar dates in YYYY-MM-DD format. */
export function formatBseDate(date: Date): string {
  const { year, month, day } = indiaDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Shift a date by calendar days in India, independent of the host timezone. */
export function bseDaysAgo(days: number, from = new Date()): Date {
  const { year, month, day } = indiaDateParts(from);
  return new Date(Date.UTC(year, month - 1, day - days, 12));
}

function asText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function normalizeCircular(value: unknown): BseCircular | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const noticeNo = asText(record["Notice_No"]);
  const subject = asText(record["Subject"]);
  if (!noticeNo || !subject) return null;

  const fileName = asText(record["FileName"]);
  if (fileName) {
    try {
      const url = new URL(fileName);
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    } catch {
      return null;
    }
  }

  return {
    noticeNo,
    noticeDate: asText(record["Notice_Date"]),
    subject,
    fileName,
    payload: JSON.stringify(record),
  };
}

export class BseClient {
  async fetchCirculars(fromDate: Date, toDate: Date): Promise<BseCircular[]> {
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

    const url = `${API_BASE}?${params.toString()}`;
    let lastError: unknown;
        
    for (let attempt = 1; attempt <= config.bse.maxRetries; attempt++) {
      try {
        const payload = await fetchPayload(url);
        if (typeof payload !== "object" || payload === null) {
          throw new Error("BSE response had no `Table` array");
        }

        const table = (payload as { Table?: unknown }).Table;
        if (table === null) {
          log.info(`BSE returned no circulars for ${formatBseDate(fromDate)}..${formatBseDate(toDate)}`);
          return [];
        }
        if (!Array.isArray(table)) throw new Error("BSE response had no `Table` array");

        const records = table;
        const circulars = records
          .map(normalizeCircular)
          .filter((circular): circular is BseCircular => circular !== null);
        if (circulars.length !== records.length) {
          log.warn(`BSE dropped ${records.length - circulars.length} invalid circular record(s)`);
        }
        log.info(
          `Fetched ${circulars.length} BSE ${config.bse.segment} circulars for ${formatBseDate(fromDate)}..${formatBseDate(toDate)}`,
        );
        return circulars;
      } catch (error) {
        lastError = error;
        if (attempt < config.bse.maxRetries) {
          const backoff = config.bse.retryDelayMs * attempt;
          log.warn(
            `BSE fetch attempt ${attempt}/${config.bse.maxRetries} failed (${String(error)}); retrying in ${backoff}ms`,
          );
          await sleep(backoff);
        }
      }
    }

    throw new Error(`BSE fetch failed after ${config.bse.maxRetries} attempts: ${String(lastError)}`);
  }
}
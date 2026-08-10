import { config } from "../config.js";
import { log } from "../logger.js";
import type { NseCircular } from "../types.js";
import { NseSession } from "./session.js";

const API_BASE = "https://www.nseindia.com/api/circulars";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** NSE's date parameters use DD-MM-YYYY. */
export function formatNseDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
}

export function daysAgo(days: number, from = new Date()): Date {
  const out = new Date(from);
  out.setDate(out.getDate() - days);
  return out;
}

function isCircular(value: unknown): value is NseCircular {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record["circDisplayNo"] === "string" && typeof record["sub"] === "string";
}

export class NseClient {
  private readonly session = new NseSession();

  /**
   * Fetches circulars for a date window, inclusive. Retries with a fresh session
   * on the transient failures NSE actually produces: 401/403 when cookies go
   * stale, 5xx under load, and HTML error pages served with a 200.
   */
  async fetchCirculars(fromDate: Date, toDate: Date, dept = config.nse.dept): Promise<NseCircular[]> {
    const params = new URLSearchParams({
      fromDate: formatNseDate(fromDate),
      toDate: formatNseDate(toDate),
      dept,
    });
    const url = `${API_BASE}?${params.toString()}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= config.nse.maxRetries; attempt++) {
      try {
        const response = await this.session.apiGet(url);

        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          await response.arrayBuffer();
          throw new Error(`NSE returned HTTP ${response.status}`);
        }
        if (!response.ok) {
          const body = (await response.text()).slice(0, 300);
          throw new Error(`NSE returned HTTP ${response.status}: ${body}`);
        }

        const text = await response.text();
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          // A challenge/error page served as 200 — the cookies are no longer good.
          throw new Error(`NSE returned non-JSON body (${text.slice(0, 120)})`);
        }

        const data = (payload as { data?: unknown }).data;
        if (!Array.isArray(data)) {
          throw new Error("NSE response had no `data` array");
        }

        const circulars = data.filter(isCircular);
        if (circulars.length !== data.length) {
          log.warn(`Dropped ${data.length - circulars.length} malformed circular records`);
        }
        log.debug(
          `Fetched ${circulars.length} circulars for ${params.get("fromDate")}..${params.get("toDate")} dept=${dept}`,
        );
        return circulars;
      } catch (error) {
        lastError = error;
        this.session.invalidate();
        if (attempt < config.nse.maxRetries) {
          const backoff = config.nse.retryDelayMs * attempt;
          log.warn(
            `NSE fetch attempt ${attempt}/${config.nse.maxRetries} failed (${String(error)}); retrying in ${backoff}ms`,
          );
          await sleep(backoff);
        }
      }
    }

    throw new Error(`NSE fetch failed after ${config.nse.maxRetries} attempts: ${String(lastError)}`);
  }
}

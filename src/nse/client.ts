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

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface NormalizedCircular {
  circular: NseCircular;
  /** True when we derived `circDisplayNo` because NSE did not supply one. */
  synthesizedId: boolean;
}

/**
 * NSE occasionally serves a botched record: nulls where strings belong
 * (`fileExt`, `fileDept`) and an empty `circDisplayNo`. The circular itself is
 * real — it has a subject and a number — so we coerce rather than drop, because
 * dropping means never alerting on it.
 *
 * Two things must not escape this function: a null (nothing downstream expects
 * one, and the DB columns are typed `string`), and an empty display number
 * (it is the primary key, so every malformed record would collide on "" and be
 * silently swallowed as a duplicate).
 */
function normalizeCircular(value: unknown, dept: string): NormalizedCircular | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  const sub = asText(record["sub"]);
  const displayNo = asText(record["circDisplayNo"]);
  const circNumber = asText(record["circNumber"]);
  // No subject means nothing to classify; no identity at all means nothing to
  // store against. Either way the record is unusable.
  if (sub === "" || (displayNo === "" && circNumber === "")) return null;

  const fileDept = asText(record["fileDept"]);

  return {
    synthesizedId: displayNo === "",
    circular: {
      cirDate: asText(record["cirDate"]),
      cirDisplayDate: asText(record["cirDisplayDate"]),
      circCategory: asText(record["circCategory"]),
      circCompany: asText(record["circCompany"]),
      circDepartment: asText(record["circDepartment"]),
      circDisplayNo: displayNo || `NSE/${fileDept || dept}/${circNumber}`,
      circFileSize: asText(record["circFileSize"]),
      circFilelink: asText(record["circFilelink"]),
      circFilename: asText(record["circFilename"]),
      circNumber,
      fileDept,
      fileExt: asText(record["fileExt"]),
      sub,
    },
  };
}

/**
 * NSE has been observed serving the same circular twice in one response: once
 * botched and once correct. The two copies carry different display numbers
 * (the synthesized one cannot reproduce NSE's `fileDept` segment), so they
 * would be stored as two circulars and emailed twice. Match them on the
 * circular number instead and keep the copy NSE actually identified.
 */
function selectCirculars(data: unknown[], dept: string): NseCircular[] {
  const normalized = data
    .map((entry) => normalizeCircular(entry, dept))
    .filter((entry): entry is NormalizedCircular => entry !== null);

  const identified = new Set(
    normalized.filter((entry) => !entry.synthesizedId).map((entry) => entry.circular.circNumber),
  );

  return normalized
    .filter((entry) => !entry.synthesizedId || !identified.has(entry.circular.circNumber))
    .map((entry) => entry.circular);
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
     console.log(`Fetching NSE circulars for =====================>${url}`);
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

        const circulars = selectCirculars(data, dept);
        if (circulars.length !== data.length) {
          log.warn(
            `Dropped ${data.length - circulars.length} unusable or duplicated circular record(s)`,
          );
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

import { config } from "../config.js";
import { log } from "../logger.js";

const REFERER = "https://www.nseindia.com/resources/exchange-communication-circulars";

/**
 * NSE rejects API calls that don't carry the cookies its edge (Akamai) hands out
 * to a browser. Hitting the circulars page first is enough to collect them — the
 * bare homepage 403s, so don't use that as the bootstrap.
 *
 * Cookies expire, so the session is refreshed on demand rather than cached for
 * the lifetime of the process.
 */
export class NseSession {
  private cookies = new Map<string, string>();
  private establishedAt = 0;
  /** Cookies stop working well before this; treated as an upper bound only. */
  private readonly maxAgeMs = 10 * 60 * 1000;

  private absorbCookies(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0];
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private browserHeaders(): Record<string, string> {
    return {
      "user-agent": config.nse.userAgent,
      "accept-language": "en-US,en;q=0.9",
      "sec-ch-ua": '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    };
  }

  private isStale(): boolean {
    return this.cookies.size === 0 || Date.now() - this.establishedAt > this.maxAgeMs;
  }

  /** Fetches the circulars page to (re)collect edge cookies. */
  async establish(force = false): Promise<void> {
    if (!force && !this.isStale()) return;

    log.debug("Establishing NSE session");
    this.cookies.clear();

    const response = await fetch(REFERER, {
      headers: {
        ...this.browserHeaders(),
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
      },
    });

    this.absorbCookies(response);
    // Read and discard the body so the connection is released promptly.
    await response.arrayBuffer();

    if (!response.ok) {
      throw new Error(`NSE session bootstrap failed: HTTP ${response.status}`);
    }
    if (this.cookies.size === 0) {
      throw new Error("NSE session bootstrap returned no cookies");
    }

    this.establishedAt = Date.now();
    log.debug(`NSE session established with ${this.cookies.size} cookies`);
  }

  /** Performs an authenticated XHR-style GET against an NSE API endpoint. */
  async apiGet(url: string): Promise<Response> {
    await this.establish();
    const response = await fetch(url, {
      headers: {
        ...this.browserHeaders(),
        accept: "*/*",
        referer: REFERER,
        cookie: this.cookieHeader(),
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        priority: "u=1, i",
      },
    });
    this.absorbCookies(response);
    return response;
  }

  /** Drops the current cookies so the next call re-bootstraps. */
  invalidate(): void {
    this.cookies.clear();
    this.establishedAt = 0;
  }
}

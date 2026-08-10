import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { Classification, ImportanceLevel, NseCircular } from "../types.js";

const SYSTEM_PROMPT = `You classify NSE (National Stock Exchange of India) circulars issued by the Mutual Fund department, for an operations and compliance team that runs a mutual fund distribution platform integrated with NSE MF Invest.

Judge only how much the circular demands attention or action from that team. You are given the circular's subject line, which is all the exchange publishes in the listing.

CRITICAL — the team must act, or be aware, before a specific date or the platform breaks or misbehaves:
- Platform downtime, unavailability, outages, maintenance windows
- Cut-off time changes, settlement or payout schedule changes
- Suspension of subscriptions/redemptions in schemes the platform transacts in
- Mandatory technical changes with a deadline: file format changes, API changes, forced migrations, go-lives
- Mock sessions or disaster-recovery drills requiring participation
- Enforcement, penalties, or fraud advisories

IMPORTANT — the team should read it this week, but nothing breaks today:
- Non-business days for specific schemes or AMCs
- SEBI/AMFI regulatory changes affecting operations
- New optional features, process revisions, revised reporting formats
- Changes to scheme attributes the platform displays or transacts on

ROUTINE — informational; no action:
- New Fund Offer (NFO) launches and scheme availability announcements
- Name/address changes, empanelment notices, routine sub-option introductions
- Anything purely promotional or catalogue-like

Bias toward ROUTINE when the subject is a plain NFO or scheme-availability notice, and toward CRITICAL when a date-bound operational impact is stated or clearly implied.`;

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    level: {
      type: "string",
      enum: ["CRITICAL", "IMPORTANT", "ROUTINE"],
      description: "Importance level for the operations team.",
    },
    reason: {
      type: "string",
      description: "One sentence explaining the classification, referencing the subject line.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description:
        "Short uppercase tags, e.g. DOWNTIME, SUSPENSION, CUTOFF_CHANGE, NON_BUSINESS_DAY, REGULATORY, RELEASE, ROUTINE_NFO.",
    },
  },
  required: ["level", "reason", "tags"],
  additionalProperties: false,
};

interface LlmVerdict {
  level: ImportanceLevel;
  reason: string;
  tags: string[];
}

/** Score assigned to an LLM verdict so downstream code has a comparable number. */
function scoreForLevel(level: ImportanceLevel): number {
  if (level === "CRITICAL") return config.classify.criticalThreshold;
  if (level === "IMPORTANT") return config.classify.importantThreshold;
  return 0;
}

export class LlmClassifier {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /** True when an API key is configured and the fallback can be used. */
  static isAvailable(): boolean {
    return config.classify.anthropicApiKey.length > 0;
  }

  /**
   * Classifies one circular. Returns null on any API failure so the caller can
   * keep the deterministic rule verdict — a classifier outage must never stop
   * the tracker from recording circulars.
   */
  async classify(circular: NseCircular): Promise<Classification | null> {
    try {
      const response = await this.client.messages.create({
        model: config.classify.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        // Low effort keeps this cheap and fast; thinking stays on (its default on
        // Opus 5), which avoids the failure modes of disabling it outright.
        output_config: {
          effort: "low",
          format: { type: "json_schema", schema: RESULT_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              `Circular number: ${circular.circDisplayNo}`,
              `Date: ${circular.cirDisplayDate}`,
              `Category: ${circular.circCategory}`,
              `Subject: ${circular.sub}`,
            ].join("\n"),
          },
        ],
      });

      if (response.stop_reason === "refusal") {
        log.warn(`Claude refused to classify ${circular.circDisplayNo}; keeping rule verdict`);
        return null;
      }

      const text = response.content.find((block) => block.type === "text");
      if (!text || text.type !== "text") {
        log.warn(`Claude returned no text block for ${circular.circDisplayNo}`);
        return null;
      }

      const verdict = JSON.parse(text.text) as LlmVerdict;
      if (!["CRITICAL", "IMPORTANT", "ROUTINE"].includes(verdict.level)) {
        log.warn(`Claude returned unknown level ${verdict.level} for ${circular.circDisplayNo}`);
        return null;
      }

      return {
        level: verdict.level,
        score: scoreForLevel(verdict.level),
        reasons: [verdict.reason],
        classifier: "llm",
        tags: Array.isArray(verdict.tags) ? verdict.tags : [],
      };
    } catch (error) {
      log.warn(`LLM classification failed for ${circular.circDisplayNo}: ${String(error)}`);
      return null;
    }
  }
}

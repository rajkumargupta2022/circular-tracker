import { config } from "../config.js";
import type { Classification, ImportanceLevel, NseCircular } from "../types.js";

export interface Rule {
  /** Machine-readable tag attached to a matching circular. */
  tag: string;
  /** Added to the circular's score when any pattern matches. Counted once per rule. */
  weight: number;
  /** Shown to stakeholders in the alert email. */
  label: string;
  patterns: RegExp[];
}

/**
 * Tunable scoring rules over the circular subject line — the only text NSE gives
 * us without downloading the attachment.
 *
 * Weights are additive and a rule contributes at most once, so a circular about
 * a platform outage on a non-business day scores higher than either alone.
 * Negative rules exist because the MF feed is dominated by routine NFO launches;
 * without them, "Launch of X Fund NFO" drifts upward on incidental matches.
 */
export const RULES: Rule[] = [
  {
    tag: "DOWNTIME",
    weight: 6,
    label: "Platform downtime or unavailability",
    patterns: [
      /\bdown\s?time\b/i,
      /\bunavailab/i,
      /\bnon[-\s]?availability\b/i,
      /\bnot\s+be\s+available\b/i,
      /\bshut\s?down\b/i,
      /\boutage\b/i,
      /\bmaintenance\s+(activity|window|activities)\b/i,
      /\bsystem\s+(upgrade|maintenance)\b/i,
      /\bdisruption\b/i,
    ],
  },
  {
    tag: "SUSPENSION",
    weight: 5,
    label: "Suspension, discontinuation or withdrawal",
    patterns: [
      /\bsuspen(sion|ded|ding)\b/i,
      /\bdiscontinu/i,
      /\bcessation\b/i,
      /\bwithdrawal\s+of\b/i,
      /\bde[-\s]?activat/i,
      /\bfreez(e|ing)\b/i,
      /\bhalt(ed|ing)?\b/i,
    ],
  },
  {
    tag: "NON_BUSINESS_DAY",
    weight: 4,
    label: "Non-business day / holiday schedule",
    patterns: [/\bnon[-\s]?business\s+day\b/i, /\btrading\s+holiday\b/i, /\bholiday\s+(list|calendar)\b/i],
  },
  {
    tag: "CUTOFF_CHANGE",
    weight: 5,
    label: "Cut-off time or timing change",
    patterns: [
      /\bcut[-\s]?off\b/i,
      /\brevised\s+timing/i,
      /\bchange\s+in\s+timing/i,
      /\btiming[s]?\s+(change|revision|revised)/i,
      /\bextension\s+of\s+(time|timing|market)/i,
    ],
  },
  {
    tag: "MANDATORY",
    weight: 4,
    label: "Mandatory or compliance-driven change",
    patterns: [
      /\bmandator/i,
      /\bwith\s+immediate\s+effect\b/i,
      /\beffective\s+from\b/i,
      /\bcompulsor/i,
      /\bmust\s+be\b/i,
      /\bshall\s+be\s+required\b/i,
    ],
  },
  {
    tag: "REGULATORY",
    weight: 3,
    label: "SEBI / regulatory directive",
    patterns: [/\bSEBI\b/, /\bregulator/i, /\bcircular\s+supersed/i, /\bAMFI\b/, /\bRBI\b/],
  },
  {
    tag: "MOCK_DR",
    weight: 4,
    label: "Mock session or disaster-recovery drill",
    patterns: [
      /\bmock\s+(session|trading|test)/i,
      /\bdisaster\s+recovery\b/i,
      /\bDR\s+(site|drill)\b/,
      /\blive\s+trading\s+session\s+on\b/i,
      /\bcontingenc/i,
    ],
  },
  {
    tag: "RELEASE",
    weight: 3,
    label: "Software release, migration or go-live",
    patterns: [
      /\bgo[-\s]?live\b/i,
      /\bmigrat/i,
      /\bnew\s+version\b/i,
      /\brelease\s+of\s+(version|build)/i,
      /\bUAT\b/,
      /\bAPI\s+(change|version|deprecat)/i,
      /\bfile\s+format\s+(change|revision)/i,
    ],
  },
  {
    tag: "PENAL",
    weight: 5,
    label: "Penalty, enforcement or fraud advisory",
    patterns: [/\bpenalt/i, /\bfraud/i, /\benforcement\b/i, /\bdisciplinary\b/i, /\bnon[-\s]?compliance\b/i],
  },
  {
    tag: "SETTLEMENT",
    weight: 3,
    label: "Settlement, payout or funds movement change",
    patterns: [
      /\bsettlement\s+(cycle|schedule|change)/i,
      /\bpay[-\s]?(in|out)\b/i,
      /\bfunds?\s+transfer\b/i,
      /\bredemption\s+(delay|restriction)/i,
    ],
  },
  {
    tag: "ROUTINE_NFO",
    weight: -3,
    label: "Routine NFO / scheme availability notice",
    patterns: [
      /\blaunch\s+of\b.*\bNFO\b/i,
      /\bavailability\s+of\b.*\bNFO\b/i,
      /\bnew\s+fund\s+offer\b/i,
      /\bNFO\s+(on|under)\s+NSE\s+MF\s+Invest/i,
    ],
  },
  {
    tag: "ROUTINE_ADMIN",
    weight: -2,
    label: "Routine administrative notice",
    patterns: [
      /\bchange\s+in\s+(name|address)\s+of\b/i,
      /\bempanelment\b/i,
      /\bintroduction\s+of\s+(payout\s+)?sub[-\s]?option/i,
    ],
  },
];

export function levelForScore(score: number): ImportanceLevel {
  if (score >= config.classify.criticalThreshold) return "CRITICAL";
  if (score >= config.classify.importantThreshold) return "IMPORTANT";
  return "ROUTINE";
}

/**
 * Scores a circular against the keyword rules. Deterministic, free, and the
 * only classifier that runs when no Gemini API key is configured.
 */
export function classifyByRules(circular: NseCircular): Classification {
  const text = `${circular.sub} ${circular.circCategory}`;
  let score = 0;
  const reasons: string[] = [];
  const tags: string[] = [];

  for (const rule of RULES) {
    const hit = rule.patterns.find((pattern) => pattern.test(text));
    if (!hit) continue;
    score += rule.weight;
    tags.push(rule.tag);
    const sign = rule.weight >= 0 ? "+" : "";
    reasons.push(`${rule.label} (${sign}${rule.weight})`);
  }

  if (reasons.length === 0) reasons.push("No scoring keywords matched");

  return { level: levelForScore(score), score, reasons, classifier: "rules", tags };
}

/** True when the rule score is too close to the line to trust on its own. */
export function isAmbiguous(score: number): boolean {
  return score >= config.classify.llmBandMin && score <= config.classify.llmBandMax;
}

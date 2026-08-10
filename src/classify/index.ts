import { config } from "../config.js";
import { log } from "../logger.js";
import type { Classification, NseCircular } from "../types.js";
import { GeminiClassifier } from "./llm.js";
import { classifyByRules, isAmbiguous } from "./rules.js";

export { RULES, classifyByRules, levelForScore } from "./rules.js";

/**
 * Rules first, Gemini only for the ambiguous middle band.
 *
 * The rule pass is deterministic and free, so it decides the clear cases: a
 * strongly negative score is a routine NFO notice, a strongly positive one is a
 * genuine operational change. Only scores inside the configured band — where a
 * single keyword tipped the balance — are worth an API call.
 */
export class Classifier {
  private readonly llm: GeminiClassifier | null;

  constructor() {
    this.llm = GeminiClassifier.isAvailable()
      ? new GeminiClassifier(config.classify.geminiApiKey)
      : null;
    if (!this.llm) {
      log.debug("GEMINI_API_KEY not set — running on keyword rules only");
    }
  }

  async classify(circular: NseCircular): Promise<Classification> {
    const ruleVerdict = classifyByRules(circular);

    if (!this.llm || !isAmbiguous(ruleVerdict.score)) {
      return ruleVerdict;
    }

    log.debug(
      `Rule score ${ruleVerdict.score} is ambiguous for ${circular.circDisplayNo}; asking Gemini`,
    );
    const llmVerdict = await this.llm.classify(circular);
    if (!llmVerdict) return ruleVerdict;

    return {
      ...llmVerdict,
      // Keep the rule evidence alongside the model's rationale so a reviewer can
      // see why the circular was escalated to the LLM in the first place.
      reasons: [...llmVerdict.reasons, `Rule score was ${ruleVerdict.score} (ambiguous)`],
      tags: [...new Set([...llmVerdict.tags, ...ruleVerdict.tags])],
    };
  }

  /** Classifies a batch with bounded concurrency so NSE-sized runs stay quick. */
  async classifyAll(circulars: NseCircular[], concurrency = 4): Promise<Map<string, Classification>> {
    const results = new Map<string, Classification>();
    const queue = [...circulars];

    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        results.set(next.circDisplayNo, await this.classify(next));
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, circulars.length) }, worker));
    return results;
  }
}

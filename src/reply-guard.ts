import { z } from 'zod';

const semanticFactSchema = z.object({
  kind: z.enum(['price', 'price_basis', 'service', 'length', 'customer_type', 'general_hours', 'booking_time', 'booking_url', 'requires_harris', 'booking_status', 'menu', 'address', 'other']),
  service: z.string().min(1).max(100).nullable(), length: z.string().min(1).max(100).nullable(),
  audience: z.string().min(1).max(100).nullable(), value: z.string().min(1).max(1000),
  polarity: z.enum(['affirmed', 'negated', 'uncertain']),
}).strict();
const evidence = z.string().min(1).max(2000);
export const verificationSchema = z.object({
  verdict: z.enum(['supported', 'unsupported', 'uncertain']), complete: z.boolean(),
  facts: z.array(semanticFactSchema.extend({ evidence }).strict()).max(30),
  questions: z.array(z.object({ slot: z.string().min(1).max(100), evidence }).strict()).max(10),
  actions: z.array(z.object({ kind: z.string().min(1).max(100), mode: z.enum(['done', 'promised', 'capability', 'uncertain']), evidence }).strict()).max(10),
  persona: z.enum(['assistant', 'unspecified', 'harris', 'uncertain']),
  issues: z.array(z.string().min(1).max(500)).max(20),
}).strict();

export type SemanticFact = z.infer<typeof semanticFactSchema>;
export type SemanticReview = z.infer<typeof verificationSchema>;
export interface NaturalContract {
  topic: string;
  atoms: Record<string, string>;
  requiredAtoms: string[];
  allowedFacts: SemanticFact[];
  requiredFacts: SemanticFact[];
  allowedQuestions: string[];
  requiredQuestions: string[];
}
export interface VerificationInput {
  candidate: string;
  contract: NaturalContract;
  text: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  signal?: AbortSignal;
}

const segments = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}/u;
const hiddenControl = (value: string): boolean => /[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t\r]/gu, ''));
const keyPattern = /^[a-z][a-z0-9_]{0,39}$/u;
const containsUrl = /https?:\/\/|www\.|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/\S*)?/iu;
const chineseMoney = /[零〇一二兩两三四五六七八九十百千萬万億亿]+\s*(?:元|圓|圆|塊|块|折|成)/u;

/** Only mechanical constraints live here. Arbitrary natural words, sentence
 * order, questions and thanks are NOT checked against a phrase allowlist.
 * A non-null result is a candidate, never permission to send it without review.
 */
export function renderAtomicReply(draft: string, contract: NaturalContract): string | null {
  try {
    if (typeof draft !== 'string' || !draft.trim() || draft.length > 1200 || hiddenControl(draft)) return null;
    const atomKeys = Object.keys(contract.atoms);
    if (atomKeys.length > 30 || atomKeys.some(key => !keyPattern.test(key))) return null;
    if (new Set(contract.requiredAtoms).size !== contract.requiredAtoms.length
      || contract.requiredAtoms.some(key => !keyPattern.test(key) || !Object.hasOwn(contract.atoms, key))) return null;
    const counts = new Map<string, number>();
    let valid = true;
    const candidate = draft.replace(/\{\{([^{}]*)\}\}/gu, (_match, key: string) => {
      if (!keyPattern.test(key) || !Object.hasOwn(contract.atoms, key)) { valid = false; return ''; }
      const atom = contract.atoms[key];
      if (typeof atom !== 'string' || !atom.trim() || atom.length > 500 || hiddenControl(atom) || /[{}<>`]/u.test(atom.normalize('NFKC'))) { valid = false; return ''; }
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return atom;
    });
    const literal = draft.replace(/\{\{[^{}]*\}\}/gu, '').normalize('NFKC');
    if (!valid || /[{}<>`]/u.test(literal) || /[{}]/u.test(candidate.normalize('NFKC'))) return null;
    if (contract.requiredAtoms.some(key => counts.get(key) !== 1) || [...counts.values()].some(count => count !== 1)) return null;
    // New numeric values or links cannot be smuggled around approved atoms.
    // This is an extra mechanical layer, not a semantic safety decision.
    if (/\p{N}/u.test(literal) || containsUrl.test(literal) || chineseMoney.test(literal)) return null;
    if (!candidate.trim() || candidate.length > 2000 || hiddenControl(candidate)) return null;
    const faces = [...segments.segment(candidate)].filter(part => emoji.test(part.segment));
    if (faces.length > 1 || faces.some(part => part.segment !== '😊')) return null;
    return candidate;
  } catch { return null; }
}

function normalizePrice(value: string): string | null {
  return /^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(value) ? value.replace(/,/g, '') : null;
}
function canonicalFact(value: unknown): string | null {
  const parsed = semanticFactSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind === 'other') return null;
  const fact = parsed.data;
  let normalized = fact.value;
  if (fact.kind === 'price') {
    // The binding includes the role, service and length: two individually valid
    // amounts do not become valid if a review swaps new/member labels.
    const amount = normalizePrice(normalized);
    if (!amount) return null;
    normalized = amount;
  }
  return JSON.stringify([fact.kind, fact.service, fact.length, fact.audience, normalized, fact.polarity]);
}
function hasEvidence(candidate: string, value: string): boolean {
  // Presence can be checked mechanically; complete semantic extraction cannot
  // be proven by this check. Requiring words also rejects a price-only snippet.
  return !!value.trim() && /\p{L}/u.test(value) && candidate.includes(value);
}

/** Checks a separately produced structured semantic extraction. The verifier's
 * supported/complete verdict alone is insufficient. This does not prove that
 * a real model extracted every claim correctly; that remains an explicit risk.
 */
export function checkSemanticReview(candidate: string, contract: NaturalContract, review: unknown): boolean {
  try {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 2000 || hiddenControl(candidate) || /[{}]/u.test(candidate)) return false;
    const parsed = verificationSchema.safeParse(review);
    if (!parsed.success) return false;
    const result = parsed.data;
    if (result.verdict !== 'supported' || !result.complete || result.issues.length || result.actions.length
      || result.persona === 'harris' || result.persona === 'uncertain') return false;
    const allowed = new Set<string>();
    for (const fact of contract.allowedFacts) {
      const canonical = canonicalFact(fact);
      if (!canonical) return false;
      allowed.add(canonical);
    }
    const required = contract.requiredFacts.map(canonicalFact);
    if (required.some(fact => !fact || !allowed.has(fact))) return false;
    const observed = new Set<string>();
    for (const fact of result.facts) {
      // Strip only evidence before strict canonical parsing; no model-provided
      // free-form metadata is permitted to amend the approved fact tuple.
      const { evidence: proof, ...content } = fact;
      const canonical = canonicalFact(content);
      if (!canonical || !allowed.has(canonical) || !hasEvidence(candidate, proof)) return false;
      if (content.kind === 'price') {
        const amount = normalizePrice(content.value);
        const evidenceAmounts = [...proof.normalize('NFKC').matchAll(/\d(?:[\d,.]*\d)?/g)].map(match => normalizePrice(match[0]));
        if (!amount || !evidenceAmounts.includes(amount)) return false;
      }
      observed.add(canonical);
    }
    if (required.some(fact => !observed.has(fact!))) return false;
    const questions = new Set(contract.allowedQuestions);
    if (questions.size !== contract.allowedQuestions.length || new Set(contract.requiredQuestions).size !== contract.requiredQuestions.length
      || contract.requiredQuestions.some(slot => !questions.has(slot))) return false;
    const asked = new Set<string>();
    for (const question of result.questions) {
      if (!questions.has(question.slot) || !hasEvidence(candidate, question.evidence)) return false;
      asked.add(question.slot);
    }
    return contract.requiredQuestions.every(slot => asked.has(slot));
  } catch { return false; }
}

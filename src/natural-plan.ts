import type { AiInput } from './types.js';
import type { SalonFacts } from './knowledge.js';
import type { DialoguePlan } from './policy.js';
import { resolveDialogueContext } from './dialogue-context.js';
import type { NaturalContract, SemanticFact } from './reply-guard.js';

const fact = (kind: SemanticFact['kind'], value: string): SemanticFact => ({ kind, value, service: null, length: null, audience: null, polarity: 'affirmed' });
export function buildNaturalContract(plan: DialoguePlan, text: string, facts: SalonFacts, history: AiInput['history'], bookingUrl: string): NaturalContract | null {
  if (plan.topic === 'handoff' || plan.topic === 'faq') return null;
  const c: NaturalContract = { topic: plan.topic, atoms: {}, requiredAtoms: [], allowedFacts: [], requiredFacts: [], allowedQuestions: [], requiredQuestions: [] };
  const context = resolveDialogueContext(text, history);
  const allow = (item: SemanticFact, required = false) => { c.allowedFacts.push(item); if (required) c.requiredFacts.push(item); };
  const atom = (key: string, value: string) => { c.atoms[key] = value; c.requiredAtoms.push(key); };
  const contextFacts = () => {
    if (context.service) allow(fact('service', context.service));
    if (context.length) allow(fact('length', context.length));
    if (context.customerType) allow(fact('customer_type', context.customerType));
  };
  const prices = (): boolean => {
    if (!facts.approved || !context.service) return false;
    const price = (key: string, value: number, audience: string | null, length: string | null) => {
      atom(key, value.toLocaleString('en-US'));
      allow({ kind: 'price', service: context.service, length, audience, value: String(value), polarity: 'affirmed' }, true);
    };
    if (context.service === '剪髮') {
      if (!facts.haircutPrice) return false;
      price('price', facts.haircutPrice, null, null);
      allow(fact('price_basis', 'fixed_haircut'));
      return true;
    }
    const row = facts.priceTable?.find(item => item.service === context.service && item.length === context.length);
    if (!row) return false;
    if (context.customerType !== 'member') price('price_new', row.newCustomer, 'new', row.length);
    if (context.customerType !== 'new') price('price_member', row.member, 'member', row.length);
    allow(fact('price_basis', 'already_discounted'));
    return true;
  };
  switch (plan.topic) {
    case 'greeting': c.allowedQuestions = ['help_topic', 'service']; break;
    case 'thanks': break;
    case 'price': contextFacts(); if (!prices()) return null; break;
    case 'clarify':
      contextFacts(); c.allowedQuestions = [...plan.missing]; c.requiredQuestions = [...plan.missing]; break;
    case 'booking':
      contextFacts();
      if (plan.claims.quote && !prices()) return null;
      if (context.currentTime) { atom('requested_time', context.currentTime); allow(fact('booking_time', context.currentTime), true); }
      // The only complete-sentence atom is the explicitly approved safety
      // exception. Everyday price wording, questions and thanks stay free.
      atom('pending', plan.claims.pending!); allow(fact('requires_harris', 'booking'), true);
      c.allowedQuestions = [...plan.missing]; c.requiredQuestions = [...plan.missing];
      if (plan.claims.booking_link) { atom('booking_url', bookingUrl); allow(fact('booking_url', bookingUrl), true); }
      break;
    case 'self_reported':
      allow(fact('booking_status', 'self_reported_unverified'), true); allow(fact('requires_harris', 'booking'), true);
      if (plan.claims.booking_link) { atom('booking_url', bookingUrl); allow(fact('booking_url', bookingUrl), true); }
      break;
    case 'booking_link': atom('booking_url', bookingUrl); allow(fact('booking_url', bookingUrl), true); break;
    case 'hours':
      if (!facts.approved || !facts.hours) return null;
      atom('hours', facts.hours); allow(fact('general_hours', facts.hours), true);
      if (plan.result.needsHuman) allow(fact('requires_harris', 'opening_date'), true);
      break;
    case 'address':
      if (!facts.approved || !facts.address) return null;
      atom('address', facts.address); allow(fact('address', facts.address), true); break;
    case 'menu':
      allow(fact('menu', 'line_rich_menu_price_table'), true); allow(fact('price_basis', 'already_discounted')); break;
    case 'services':
      for (const item of facts.services) allow(fact('service', item.name), true);
      break;
    default: return null;
  }
  return c;
}

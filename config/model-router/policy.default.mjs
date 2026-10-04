// Per-user reviewed allocation: correctness first, subscription allowance second, completion time third.
// Free-text classification is a conservative heuristic, not an optimality or uncertainty detector.
// Structured taskFacts describe the caller's assessment; missing information/environment trouble alone
// never imply difficult reasoning. Claude keeps its separately reviewed three-class policy.
const CODING = /\b(implement|implementation|code|coding|debug|refactor|test|endpoint|API|repository|module|function)\b/i;
const HARD = /cryptograph|consensus|race condition|irreversible|final review|independent review|difficult planning|complex architecture|security audit|security vulnerability|unresolved architectur|production incident|prove correctness/i;
const MECHANICAL = /\b(summari[sz]e|classify|extract|translate|rephrase|format|typo)\b/i;

export function validateTaskFacts(facts) {
  if (facts === undefined) return undefined;
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) throw new Error('taskFacts must be an object');
  const keys = new Set(['taskType','scope','uncertainty','consequentialPlanning','finalSubstantiveReview','exceptionalReason']);
  if (Object.keys(facts).some((key) => !keys.has(key))) throw new Error('Unknown taskFacts field');
  if (facts.taskType !== undefined && !['mechanical','coding','research','planning','review'].includes(facts.taskType)) throw new Error('Invalid taskFacts taskType');
  if (facts.scope !== undefined && !['routine','substantial'].includes(facts.scope)) throw new Error('Invalid taskFacts scope');
  if (facts.uncertainty !== undefined && !['none','architecture','coupled-implementation','missing-information','environment'].includes(facts.uncertainty)) throw new Error('Invalid taskFacts uncertainty');
  for (const key of ['consequentialPlanning','finalSubstantiveReview']) {
    if (facts[key] !== undefined && typeof facts[key] !== 'boolean') throw new Error(`taskFacts ${key} must be boolean`);
  }
  if (facts.exceptionalReason !== undefined && !/^[a-z][a-z0-9-]{2,79}$/.test(facts.exceptionalReason)) {
    throw new Error('exceptionalReason must be an explicit named reason slug (3-80 characters)');
  }
  return facts;
}

export function classify(features, harness = features.harness || 'codex') {
  const text = String(features.taskHints || '');
  const coding = features.hasCode || CODING.test(text);
  if (harness === 'claude-code') {
    return HARD.test(text) ? 'hard' : !coding && MECHANICAL.test(text) ? 'fast' : 'medium';
  }
  const consequential = /\b(consequential planning|substantive planning|substantive review|final substantive review|plan (?:a |the )?new system|design (?:a |the )?new architecture|ambiguous architecture|architecture ambiguity|architectur\w* tradeoff|tightly coupled uncertain implementation|uncertain tightly coupled implementation)\b/i.test(text);
  const architectureAmbiguity = /architectur\w*/i.test(text) && /\b(ambiguous|ambiguity|unresolved|uncertain|trade[- ]?off)\b/i.test(text);
  const coupledUncertainty = /tightly coupled/i.test(text) && /implementation|coding/i.test(text) && /uncertain|unresolved|ambiguous/i.test(text);
  const hardText = HARD.test(text) || consequential || architectureAmbiguity || coupledUncertainty;
  const substantialText = /\b(substantial (?:implementation|coding|feature|task)|cross-module (?:implementation|feature|refactor)|multi-file (?:implementation|feature|refactor)|end-to-end implementation|broad refactor)\b/i.test(text);
  const facts = validateTaskFacts(features.taskFacts);
  // Partial caller metadata supplements the assessment; it cannot lower explicit high-consequence text.
  if (facts?.exceptionalReason) return 'exceptional';
  if (hardText) return 'hard';
  if (facts && (['architecture','coupled-implementation'].includes(facts.uncertainty) ||
      facts.consequentialPlanning || facts.finalSubstantiveReview ||
      ((facts.scope === 'substantial' || substantialText) && ['planning','review'].includes(facts.taskType)))) return 'hard';
  if (facts?.scope === 'substantial' || substantialText) return 'substantial';
  // A mechanical flag cannot override clear implementation/code requirements in the task.
  return !coding && (facts?.taskType === 'mechanical' || MECHANICAL.test(text)) ? 'fast' : 'medium';

}

export function choose({ features, candidates, harness, profile, selection }) {
  const taskClass = classify(features, harness);
  const reviewed = selection?.routes?.[harness];
  const allocation = profile?.allocation?.[harness]?.[taskClass] || reviewed?.[taskClass];
  const model = typeof allocation === 'string' ? allocation : allocation?.model;
  let effort = typeof allocation === 'object' ? allocation.effort : reviewed?.[taskClass]?.effort;
  if (harness === 'claude-code' && taskClass === 'medium' && (features.hasCode || CODING.test(features.taskHints || ''))) {
    effort = profile?.allocation?.[harness]?.codingEffort || reviewed?.codingEffort || effort;
  }
  const pick = candidates.find((m) => m.id === model && (m.harness || []).includes(harness) && (m.subscription || []).includes(harness));
  return { model: pick?.id || null, provider: pick?.provider || null, tier: pick?.tier || null,
    taskClass, effort, exceptionalReason: taskClass === 'exceptional' ? features.taskFacts?.exceptionalReason : undefined,
    classificationSource: harness === 'codex' && features.taskFacts ? 'caller-task-facts' : 'free-text-heuristic', confidence: 0.5,
    reason: pick ? `task-fit allocation: ${taskClass}, ${effort} effort; native subscription only`
      : `requested qualified ${taskClass} native subscription route unavailable: ${model}; no medium or paid fallback` };
}

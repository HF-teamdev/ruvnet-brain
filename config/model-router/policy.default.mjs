// Native subscription allocation. Override with ~/.claude/model-router/policy.mjs.
// Task-fit heuristics are recommendations, not measured accuracy guarantees.
export function classify(features) {
  const text = String(features.taskHints || '');
  const hard = /cryptograph|consensus|race condition|irreversible|critical independent review|security audit|security vulnerability|unresolved architectur|production incident|prove correctness/i.test(text);
  // General coding stays on Sol even when a prompt includes "extract" or "format".
  const coding = features.hasCode || /\b(implement|code|coding|debug|refactor|test|endpoint|API|repository|module|function)\b/i.test(text);
  const fast = !hard && !coding && /\b(summari[sz]e|classify|extract|translate|rephrase|format|typo)\b/i.test(text);
  return hard ? 'hard' : fast ? 'fast' : 'medium';
}

export function choose({ features, candidates, harness, profile, selection }) {
  const taskClass = classify(features);
  const reviewed = selection?.routes?.[harness];
  const allocation = profile?.allocation?.[harness]?.[taskClass] || reviewed?.[taskClass];
  const model = typeof allocation === 'string' ? allocation : allocation?.model;
  let effort = typeof allocation === 'object' ? allocation.effort : reviewed?.[taskClass]?.effort;
  if (harness === 'claude-code' && taskClass === 'medium' &&
      (features.hasCode || /\b(implement|code|coding|debug|refactor|test|endpoint|API|repository|module|function)\b/i.test(features.taskHints || ''))) {
    effort = profile?.allocation?.[harness]?.codingEffort || reviewed?.codingEffort || effort;
  }
  const pick = candidates.find((m) => m.id === model && (m.harness || []).includes(harness) && (m.subscription || []).includes(harness));
  return { model: pick?.id || null, provider: pick?.provider || null, tier: pick?.tier || null,
    taskClass, effort, confidence: 0.5,
    reason: pick ? `task-fit allocation: ${taskClass}, ${effort} effort; native subscription only`
      : `requested native subscription model unavailable: ${model}; no paid fallback` };
}

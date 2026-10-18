import { describe, expect, it } from 'vitest';
import { CONTENT_BOUNDARY_RULE } from '../../apps/assistant/src/modules/calls/conversation/language-rule.js';
import { buildOwnerCallInstructions } from '../../apps/assistant/src/modules/calls/conversation/owner-call-tools.js';
import { buildContactCallInstructions } from '../../apps/assistant/src/modules/calls/conversation/contact-call-runner.js';
import { buildPrompt } from '../../apps/assistant/src/infrastructure/gemini/text.js';

describe('content boundary (no religion, no politically dangerous material)', () => {
  it('is part of the owner call, contact call and chat prompts', () => {
    const owner = buildOwnerCallInstructions({ now: new Date('2026-01-01T10:00:00Z'), timezone: 'Asia/Samarkand', tasks: [] });
    const contact = buildContactCallInstructions({ ownerName: 'Farruh', contactName: 'Akmal', brief: 'salom', forbidden: [], questions: [] });
    const chat = buildPrompt('salom', { receivedAt: new Date('2026-01-01T10:00:00Z'), timezone: 'Asia/Samarkand', locale: 'uz' });
    for (const p of [owner, contact, chat]) expect(p).toContain(CONTENT_BOUNDARY_RULE);
  });
});

describe('persona and daily greeting', () => {
  const base = { ownerName: 'Farruh', contactName: 'Akmal', brief: 'salom', forbidden: [], questions: [] };
  it('first call of the day introduces Madina once; later calls the same day skip the greeting', () => {
    const first = buildContactCallInstructions({ ...base, firstCallToday: true });
    const again = buildContactCallInstructions({ ...base, firstCallToday: false });
    expect(first).toContain('mening ismim Madina');
    expect(again).toContain('SALOM BERMA');
    expect(again).not.toContain('mening ismim Madina');
  });
  it('never claims to be human and does not announce recording', () => {
    const p = buildContactCallInstructions(base);
    expect(p).toContain('HALOLLIK');
    expect(p).not.toContain('qayta ishlanadi');
  });
});

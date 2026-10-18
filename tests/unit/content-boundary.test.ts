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

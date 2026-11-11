import type { Intent, InterpretContext } from '../../application/intent.js';
import type { TextInterpreterPort } from '../../application/ports.js';

/** TEXT_AI_ADAPTER=disabled: nothing is interpreted, so no text message can ever cause a mutation. */
export class DisabledInterpreter implements TextInterpreterPort {
  async interpret(_raw: string, _ctx: InterpretContext): Promise<Intent> {
    return { kind: 'unknown' };
  }
}

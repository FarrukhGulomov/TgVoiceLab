# ADR-0005: Deterministic rules interpreter now; LLM adapter later behind the same port

Status: Accepted · Date: 2026-10-15

OpenAI documentation was unreachable from the build sandbox and the spec forbids hardcoding an unverified model, so no OpenAI adapter was written. `RulesInterpreter`
(en/uz) implements `TextInterpreterPort`, returns only a closed set of _proposed_ intents (never "call"), and turns every ambiguity into a question
(bare hour 1–6 ⇒ ask; missing time ⇒ ask; unknown ⇒ unknown). Application code validates and executes. An LLM adapter must return the same `Intent` union and pass the
same language-evaluation suite. `TEXT_AI_ADAPTER=openai` aborts startup until implemented.

## Update 2026-10-18: Gemini fallback for unrecognised text

Rules still run first and win. Only text the rules answer with `unknown` (and no pending draft completes) goes to `GeminiTextFallback`
(`GEMINI_API_KEY` + `GEMINI_TEXT_MODEL`; nothing is defaulted). It sees the owner's active contact names and the latest call report (6 h), so
a short reply such as "roziman" can be tied to that call. It can only propose `create_task`, `create_reminder`, `call_contact`,
`list_tasks`, `list_reminders`, `clarify`; everything else is `unknown`. A proposed call is never placed from the model's guess: it becomes a
`confirm_call` draft (10 min) and rings only after a plain "ha"/"yes". Not live verified; the text leaves the machine, and on the free tier
Google may use it to improve its products.

## Update 2026-10-18 (2): conversational mode

The fallback may also answer with `reply` (no state change): greetings, questions, advice, and questions about the owner's own tasks, reminders,
recent call reports (7 days) and memory, which are passed to the model as read-only data. A reply never executes anything, never clears a
pending yes/no proposal, and the prompt forbids claiming an action was done. This sends those snippets to Gemini (free tier: may be used by
Google to improve its products).

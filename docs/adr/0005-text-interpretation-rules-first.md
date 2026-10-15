# ADR-0005: Deterministic rules interpreter now; LLM adapter later behind the same port

Status: Accepted · Date: 2026-10-15

OpenAI documentation was unreachable from the build sandbox and the spec forbids hardcoding an unverified model, so no OpenAI adapter was written. `RulesInterpreter`
(en/uz) implements `TextInterpreterPort`, returns only a closed set of _proposed_ intents (never "call"), and turns every ambiguity into a question
(bare hour 1–6 ⇒ ask; missing time ⇒ ask; unknown ⇒ unknown). Application code validates and executes. An LLM adapter must return the same `Intent` union and pass the
same language-evaluation suite. `TEXT_AI_ADAPTER=openai` aborts startup until implemented.

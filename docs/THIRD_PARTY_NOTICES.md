# Third-party notices

## ntgcalls (LGPL-3.0-only)

- What: the native addon that carries the audio of Telegram private calls (`ntgcalls@3.0.3`, with its platform binary, about 98 MB in the production image).
- Where it is used: `apps/assistant/src/infrastructure/telegram/ntgcalls-media.ts`, loaded when `CALL_ADAPTER=ntgcalls`. It is a production dependency of `apps/assistant`, so the production image contains it even while calling is disabled.
- How it is used: unmodified, as a separately loaded native addon behind the `MediaSession` interface. This project's own code is not linked statically into it.
- If you redistribute an image or archive that contains it you must: keep the LGPL-3.0 text and the package's own notices with it, state that it is included and where it comes from (https://github.com/pytgcalls/ntgcalls), and make it possible for the recipient to replace it with a modified version of the library. Obtain legal review before any redistribution; this file is an engineering note, not legal advice.
- Running the image only on your own machines is not redistribution.

## Other dependencies

MIT, Apache-2.0, BSD or ISC licensed (see `pnpm-lock.yaml` and each package). The archived GramJS package (`telegram`) is MIT; see the audit response for the maintenance risk.

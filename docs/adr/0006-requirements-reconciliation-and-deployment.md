# ADR-0006: Requirements reconciliation and deployment stance

Status: Accepted · Date: 2026-10-15

- **BRD:** the full Uzbek BRD from the source conversation (`6ace389b-a42c-83ed-923e-437e8ac14993`) was not available (the spec says so, and no BRD file exists in this repo).
  Nothing was inferred from it. When it is supplied, produce a requirements diff before changing behavior.
- **No PaaS assumption:** media needs UDP/relay egress, persistent session storage, long-running workers and native binaries. Target is a general Linux VPS with Docker Compose;
  verify any PaaS (e.g. Railway) against those needs _before_ choosing it (gate G0-F).
- **Production calling** stays off until the owner authorizes enablement after Phases 0/3/4/5 evidence exists.

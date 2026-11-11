# ADR-0003: Modular monolith, PostgreSQL as system of record and job queue

Status: Accepted · Date: 2026-10-15

Single deployable, modules communicating through typed services (no cross-module table access by convention). Jobs (`FOR UPDATE SKIP LOCKED`, expiring leases,
fencing tokens bumped on every claim, attempts counted at claim time so crash loops dead-letter) and the transactional outbox live in PostgreSQL; no Redis.
Reminder firing settles its job **last, inside the same transaction as its effects**, so a worker that lost its lease (reschedule/cancel/expiry) rolls back and cannot
double-fire. Injected `Clock` is used for every persisted timestamp that participates in a CHECK or due-time comparison (two real bugs came from DB `now()` ignoring it).
Add Redis only through a new ADR with measured need.

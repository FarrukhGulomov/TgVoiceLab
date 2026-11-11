/** Domain errors carry a stable machine code; the HTTP layer maps them to statuses. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export class NotFoundError extends DomainError {
  constructor(what: string) {
    super('not_found', `${what} not found`);
  }
}
export class VersionConflictError extends DomainError {
  constructor(what: string) {
    super('version_conflict', `${what} was modified; reload and retry`, false);
  }
}
export class ValidationError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('invalid_input', message, false, details);
  }
}
export class ForbiddenError extends DomainError {
  constructor(reasonCode: string) {
    super('forbidden', 'not allowed', false, { reasonCode });
  }
}
export class CapabilityUnavailableError extends DomainError {
  constructor(message: string) {
    super('capability_unavailable', message, true);
  }
}

export class DockyardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DockyardError";
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends DockyardError {
  constructor(message, details = {}) {
    super("validation_error", message, details);
    this.name = "ValidationError";
  }
}

export class ModuleConflictError extends DockyardError {
  constructor(moduleId) {
    super("module_conflict", `Module is already registered: ${moduleId}`, { moduleId });
    this.name = "ModuleConflictError";
  }
}

export class ModuleNotFoundError extends DockyardError {
  constructor(moduleId) {
    super("module_not_found", `Module is not registered: ${moduleId}`, { moduleId });
    this.name = "ModuleNotFoundError";
  }
}

export class AccountSelectionError extends DockyardError {
  constructor(message, details = {}) {
    super("account_selection_error", message, details);
    this.name = "AccountSelectionError";
  }
}

export class ProviderCapabilityError extends DockyardError {
  constructor(providerId, capability) {
    super(
      "provider_capability_unavailable",
      `Provider module ${providerId} does not have an active ${capability} driver`,
      { providerId, capability },
    );
    this.name = "ProviderCapabilityError";
  }
}

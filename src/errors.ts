export class JpdclError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "JpdclError";
  }
}
export class AuthenticationError extends JpdclError {
  constructor(message = "JPDCL authentication is required", details?: unknown) {
    super(message, 401, details);
    this.name = "AuthenticationError";
  }
}

export class MutationDisabledError extends JpdclError {
  constructor() {
    super(
      "Mutating JPDCL operations are disabled. Set JPDCL_ENABLE_MUTATIONS=true to enable them.",
      403,
    );
    this.name = "MutationDisabledError";
  }
}

export class CliError extends Error {
  code: string;
  exitCode: number;

  constructor(message: string, options?: { code?: string; exitCode?: number }) {
    super(message);
    this.code = options?.code ?? "CLI_ERROR";
    this.exitCode = options?.exitCode ?? 1;
  }
}

export class ApiError extends CliError {
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message, { code });
    this.status = status;
  }
}

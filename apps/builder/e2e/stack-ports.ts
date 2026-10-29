/**
 * Ports of the e2e sign-in stack (playwright.stack.config.ts). Set FR_E2E_BUILDER_PORT, FR_E2E_API_PORT,
 * FR_E2E_SMTP_PORT and FR_E2E_MAILPIT_PORT to run a second stack beside one already running.
 */
export const STACK_PORTS = {
  builder: Number(process.env.FR_E2E_BUILDER_PORT ?? 4175),
  api: Number(process.env.FR_E2E_API_PORT ?? 18180),
  smtp: Number(process.env.FR_E2E_SMTP_PORT ?? 18125),
  mailpit: Number(process.env.FR_E2E_MAILPIT_PORT ?? 18126),
};

/** What apps/api/test/e2e-stack.ts reads, so the API, Mailpit and the builder agree on the ports. */
export function stackEnv(): Record<string, string> {
  return {
    FR_E2E_BUILDER_URL: `http://localhost:${STACK_PORTS.builder}`,
    FR_E2E_API_PORT: String(STACK_PORTS.api),
    FR_E2E_SMTP_PORT: String(STACK_PORTS.smtp),
    FR_E2E_MAILPIT_PORT: String(STACK_PORTS.mailpit),
  };
}

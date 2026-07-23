import pino from "pino";

// Always plain JSON; pipe through `npx pino-pretty` for pretty dev logs.
const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

export type Logger = pino.Logger;

export function rootLogger(): Logger {
  return baseLogger;
}

export function childLogger(scope: string): Logger {
  return baseLogger.child({ scope });
}

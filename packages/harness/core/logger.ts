import pino from "pino";

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.stderr.isTTY && process.env.LOG_PRETTY !== "0"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            destination: 2,
          },
        }
      : undefined,
});

export type Logger = pino.Logger;

export function rootLogger(): Logger {
  return baseLogger;
}

export function childLogger(scope: string): Logger {
  return baseLogger.child({ scope });
}

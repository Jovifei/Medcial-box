import type { FastifyInstance } from "fastify";

export interface ShutdownSignals {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Install handlers on the real API instance so Fastify onClose hooks drain owned resources. */
export function installGracefulShutdown(
  app: Pick<FastifyInstance, "close" | "log">,
  signals: ShutdownSignals = process,
  onFailure: (error: unknown) => void = () => { process.exitCode = 1; },
): () => void {
  let closeStarted = false;
  const onSignal = () => {
    if (closeStarted) return;
    closeStarted = true;
    // app.close() invokes the registered scheduler-stop and pool.end hooks.
    void app.close().catch(error => {
      app.log.error({ err: error }, "API graceful shutdown failed");
      onFailure(error);
    });
  };
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);
  return () => {
    signals.removeListener("SIGINT", onSignal);
    signals.removeListener("SIGTERM", onSignal);
  };
}

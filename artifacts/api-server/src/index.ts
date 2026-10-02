import app from "./app";
import { logger } from "./lib/logger";

// Replit injects PORT; fall back to a default so the API also runs locally
// with a plain `pnpm dev` and no environment setup. An unset, empty, or `0`
// PORT (common in dev/CI shells) means "use the default".
const configuredPort = process.env["PORT"];
const rawPort =
  configuredPort === undefined || configuredPort === "" || configuredPort === "0"
    ? "8080"
    : configuredPort;

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

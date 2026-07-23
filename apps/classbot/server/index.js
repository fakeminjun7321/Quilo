import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createApp({ config });

const server = app.listen(config.port, () => {
  console.log(`Quilo schedule server listening on http://localhost:${config.port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Quilo schedule received ${signal}; closing HTTP server.`);
  const forceExit = setTimeout(() => process.exit(1), 15_000);
  forceExit.unref();
  server.close((error) => {
    clearTimeout(forceExit);
    if (error) {
      console.error("Quilo schedule shutdown failed.", error);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

import { createInterface } from "node:readline";

import { startTool } from "./tool.js";

const promptForUrl = async () => {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  const answer = await new Promise<string>((resolve) => {
    readline.question("Enter start URL: ", (response) => resolve(response));
  });
  readline.close();
  return answer.trim();
};

const main = async () => {
  const command = process.argv[2] ?? "record";
  const headless = process.env.HEADLESS === "true";
  const startUrl =
    process.env.START_URL ??
    process.argv[3] ??
    (await promptForUrl());

  if (command !== "record") {
    throw new Error(`Unknown command: ${command}. Expected "record".`);
  }

  const result = await startTool({ headless, startUrl });
  console.log(
    `Scriber started (${command}). Browser: ${result.browserVersion}. Session: ${result.sessionId}`
  );
  console.log("Press Ctrl+C to stop recording.");

  let shutdownPromise: Promise<void> | null = null;
  const stopAndExit = (signal: NodeJS.Signals) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      process.stdout.write(`\nReceived ${signal}. Saving session...\n`);
      try {
        await result.stop();
        process.stdout.write("Session saved. Exiting.\n");
        process.stdin.pause();
        process.exit(0);
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        process.stderr.write(`Failed to stop cleanly: ${message}\n`);
        process.stdin.pause();
        process.exit(1);
      }
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void stopAndExit("SIGINT");
  });
  process.once("SIGTERM", () => {
    void stopAndExit("SIGTERM");
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

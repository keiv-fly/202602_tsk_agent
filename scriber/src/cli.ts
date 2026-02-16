import { createInterface, emitKeypressEvents } from "node:readline";

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
  console.log("Close the browser window to stop and save recording.");
  console.log("Press q to stop and save recording before closing the browser.");

  let shutdownPromise: Promise<void> | null = null;
  const stopAndExit = (reason: string) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    process.stdin.removeListener("keypress", onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    shutdownPromise = (async () => {
      process.stdout.write(`\nStopping recorder (${reason}). Saving session...\n`);
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

  const onKeypress = (_value: string, key?: { name?: string; ctrl?: boolean }) => {
    if (key?.ctrl && key.name === "c") {
      process.kill(process.pid, "SIGINT");
      return;
    }
    if (key?.name?.toLowerCase() === "q") {
      void stopAndExit("q pressed");
    }
  };

  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
  }

  result.page.context().browser()?.on("disconnected", () => {
    void stopAndExit("browser closed");
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

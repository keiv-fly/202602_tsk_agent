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
  const headless = process.env.HEADLESS !== "false";
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

  const stop = async () => {
    await result.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

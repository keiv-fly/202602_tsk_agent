import { startTool } from "./tool.js";

const main = async () => {
  const command = process.argv[2] ?? "record";
  const headless = process.env.HEADLESS !== "false";

  if (command !== "record") {
    throw new Error(`Unknown command: ${command}. Expected "record".`);
  }

  const result = await startTool({ headless });
  console.log(`Scriber started (${command}). Browser: ${result.browserVersion}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

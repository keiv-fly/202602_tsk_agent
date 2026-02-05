import { chromium } from "playwright";

export interface StartOptions {
  headless?: boolean;
}

export interface StartResult {
  browserVersion: string;
}

export const startTool = async (
  options: StartOptions = {}
): Promise<StartResult> => {
  const browser = await chromium.launch({
    headless: options.headless ?? true
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });
    const page = await context.newPage();
    await page.goto("about:blank");
    await context.close();

    return { browserVersion: browser.version() };
  } finally {
    await browser.close();
  }
};

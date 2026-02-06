import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";

export const appendJsonl = async (path: string, payload: unknown) => {
  const serialized = `${JSON.stringify(payload)}\n`;
  await appendFile(path, serialized, "utf8");
};

export const readJsonl = async <T>(path: string): Promise<T[]> => {
  const content = await readFile(path, "utf8");
  return parseJsonl<T>(content);
};

export const parseJsonl = <T>(content: string): T[] => {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((line): line is T => line !== null);
};

export const streamJsonlLines = async <T>(
  path: string,
  onLine: (payload: T) => void
) => {
  const stream = createReadStream(path, { encoding: "utf8" });
  let buffer = "";

  for await (const chunk of stream) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        onLine(JSON.parse(line) as T);
      } catch {
        continue;
      }
    }
  }
};

export const createJsonlStream = (path: string) => {
  return createWriteStream(path, { flags: "a" });
};

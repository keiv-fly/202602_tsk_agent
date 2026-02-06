import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const gzipHtml = async (html: string): Promise<Buffer> => {
  return gzipAsync(html);
};

export const gunzipHtml = async (buffer: Buffer): Promise<string> => {
  const result = await gunzipAsync(buffer);
  return result.toString("utf8");
};

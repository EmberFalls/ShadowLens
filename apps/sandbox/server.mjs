import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };
createServer(async (request, response) => {
  if (request.method !== "GET") { response.writeHead(405).end(); return; }
  let path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname)).replace(/^([.][.][/\\])+/, "");
  if (path === "." || path === "/") path = "/index.html";
  const file = join(root, path.replace(/^[/\\]+/, ""));
  try {
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error("missing");
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'" });
    response.end(await readFile(file));
  } catch { response.writeHead(404).end("Not found"); }
}).listen(4173, "localhost", () => console.log("ShadowLens local sandbox at http://localhost:4173"));

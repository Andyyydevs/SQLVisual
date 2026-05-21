const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3100;
const HOST = "127.0.0.1";
const DATA_FILE = path.join(__dirname, "relationship-sessions.json");
const STATIC_ROOT = __dirname;

function readStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStore(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function sanitizeRelationship(rel) {
  if (!rel || typeof rel !== "object") return null;
  const fromTable = String(rel.fromTable || "").trim();
  const fromColumn = String(rel.fromColumn || "").trim();
  const toTable = String(rel.toTable || "").trim();
  const toColumn = String(rel.toColumn || "").trim();
  if (!fromTable || !fromColumn || !toTable || !toColumn) return null;
  return {
    fromTable,
    fromColumn,
    toTable,
    toColumn,
    via: rel.via ? String(rel.via) : "MANUAL"
  };
}

function sanitizeRelationships(relationships) {
  if (!Array.isArray(relationships)) return [];
  return relationships.map(sanitizeRelationship).filter(Boolean);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,PUT,OPTIONS"
  });
  res.end(JSON.stringify(payload));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "text/plain; charset=utf-8";
}

function serveStatic(reqPath, res) {
  const target = reqPath === "/" ? "/index.html" : reqPath;
  const resolvedPath = path.normalize(path.join(STATIC_ROOT, target));
  if (!resolvedPath.startsWith(STATIC_ROOT)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(resolvedPath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": contentTypeFor(resolvedPath) });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathName = parsedUrl.pathname;

  if (req.method === "OPTIONS" && pathName.startsWith("/api/relationship-sessions/")) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const sessionMatch = pathName.match(/^\/api\/relationship-sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionKey = decodeURIComponent(sessionMatch[1] || "").trim();
    if (!sessionKey) {
      sendJson(res, 400, { error: "sessionKey is required" });
      return;
    }

    if (req.method === "GET") {
      const store = readStore();
      const relationships = sanitizeRelationships(store[sessionKey]?.relationships || []);
      sendJson(res, 200, { relationships });
      return;
    }

    if (req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          const payload = body ? JSON.parse(body) : {};
          const relationships = sanitizeRelationships(payload.relationships);
          const store = readStore();
          store[sessionKey] = { relationships };
          writeStore(store);
          sendJson(res, 200, { relationships });
        } catch (_) {
          sendJson(res, 400, { error: "Invalid JSON body" });
        }
      });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (req.method === "GET") {
    serveStatic(pathName, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`SQLVisual server running at http://${HOST}:${PORT}`);
});

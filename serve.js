// 罐罐旅游指南 · 一键发布脚本
//
// 用法：
//   node serve.js            仅启动局域网服务（同一 WiFi 下手机可访问）
//   node serve.js --public   同时建立 Cloudflare 公网隧道，输出公网链接
//
// 前置：dist/ 目录已存在（用 node build-dist.js 生成）
// 公网模式需要 cloudflared.exe（放在脚本同目录，或用 --cloudflared <路径> 指定）

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 8080);
const WANT_PUBLIC = process.argv.includes("--public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("未找到 dist/index.html，请先运行：node build-dist.js");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    pathname = "/";
  }
  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(DIST, pathname);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("403");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 " + pathname);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
});

function lanAddresses() {
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) result.push(item.address);
    }
  }
  return result;
}

function findCloudflared() {
  const flagIndex = process.argv.indexOf("--cloudflared");
  if (flagIndex !== -1 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
  const local = path.join(ROOT, "cloudflared.exe");
  if (fs.existsSync(local)) return local;
  return null;
}

function startTunnel() {
  const binary = findCloudflared();
  if (!binary) {
    console.log("\n[公网模式] 未找到 cloudflared.exe，已跳过隧道。");
    console.log("  获取方式：https://github.com/cloudflare/cloudflared/releases/latest");
    console.log("  下载 cloudflared-windows-amd64.exe 放到项目目录后重试。\n");
    return;
  }
  const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let announced = false;
  const handle = chunk => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !announced) {
      announced = true;
      console.log("\n[公网模式] 公网链接（手机 / 电脑均可直接打开）：");
      console.log("  " + match[0] + "\n");
      console.log("  在页面右上角点分享按钮，可生成该链接的二维码，手机扫一扫即可打开。");
      console.log("  关闭本进程即结束公网访问。\n");
    }
  };
  child.stdout.on("data", handle);
  child.stderr.on("data", handle);
  child.on("error", error => console.log("[公网模式] 启动失败:", error.message));
  const shutdown = () => { try { child.kill(); } catch {} server.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("罐罐旅游指南已启动");
  console.log("  本机访问：http://127.0.0.1:" + PORT + "/");
  for (const address of lanAddresses()) {
    console.log("  局域网访问：http://" + address + ":" + PORT + "/   （同一 WiFi 下的手机可打开）");
  }
  if (WANT_PUBLIC) startTunnel();
});

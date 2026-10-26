// 构建静态部署目录 dist/：把应用打包成可直接对外发布的一组静态文件。
//   - 入口改为 ASCII 文件名 index.html，避免中文 URL 编码带来的分享与缓存问题
//   - 全部资源使用相对路径，手机 / 电脑打开同一链接即可
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.mkdirSync(DIST, { recursive: true });

// 1) 登录页作为静态站点入口，应用主体使用 ASCII 文件名
const loginHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const staticLoginHtml = loginHtml.replace(
  /location\.assign\(["'][^"']+\.html["']\);/,
  'location.assign("./guide.html");'
);
if (staticLoginHtml === loginHtml) {
  console.error("登录页中未找到应用跳转地址");
  process.exit(1);
}
fs.writeFileSync(path.join(DIST, "index.html"), staticLoginHtml, "utf8");
const sourceHtml = fs.readFileSync(path.join(ROOT, "罐罐旅游指南2.0.html"), "utf8");
fs.writeFileSync(path.join(DIST, "guide.html"), sourceHtml, "utf8");

// 2) 静态资源
for (const rel of ["vendor/leaflet.css", "vendor/leaflet.js", "vendor/qrcode.js",
                   "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"]) {
  copyFile(path.join(ROOT, rel), path.join(DIST, rel));
}

// 3) Service Worker：缓存列表对齐 dist 的实际文件名
const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8")
  .replace('"./罐罐旅游指南2.0.html"', '"./guide.html"');
fs.writeFileSync(path.join(DIST, "sw.js"), sw, "utf8");

// 4) 校验：dist 内不得残留中文文件名依赖
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const files = walk(DIST).map(f => path.relative(DIST, f).replace(/\\/g, "/"));
const bad = files.filter(f => /[^\x00-\x7F]/.test(f));
if (bad.length) {
  console.error("dist 中存在非 ASCII 文件名:", bad);
  process.exit(1);
}
if (!files.includes("index.html")) {
  console.error("dist 缺少入口 index.html");
  process.exit(1);
}

console.log("dist 构建完成，共", files.length, "个文件：");
files.forEach(f => console.log("  -", f, fs.statSync(path.join(DIST, f)).size + "B"));

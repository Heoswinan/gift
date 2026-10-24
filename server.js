"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function rateLimit({ windowMs, max }) {
  const clients = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of clients) {
      if (bucket.resetAt <= now) clients.delete(ip);
    }
  }, 10 * 60 * 1000);
  cleanup.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    let bucket = clients.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      clients.set(key, bucket);
    }
    if (bucket.count >= max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ detail: "操作太频繁，请稍后再试" });
    }
    bucket.count += 1;
    next();
  };
}

const placeWriteLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const reviewWriteLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const voteWriteLimit = rateLimit({ windowMs: 60 * 1000, max: 60 });

function isText(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isIntegerInRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function visitorIdFrom(req) {
  const id = req.get("X-Visitor-Id");
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS places (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('food', 'attraction')),
      city TEXT NOT NULL,
      name TEXT NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      lat DOUBLE PRECISION NOT NULL,
      description TEXT NOT NULL,
      video_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      poi_id TEXT NOT NULL,
      overall SMALLINT NOT NULL CHECK (overall BETWEEN 0 AND 5),
      dimensions JSONB NOT NULL,
      content TEXT NOT NULL,
      tags JSONB NOT NULL,
      anonymous BOOLEAN NOT NULL DEFAULT FALSE,
      author TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS review_votes (
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      visitor_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (review_id, visitor_id)
    );

    CREATE INDEX IF NOT EXISTS reviews_poi_created_idx ON reviews (poi_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS review_votes_review_idx ON review_votes (review_id);
  `);
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/罐罐旅游指南2.0.html", (req, res) =>
  res.sendFile(path.join(__dirname, "罐罐旅游指南2.0.html"))
);

app.get("/api/health", asyncRoute(async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
}));

app.get("/api/guide/places", asyncRoute(async (req, res) => {
  const [placesResult, reviewsResult, voteCountsResult, visitorVotesResult] = await Promise.all([
    pool.query("SELECT id, category, city, name, lng, lat, description, video_url FROM places ORDER BY created_at DESC"),
    pool.query("SELECT id, poi_id, overall, dimensions, content, tags, anonymous, author, created_at FROM reviews ORDER BY created_at DESC"),
    pool.query("SELECT review_id, COUNT(*)::INTEGER AS useful FROM review_votes GROUP BY review_id"),
    pool.query("SELECT review_id FROM review_votes WHERE visitor_id = $1", [visitorIdFrom(req) || ""])
  ]);

  const voteCounts = new Map(voteCountsResult.rows.map(row => [row.review_id, row.useful]));
  const visitorVotes = new Set(visitorVotesResult.rows.map(row => row.review_id));
  const reviews = {};
  for (const row of reviewsResult.rows) {
    const createdAt = new Date(row.created_at);
    const ageDays = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 86400000));
    const item = {
      id: row.id,
      overall: row.overall,
      dims: row.dimensions,
      content: row.content,
      tags: row.tags,
      anonymous: row.anonymous,
      author: row.author,
      createdAt: createdAt.toISOString(),
      ageDays,
      useful: voteCounts.get(row.id) || 0,
      usefulOn: visitorVotes.has(row.id)
    };
    (reviews[row.poi_id] ||= []).push(item);
  }

  res.json({
    places: placesResult.rows.map(row => ({
      id: row.id,
      type: row.category,
      city: row.city,
      name: row.name,
      lng: row.lng,
      lat: row.lat,
      desc: row.description,
      videoUrl: row.video_url,
      userAdded: true
    })),
    reviews
  });
}));

app.post("/api/guide/places", placeWriteLimit, asyncRoute(async (req, res) => {
  const { category, city, name, lng, lat, description, video_url: videoUrl } = req.body;
  if (!["food", "attraction"].includes(category)) {
    return res.status(400).json({ detail: "请选择有效的地点类型" });
  }
  if (!isText(city, 80) || !isText(name, 120) || !isText(description, 300)) {
    return res.status(400).json({ detail: "城市、名称和推荐理由为必填项，且长度需符合要求" });
  }
  if (typeof lng !== "number" || typeof lat !== "number" || lng < 73 || lng > 135 || lat < 17 || lat > 54) {
    return res.status(400).json({ detail: "请填写中国范围内有效的经纬度" });
  }
  let parsedVideoUrl;
  try {
    parsedVideoUrl = new URL(videoUrl);
    if (!["http:", "https:"].includes(parsedVideoUrl.protocol)) throw new Error("Invalid protocol");
  } catch {
    return res.status(400).json({ detail: "视频链接需使用有效的 http 或 https 地址" });
  }

  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO places (id, category, city, name, lng, lat, description, video_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, category, city, name, lng, lat, description, video_url`,
    [id, category, city.trim(), name.trim(), lng, lat, description.trim(), parsedVideoUrl.href]
  );
  const row = result.rows[0];
  res.status(201).json({
    id: row.id,
    type: row.category,
    city: row.city,
    name: row.name,
    lng: row.lng,
    lat: row.lat,
    desc: row.description,
    videoUrl: row.video_url,
    userAdded: true
  });
}));

app.post("/api/guide/reviews", reviewWriteLimit, asyncRoute(async (req, res) => {
  const { poi_id: poiId, overall, dimensions, content, tags, anonymous } = req.body;
  if (!isText(poiId, 100)) {
    return res.status(400).json({ detail: "点评地点无效" });
  }
  if (!isIntegerInRange(overall, 0, 5) ||
      !Array.isArray(dimensions) ||
      dimensions.length !== 3 ||
      !dimensions.every(value => isIntegerInRange(value, 0, 5))) {
    return res.status(400).json({ detail: "评分格式无效" });
  }
  if (typeof content !== "string" || content.trim().length > 500) {
    return res.status(400).json({ detail: "点评内容最多 500 字" });
  }
  if (!Array.isArray(tags) || tags.length > 8 ||
      !tags.every(tag => isText(tag, 24))) {
    return res.status(400).json({ detail: "推荐标签格式无效" });
  }
  if (typeof anonymous !== "boolean") {
    return res.status(400).json({ detail: "匿名选项无效" });
  }
  if (overall === 0 && dimensions.every(value => value === 0) && !content.trim()) {
    return res.status(400).json({ detail: "请至少填写星级、维度评分或文字点评" });
  }

  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO reviews (id, poi_id, overall, dimensions, content, tags, anonymous, author)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, poiId.trim(), overall, JSON.stringify(dimensions), content.trim(), JSON.stringify(tags), anonymous, "访客"]
  );
  res.status(201).json({ id });
}));

app.post("/api/guide/reviews/:id/vote", voteWriteLimit, asyncRoute(async (req, res) => {
  const visitorId = visitorIdFrom(req);
  if (!visitorId) {
    return res.status(400).json({ detail: "访客标识无效，请刷新页面后重试" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const review = await client.query("SELECT id FROM reviews WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!review.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ detail: "找不到这条点评" });
    }
    const existing = await client.query(
      "DELETE FROM review_votes WHERE review_id = $1 AND visitor_id = $2 RETURNING review_id",
      [req.params.id, visitorId]
    );
    const usefulOn = existing.rowCount === 0;
    if (usefulOn) {
      await client.query(
        "INSERT INTO review_votes (review_id, visitor_id) VALUES ($1, $2)",
        [req.params.id, visitorId]
      );
    }
    const count = await client.query(
      "SELECT COUNT(*)::INTEGER AS useful FROM review_votes WHERE review_id = $1",
      [req.params.id]
    );
    await client.query("COMMIT");
    res.json({ useful: count.rows[0].useful, usefulOn });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

app.use((req, res) => res.status(404).json({ detail: "找不到请求的资源" }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("Request failed", error);
  if (error.type === "entity.too.large") {
    return res.status(413).json({ detail: "请求内容过大" });
  }
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({ detail: "请求数据不是有效的 JSON" });
  }
  res.status(500).json({ detail: "服务暂不可用，请稍后重试" });
});

initializeDatabase().then(() => {
  app.listen(port, "0.0.0.0", () => console.log(`Travel guide service listening on ${port}`));
}).catch(error => {
  console.error("Could not initialize the database", error);
  process.exitCode = 1;
});

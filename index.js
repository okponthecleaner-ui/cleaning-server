require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// Supabase
// =====================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// =====================
// 設定
// =====================
const NOW_BUFFER_MINUTES = 10;

// Uber Direct: サンドボックス / 本番の切り替え
const UBER_API_BASE = process.env.UBER_SANDBOX === "true"
  ? "https://sandbox-api.uber.com"
  : "https://api.uber.com";
const UBER_AUTH_URL = "https://auth.uber.com/oauth/v2/token";

// =====================
// Helper
// =====================
function toIso(ms) {
  return new Date(ms).toISOString();
}

function isInt(n) {
  return Number.isInteger(n) && Number.isFinite(n);
}

// Tokyo(JST) の「YYYY-MM-DD + HH:mm」を UTC の ms に変換する
// JST = UTC+9 なので、UTCは「(JST時刻) - 9時間」
function tokyoPartsToUtcMs(dateStr, hourStr, minuteStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, error: "scheduledDate が不正（YYYY-MM-DD）" };

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  const hh = Number(String(hourStr || "").replace(/[^0-9]/g, ""));
  const mm = Number(String(minuteStr || "").replace(/[^0-9]/g, ""));

  if (mo < 1 || mo > 12) return { ok: false, error: "月が不正" };
  if (d < 1 || d > 31) return { ok: false, error: "日が不正" };
  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return { ok: false, error: "時が不正" };
  if (!Number.isFinite(mm) || mm < 0 || mm > 59) return { ok: false, error: "分が不正" };

  // UTCの時刻として作る：Date.UTC(y, mo-1, d, hh-9, mm)
  const utcMs = Date.UTC(y, mo - 1, d, hh - 9, mm, 0, 0);

  // 「存在しない日付」を排除するため、逆変換で一致チェック（Tokyoとして）
  const back = new Date(utcMs + 9 * 60 * 60 * 1000);
  const by = back.getUTCFullYear();
  const bmo = back.getUTCMonth() + 1;
  const bd = back.getUTCDate();
  const bh = back.getUTCHours();
  const bm = back.getUTCMinutes();

  if (by !== y || bmo !== mo || bd !== d || bh !== hh || bm !== mm) {
    return { ok: false, error: "存在しない日付/時刻です" };
  }

  return { ok: true, ms: utcMs };
}

function computePickupReadyAtMs(body) {
  const timingType = String(body.timingType || "");

  if (timingType === "SCHEDULED") {
    // 新方式：scheduledDate / scheduledHour / scheduledMinute を優先
    const date = body.scheduledDate;
    const hour = body.scheduledHour;
    const minute = body.scheduledMinute;

    if (date && hour !== undefined && minute !== undefined) {
      const r = tokyoPartsToUtcMs(date, hour, minute);
      if (!r.ok) return { ok: false, error: r.error };

      // 実務チェック：現在+30分以上、30日以内
      const now = Date.now();
      const minLead = 30 * 60 * 1000;
      const maxHorizon = 30 * 24 * 60 * 60 * 1000;

      if (r.ms < now + minLead) return { ok: false, error: "時間指定が近すぎます（現在+30分以上）" };
      if (r.ms > now + maxHorizon) return { ok: false, error: "時間指定が遠すぎます（30日以内）" };

      return { ok: true, pickupReadyAtMs: r.ms, mode: "SCHEDULED(TOKYO_SERVER)" };
    }

    // 互換：古い方式 scheduledAtMs が来ても動くようにしておく（移行期間用）
    const legacyMs = Number(body.scheduledAtMs);
    if (isInt(legacyMs) && legacyMs > 0) {
      return { ok: true, pickupReadyAtMs: legacyMs, mode: "SCHEDULED(LEGACY_MS)" };
    }

    return { ok: false, error: "SCHEDULED なのに時間情報がありません（scheduledDate/hour/minute か scheduledAtMs が必要）" };
  }

  // NOW：サーバで「今+バッファ」
  const pickupReadyAtMs = Date.now() + NOW_BUFFER_MINUTES * 60 * 1000;
  return { ok: true, pickupReadyAtMs, mode: "NOW" };
}

// =====================
// Supabase
// =====================
async function saveDelivery(body, pickupReadyAtMs, userId) {
  const { data, error } = await supabase
    .from("deliveries")
    .insert([
      {
        user_id: userId,
        pickup: {
          address: body.pickupAddress,
          phone: body.pickupPhone,
          notes: "集荷（受付/返却）",
          kind: body.kind,
          timingType: body.timingType,
          bagSize: body.bagSize ?? null,
          items: Array.isArray(body.items) ? body.items : null,
        },
        dropoff: {
          address: body.dropoffAddress,
          phone: body.dropPhone,
          notes: "クリーニング品の受け渡し",
        },
        scheduled_at: toIso(pickupReadyAtMs),
        scheduled_at_ms: pickupReadyAtMs,
        status: "requested",
      },
    ])
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return data; // { id }
}

// =====================
// Uber Direct
// =====================

// 日本の電話番号を E.164 形式に変換（090... → +8190...）
function toE164Japan(phone) {
  const digits = String(phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) return "+81" + digits.slice(1);
  return "+" + digits;
}

// client_credentials でアクセストークンを取得
async function getUberAccessToken() {
  const params = new URLSearchParams({
    client_id: process.env.UBER_CLIENT_ID,
    client_secret: process.env.UBER_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "eats.deliveries",
  });

  const res = await fetch(UBER_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Uber 認証失敗 (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) throw new Error("Uber 認証レスポンスにトークンがありません");
  return data.access_token;
}

// Uber Direct deliveries エンドポイント用のペイロードを組み立てる
function buildUberDeliveryPayload(body, pickupReadyAtMs) {
  // dropoff deadline: pickup_ready_at + 2時間
  const dropoffDeadlineMs = pickupReadyAtMs + 2 * 60 * 60 * 1000;

  const pickupInstructions = body.kind === "RECEPTION" ? "集荷（受付）" : "集荷（返却）";

  // manifest_items は必須。種別に応じて生成する
  let manifestItems;
  if (body.kind === "RETURN" && Array.isArray(body.items) && body.items.length > 0) {
    // RETURN: 選択されたアイテム名を1件ずつ展開
    manifestItems = body.items.map((item) => ({
      name: typeof item === "string" ? item : String(item),
      quantity: 1,
      size: "small",
    }));
  } else {
    // RECEPTION: bagSize からラベルを生成
    const bagLabel =
      body.bagSize === "BAG_FIT" ? "クリーニング品（バッグ以内）" :
      body.bagSize === "BAG_NOT_FIT" ? "クリーニング品（大型）" :
      "クリーニング品";
    manifestItems = [{ name: bagLabel, quantity: 1, size: "small" }];
  }

  return {
    pickup_name: "FUJI DELIVERY（集荷）",
    pickup_address: body.pickupAddress,
    pickup_phone_number: toE164Japan(body.pickupPhone),
    pickup_ready_dt: toIso(pickupReadyAtMs),
    pickup_instructions: pickupInstructions,

    dropoff_name: "FUJI DELIVERY（受け渡し）",
    dropoff_address: body.dropoffAddress,
    dropoff_phone_number: toE164Japan(body.dropPhone),
    dropoff_deadline_dt: toIso(dropoffDeadlineMs),
    dropoff_instructions: "クリーニング品の受け渡し",

    manifest_total_value: 0,
    manifest_items: manifestItems,
  };
}

// Uber Direct に配達依頼を送信する
// 戻り値: { ok: true, data: {...} } | { ok: false, error: "..." }
async function createUberDelivery(body, pickupReadyAtMs) {
  const clientId = process.env.UBER_CLIENT_ID;
  const clientSecret = process.env.UBER_CLIENT_SECRET;
  const customerId = process.env.UBER_CUSTOMER_ID;

  if (!clientId || !clientSecret || !customerId) {
    return { ok: false, error: "Uber Direct の環境変数が未設定です（スキップ）" };
  }

  const accessToken = await getUberAccessToken();

  const url = `${UBER_API_BASE}/v1/customers/${customerId}/deliveries`;
  const payload = buildUberDeliveryPayload(body, pickupReadyAtMs);

  console.log("=== Uber Direct request ===");
  console.log("URL:", url);
  console.log(JSON.stringify(payload, null, 2));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Uber Direct 配達作成失敗 (${res.status}): ${text}`);
  }

  const data = await res.json();
  return { ok: true, data };
}

// =====================
// Routes
// =====================
app.get("/health", (req, res) => res.json({
  ok: true,
  uberMode: process.env.UBER_SANDBOX === "true" ? "sandbox" : "production",
}));

app.post("/deliveries", async (req, res) => {
  console.log("=== /deliveries called ===");
  console.log(JSON.stringify(req.body, null, 2));

  // JWT を検証して user_id を取得
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "認証トークンがありません" });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ ok: false, error: "認証に失敗しました" });

  const userId = user.id;
  console.log("=== authenticated user ===", userId);

  const body = req.body || {};

  const required = ["kind", "timingType", "pickupAddress", "dropoffAddress", "pickupPhone", "dropPhone"];
  for (const k of required) {
    if (!body[k] || String(body[k]).trim().length === 0) {
      return res.status(400).json({ ok: false, error: `missing: ${k}` });
    }
  }

  const timing = computePickupReadyAtMs(body);
  if (!timing.ok) return res.status(400).json({ ok: false, error: timing.error });

  const pickupReadyAtMs = timing.pickupReadyAtMs;

  console.log("=== computed pickup_ready_at ===");
  console.log({ mode: timing.mode, pickupReadyAtMs, pickupReadyAtIso: toIso(pickupReadyAtMs) });

  // ① Supabase に保存（失敗したら 500 で返す）
  let deliveryId = null;
  try {
    const saved = await saveDelivery(body, pickupReadyAtMs, userId);
    deliveryId = saved.id;
    console.log("=== saved to Supabase ===", { id: deliveryId });
  } catch (e) {
    console.error("=== Supabase save error ===", e.message);
    return res.status(500).json({ ok: false, error: `DB保存エラー: ${e.message}` });
  }

  // ② Uber Direct に配達依頼（失敗しても Supabase 保存は成功扱い・フォールバック）
  let uberDeliveryId = null;
  let uberStatus = "skipped";
  let uberError = null;

  try {
    const uberResult = await createUberDelivery(body, pickupReadyAtMs);

    if (uberResult.ok) {
      uberDeliveryId = uberResult.data.id ?? null;
      uberStatus = "created";
      console.log("=== Uber delivery created ===", { uber_id: uberDeliveryId });

      // Supabase のステータスを "uber_created" に更新
      await supabase
        .from("deliveries")
        .update({ status: "uber_created" })
        .eq("id", deliveryId);
    } else {
      // 環境変数未設定などの想定内スキップ
      uberError = uberResult.error;
      console.log("=== Uber skipped ===", uberError);
    }
  } catch (e) {
    uberError = e.message;
    console.error("=== Uber API error (fallback) ===", uberError);
  }

  return res.json({
    ok: true,
    id: deliveryId,
    mode: timing.mode,
    pickupReadyAtMs,
    pickupReadyAtIso: toIso(pickupReadyAtMs),
    uberStatus,
    ...(uberDeliveryId && { uberId: uberDeliveryId }),
    ...(uberError && { uberError }),
  });
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`http://localhost:${PORT}/health`);
  console.log(`Uber mode: ${process.env.UBER_SANDBOX === "true" ? "sandbox" : "production"}`);
});

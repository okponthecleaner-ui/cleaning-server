const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// =====================
// 設定
// =====================
const NOW_BUFFER_MINUTES = 10;

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
  // utcMs を JST に戻すには +9h して UTC成分を見る
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

function buildUberDirectPayloadPreview(body, pickupReadyAtMs) {
  const kind = String(body.kind || "");
  const pickupAddress = String(body.pickupAddress || "");
  const dropoffAddress = String(body.dropoffAddress || "");
  const pickupPhone = String(body.pickupPhone || "");
  const dropPhone = String(body.dropPhone || "");

  const items = Array.isArray(body.items) ? body.items : [];

  return {
    pickup_ready_at_ms: pickupReadyAtMs,
    pickup_ready_at_iso: toIso(pickupReadyAtMs),

    kind,
    pickup: {
      address: pickupAddress,
      phone: pickupPhone,
      notes: "集荷（受付/返却）",
    },
    dropoff: {
      address: dropoffAddress,
      phone: dropPhone,
      notes: "クリーニング品の受け渡し",
    },
    items,
  };
}

// =====================
// Routes
// =====================
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/deliveries", (req, res) => {
  console.log("=== /deliveries called ===");
  console.log(JSON.stringify(req.body, null, 2));

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
  const uberPreview = buildUberDirectPayloadPreview(body, pickupReadyAtMs);

  console.log("=== computed pickup_ready_at ===");
  console.log({
    mode: timing.mode,
    pickupReadyAtMs,
    pickupReadyAtIso: toIso(pickupReadyAtMs),
  });

  console.log("=== uber payload preview ===");
  console.log(JSON.stringify(uberPreview, null, 2));

  return res.json({
    ok: true,
    mode: timing.mode,
    pickupReadyAtMs,
    pickupReadyAtIso: toIso(pickupReadyAtMs),
    uberPreview,
  });
});

// =====================
// Start
// =====================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`http://localhost:${PORT}/health`);
});

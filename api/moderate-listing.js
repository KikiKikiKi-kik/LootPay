
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    MIRROR_MODERATION_URL,
    MODERATION_SECRET
  } = process.env;

  if (
    !SUPABASE_URL ||
    !SUPABASE_PUBLISHABLE_KEY ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !MIRROR_MODERATION_URL ||
    !MODERATION_SECRET
  ) {
    return res.status(500).json({
      error: "Server environment is incomplete"
    });
  }

  try {
    // Проверяем авторизацию пользователя
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ error: "Login required" });
    }

    const authResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!authResponse.ok) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const user = await authResponse.json();

    if (!user?.id) {
      return res.status(401).json({ error: "Invalid user" });
    }

    // Проверяем данные объявления
    const {
      title,
      description,
      game,
      place,
      category,
      price,
      image_url
    } = req.body || {};

    if (
      typeof title !== "string" ||
      typeof description !== "string" ||
      typeof game !== "string" ||
      typeof category !== "string" ||
      !title.trim() ||
      !description.trim() ||
      !game.trim() ||
      !category.trim() ||
      title.length > 150 ||
      description.length > 2000 ||
      !Number.isFinite(Number(price)) ||
      Number(price) <= 0 ||
      Number(price) > 1000000000
    ) {
      return res.status(400).json({
        error: "Invalid listing data"
      });
    }

    const listing = {
      title: title.trim(),
      description: description.trim(),
      game: game.trim(),
      place: typeof place === "string" ? place : null,
      category: category.trim(),
      price: Number(price),
      image_url:
        typeof image_url === "string" && image_url.trim()
          ? image_url.trim()
          : null
    };

    // По умолчанию — ручная проверка
    
let decision = "review";
let reason = "Автоматическая проверка недоступна";

try {
  console.log("MIRROR REQUEST:", MIRROR_MODERATION_URL);

  const moderationResponse = await fetch(
    MIRROR_MODERATION_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-moderation-secret": MODERATION_SECRET
      },
      body: JSON.stringify(listing)
    }
  );

  const responseText = await moderationResponse.text();

  console.log("MIRROR HTTP STATUS:", moderationResponse.status);
  console.log("MIRROR RAW RESPONSE:", responseText);

  if (!moderationResponse.ok) {
    reason = "Mirror AI HTTP error: " + moderationResponse.status;
  } else {
    const result = JSON.parse(responseText);

    if (
      ["approved", "rejected", "review"].includes(result.decision)
    ) {
      decision = result.decision;
      reason = String(result.reason || "Решение ИИ").slice(0, 500);
    } else {
      reason = "Mirror AI вернул неизвестное решение";
    }
  }
} catch (error) {
  console.error("MIRROR ERROR:", error);
  reason = "Ошибка связи с Mirror AI: " + String(error.message || error);
}

console.log("FINAL MODERATION DECISION:", {
  decision,
  reason,
  title: listing.title
});

    // В базе review хранится как pending
    const status =
      decision === "approved"
        ? "approved"
        : decision === "rejected"
          ? "rejected"
          : "pending";

    // Сохраняем объявление от имени проверенного пользователя
    const insertResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/listings`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          seller_id: user.id,
          ...listing,
          status
        })
      }
    );

    if (!insertResponse.ok) {
      const errorText = await insertResponse.text();
      console.error("Supabase insert error:", errorText);

      return res.status(500).json({
        error: "Could not save listing"
      });
    }

    const saved = await insertResponse.json();

    return res.status(201).json({
      success: true,
      decision,
      status,
      reason,
      listing: saved[0] || null
    });

  } catch (error) {
    console.error("Listing moderation error:", error);

    return res.status(500).json({
      error: "Server error"
    });
  }
}

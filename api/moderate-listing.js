
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
    // 1. Авторизация
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

    // 2. Получение объявления
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

    // 3. Фото обязательно
    if (typeof image_url !== "string" || !image_url.trim()) {
      return res.status(400).json({
        error: "Загрузи фотографию товара"
      });
    }

    const imageUrl = image_url.trim();

    // Разрешаем только изображения из собственного Storage
    let parsedImageUrl;

    try {
      parsedImageUrl = new URL(imageUrl);
    } catch {
      return res.status(400).json({
        error: "Некорректная ссылка на фотографию"
      });
    }

    const expectedHost = new URL(SUPABASE_URL).host;
    const expectedPath =
      `/storage/v1/object/public/listing-images/${user.id}/`;

    if (
      parsedImageUrl.protocol !== "https:" ||
      parsedImageUrl.host !== expectedHost ||
      !parsedImageUrl.pathname.startsWith(expectedPath)
    ) {
      return res.status(400).json({
        error: "Фото должно быть загружено через LootPay"
      });
    }

    const listing = {
      title: title.trim(),
      description: description.trim(),
      game: game.trim(),
      place: typeof place === "string" ? place : null,
      category: category.trim(),
      price: Number(price),
      image_url: imageUrl
    };

    // 4. Проверка через Mirror AI
    let decision = "review";
    let reason = "Не удалось подтвердить безопасность объявления";

    try {
      const moderationResponse = await fetch(
        MIRROR_MODERATION_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-moderation-secret": MODERATION_SECRET
          },
          body: JSON.stringify({
            ...listing,
            image_url: imageUrl,
            image_required: true,
            check_image_content: true,
            check_game_match: true
          })
        }
      );

      const responseText = await moderationResponse.text();

      if (!moderationResponse.ok) {
        throw new Error(
          "Mirror AI HTTP " + moderationResponse.status
        );
      }

      const result = JSON.parse(responseText);

      if (
        ["approved", "rejected", "review"].includes(result.decision)
      ) {
        decision = result.decision;
        reason = String(
          result.reason || "Решение Mirror AI"
        ).slice(0, 500);

        // Не доверяем одобрению без подтверждения анализа фото
        if (
          result.decision === "approved" &&
          result.image_checked !== true
        ) {
          decision = "review";
          reason = "Фотография не прошла подтверждённую проверку ИИ";
        }

        // Если ИИ обнаружил несоответствие фото и товара
        if (result.image_matches === false) {
          decision = "rejected";
          reason = "Фотография не соответствует объявлению";
        }
      } else {
        reason = "Mirror AI вернул неизвестное решение";
      }
    } catch (error) {
      console.error("MIRROR ERROR:", error);

      decision = "review";
      reason = "Ошибка проверки: объявление отправлено на ручную модерацию";
    }

    // 5. Статус
    const status =
      decision === "approved"
        ? "approved"
        : decision === "rejected"
          ? "rejected"
          : "pending";

    // 6. Сохранение
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

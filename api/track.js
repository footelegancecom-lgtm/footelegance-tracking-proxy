export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const num = (req.query.num || "").trim();
    const lang = (req.query.lang || "it").toLowerCase();

    if (!num) {
      return res.status(400).json({
        success: false,
        message: translate("missing_number", lang)
      });
    }

    const response = await fetch("http://193.112.141.69:8082/trackIndex.htm", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      body: new URLSearchParams({
        documentCode: num
      }).toString()
    });

    const html = await response.text();
    const parsed = parseTrackingHtml(html, num, lang);

    return res.status(200).json({
      success: true,
      ...parsed
    });
  } catch (error) {
    console.error("Tracking proxy error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
}

function parseTrackingHtml(html, requestedTracking, lang) {
  const clean = (str = "") =>
    str
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const summaryRowMatch = html.match(
    /<ul class="clearfix">\s*<li class="div_li3" title="[^"]*">([^<]*)<\/li>[\s\S]*?<li class="div_li3" title="[^"]*">([^<]*)<\/li>[\s\S]*?<li class="div_li1">([^<]*)<\/li>[\s\S]*?<li class="div_li2">([^<]*)<\/li>[\s\S]*?<li class="div_li4">([\s\S]*?)<\/li>[\s\S]*?<li class="div_li3"><span title="([^"]*)">/i
  );

  let summaryTracking = requestedTracking;
  let country = "";
  let lastUpdate = "";
  let latestStatus = "";
  let consignee = "";

  if (summaryRowMatch) {
    summaryTracking = clean(summaryRowMatch[2]) || requestedTracking;
    country = clean(summaryRowMatch[3]);
    lastUpdate = clean(summaryRowMatch[4]);
    latestStatus = clean(summaryRowMatch[5]);
    consignee = clean(summaryRowMatch[6]);
  }

  const eventRegex =
    /<tr>\s*<td[^>]*>\s*([^<]*)<\/td>\s*<td[^>]*>\s*([^<]*)<\/td>\s*<td[^>]*>\s*([\s\S]*?)<\/td>\s*<\/tr>/gi;

  const events = [];
  let match;

  while ((match = eventRegex.exec(html)) !== null) {
    const date = clean(match[1]);
    const location = clean(match[2]);
    const statusRaw = clean(match[3]);

    if (
      date &&
      date !== "日期" &&
      location !== "位置" &&
      statusRaw !== "追踪记录"
    ) {
      events.push({
        date,
        location: translateLocation(location),
        status: translateStatus(statusRaw, lang),
        status_raw: statusRaw
      });
    }
  }

  const translatedLatest = translateStatus(latestStatus, lang);
  const statusCode = inferStatusCode(latestStatus, events);
  const shippedDate = findShippedDate(events);
  const daysSinceShipped = calculateDaysSince(shippedDate);
  const progressStep = inferProgressStep(statusCode, events);

  return {
    tracking_number: summaryTracking || requestedTracking,
    summary: {
      status_code: statusCode,
      status_text: translatedLatest,
      location: events[0]?.location || translateLocation(country) || translate("unknown", lang),
      country: country || translate("unknown", lang),
      last_update: lastUpdate || translate("unknown", lang),
      consignee: consignee || translate("unknown", lang),
      shipped_date: shippedDate || null,
      days_since_shipped: daysSinceShipped,
      progress_step: progressStep
    },
    events
  };
}

function inferStatusCode(status, events = []) {
  const source = [status, ...events.map(e => e.status_raw || e.status)].join(" ").toLowerCase();

  if (
    source.includes("delivered") ||
    source.includes("signed") ||
    source.includes("consegnato")
  ) {
    return "delivered";
  }

  if (
    source.includes("airline") ||
    source.includes("airport") ||
    source.includes("flight") ||
    source.includes("transit") ||
    source.includes("转运") ||
    source.includes("离开") ||
    source.includes("到达") ||
    source.includes("customs") ||
    source.includes("clearance")
  ) {
    return "in_transit";
  }

  if (
    source.includes("package has been packed") ||
    source.includes("handed over") ||
    source.includes("left the operations center") ||
    source.includes("离开操作中心")
  ) {
    return "shipped";
  }

  if (
    source.includes("order information received") ||
    source.includes("received") ||
    source.includes("电子信息")
  ) {
    return "pending";
  }

  return "exception";
}

function inferProgressStep(statusCode, events = []) {
  if (statusCode === "delivered") return 4;
  if (statusCode === "in_transit") return 3;
  if (statusCode === "shipped") return 2;
  if (statusCode === "pending") return 1;

  const source = events.map(e => (e.status_raw || e.status || "")).join(" ").toLowerCase();

  if (source.includes("airline") || source.includes("airport") || source.includes("flight")) return 3;
  if (source.includes("packed") || source.includes("handed over") || source.includes("离开操作中心")) return 2;
  return 1;
}

function findShippedDate(events = []) {
  if (!events.length) return null;

  const shippingKeywords = [
    /package has been packed/i,
    /cargo handed over/i,
    /handed over to airline/i,
    /left the operations center/i,
    /离开操作中心/,
    /delivered to airport/i
  ];

  const oldestFirst = [...events].reverse();

  for (const event of oldestFirst) {
    const raw = (event.status_raw || event.status || "").trim();
    if (shippingKeywords.some(rx => rx.test(raw))) {
      return event.date || null;
    }
  }

  return oldestFirst[0]?.date || null;
}

function calculateDaysSince(dateString) {
  if (!dateString) return null;
  const dt = new Date(dateString.replace(" ", "T"));
  if (Number.isNaN(dt.getTime())) return null;

  const now = new Date();
  const diffMs = now.getTime() - dt.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return days < 0 ? 0 : days;
}

function translateLocation(location) {
  const map = {
    "广州": "Guangzhou"
  };
  return map[location] || location || "";
}

function translateStatus(status, lang) {
  const s = (status || "").trim();

  const translations = [
    {
      match: /Cargo handed over to the airline/i,
      it: "Merce affidata alla compagnia aerea",
      fr: "Colis remis à la compagnie aérienne",
      en: "Cargo handed over to the airline"
    },
    {
      match: /Domestic customs clearance completed/i,
      it: "Sdoganamento nazionale completato",
      fr: "Dédouanement national terminé",
      en: "Domestic customs clearance completed"
    },
    {
      match: /Domestic customs clearance in progress/i,
      it: "Sdoganamento nazionale in corso",
      fr: "Dédouanement national en cours",
      en: "Domestic customs clearance in progress"
    },
    {
      match: /Package has been packed and delivered to airport/i,
      it: "Il pacco è stato preparato e consegnato all’aeroporto",
      fr: "Le colis a été préparé et remis à l’aéroport",
      en: "Package has been packed and delivered to airport"
    },
    {
      match: /Order information received/i,
      it: "Informazioni ordine ricevute. Stiamo aspettando il pacco.",
      fr: "Informations de commande reçues. Nous attendons l’arrivée du colis.",
      en: "Order information received. We're expecting your parcel to arrive with us."
    },
    {
      match: /Awaiting flight assignment/i,
      it: "In attesa dell’assegnazione del volo",
      fr: "En attente d’attribution du vol",
      en: "Awaiting flight assignment"
    },
    {
      match: /Flight ETD/i,
      it: "Partenza stimata del volo",
      fr: "Départ estimé du vol",
      en: "Flight estimated departure"
    },
    {
      match: /The flight has departed/i,
      it: "Il volo è partito",
      fr: "Le vol a décollé",
      en: "The flight has departed"
    },
    {
      match: /Flight ETA/i,
      it: "Arrivo stimato del volo",
      fr: "Arrivée estimée du vol",
      en: "Flight estimated arrival"
    },
    {
      match: /Arrival to the destination airport/i,
      it: "Arrivato all’aeroporto di destinazione",
      fr: "Arrivé à l’aéroport de destination",
      en: "Arrival to the destination airport"
    },
    {
      match: /货物离开操作中心/,
      it: "La merce ha lasciato il centro operativo",
      fr: "Le colis a quitté le centre opérationnel",
      en: "The parcel has left the operations center"
    },
    {
      match: /到达收货点/,
      it: "Arrivato al punto di raccolta",
      fr: "Arrivé au point de collecte",
      en: "Arrived at the receiving point"
    },
    {
      match: /货物电子信息已经收到/,
      it: "Informazioni elettroniche del pacco ricevute",
      fr: "Informations électroniques du colis reçues",
      en: "Electronic shipment information received"
    },
    {
      match: /转运中/i,
      it: "In transito",
      fr: "En transit",
      en: "In transit"
    }
  ];

  for (const item of translations) {
    if (item.match.test(s)) {
      return item[lang] || item.it;
    }
  }

  return s;
}

function translate(key, lang) {
  const dict = {
    missing_number: {
      it: "Numero di tracciamento mancante",
      fr: "Numéro de suivi manquant",
      en: "Missing tracking number"
    },
    unknown: {
      it: "Sconosciuto",
      fr: "Inconnu",
      en: "Unknown"
    }
  };

  return dict[key]?.[lang] || dict[key]?.it || key;
}

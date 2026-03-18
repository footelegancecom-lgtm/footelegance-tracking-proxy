export default async function handler(req, res) {
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

  const matchOne = (regex) => {
    const m = html.match(regex);
    return m ? clean(m[1]) : "";
  };

  // Bloc résumé principal
  const referenceNo = matchOne(/<li class="div_li3" title="([^"]*)">[^<]*<\/li>/);
  const trackingNumber = matchOne(/<li class="div_li3" title="([^"]*)">[^<]*<\/li>/g)?.[1];

  // On prend les lignes de résumé dans l’ordre attendu
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

  // Tableau des événements
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
        status: translateStatus(statusRaw, lang)
      });
    }
  }

  const translatedLatest = translateStatus(latestStatus, lang);
  const statusCode = inferStatusCode(latestStatus);

  return {
    tracking_number: summaryTracking || requestedTracking,
    summary: {
      status_code: statusCode,
      status_text: translatedLatest,
      location: events[0]?.location || translateLocation(country) || translate("unknown", lang),
      country: country || translate("unknown", lang),
      last_update: lastUpdate || translate("unknown", lang),
      consignee: consignee || translate("unknown", lang)
    },
    events
  };
}

function inferStatusCode(status) {
  const s = (status || "").toLowerCase();

  if (
    s.includes("delivered") ||
    s.includes("signed") ||
    s.includes("consegnato")
  ) {
    return "delivered";
  }

  if (
    s.includes("airline") ||
    s.includes("airport") ||
    s.includes("transit") ||
    s.includes("转运") ||
    s.includes("离开") ||
    s.includes("到达") ||
    s.includes("customs") ||
    s.includes("clearance")
  ) {
    return "in_transit";
  }

  if (
    s.includes("order information received") ||
    s.includes("received") ||
    s.includes("电子信息")
  ) {
    return "pending";
  }

  return "exception";
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
      match: /Package has been packed and delivered to airport/i,
      it: "Il pacco è stato préparato e consegnato all’aeroporto",
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
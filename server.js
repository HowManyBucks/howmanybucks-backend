import express from "express";
import cors from "cors";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";

const SERP_API_KEY = process.env.SERP_API_KEY || "";
const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());

// Upload in memoria
const upload = multer();

// ⚙️ Chiavi/endpoint Bing Visual Search (Azure)
const BING_VS_KEY = process.env.BING_VS_KEY || "";
const BING_VS_ENDPOINT =
  process.env.BING_VS_ENDPOINT || "https://api.bing.microsoft.com/v7.0/images/visualsearch";

// 🔁 HEALTH CHECK
app.get("/", (req, res) => res.json({ ok: true, service: "howmanybucks-backend" }));

// 🖼️ /search/image — ricerca PER IMMAGINE (multipart form-data: field "image")
app.post("/search/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing image file (field 'image')" });
    if (!BING_VS_KEY) return res.status(500).json({ error: "BING_VS_KEY missing" });

    // 1) invia l’immagine a Bing Visual Search
    const form = new FormData();
    form.append("image", req.file.buffer, { filename: req.file.originalname || "upload.jpg" });

    const { data } = await axios.post(`${BING_VS_ENDPOINT}?mkt=it-IT`, form, {
      headers: {
        ...form.getHeaders(),
        "Ocp-Apim-Subscription-Key": BING_VS_KEY,
      },
      timeout: 15000,
    });

    // 2) estrai le pagine che includono l’immagine e filtra per domini whitelist
    const items = [];
    const tags = data?.tags || [];
    const whitelistHosts = ["ebay.it", "ebay.fr", "subito.it", "leboncoin.fr"];

    const pushIfWhitelisted = (url, title) => {
      try {
        const host = new URL(url).hostname;
        const ok = whitelistHosts.some((h) => host.includes(h));
        if (!ok) return;

        const txt = `${title || ""}`;
        const m = txt.match(/(\d+(?:[.,]\d{1,2})?)\s?€/);
        const price = m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : 0;
        const country = host.includes("fr") ? "FRANCIA" : "ITALIA";

        items.push({
          source: "ImageSearch",
          country,
          title: title || url,
          description: null,
          price,
          shipping: null,
          currency: "EUR",
          url,
          isNew: /con\s*etichetta|mai\s*usato|sigillat|comme\s*neuf/i.test(txt),
          isAuction: /asta|ench[eè]re|auction|bid/i.test(txt),
        });
      } catch (_) {}
    };

    for (const tag of tags) {
      for (const action of tag.actions || []) {
        // Tipi comuni: PagesIncluding, VisualSearch, ProductVisualSearch, ShoppingSources
        const val = action?.data?.value || action?.data || [];
        if (Array.isArray(val)) {
          for (const v of val) {
            const url = v?.hostPageUrl || v?.webSearchUrl || v?.url;
            const title = v?.name || v?.hostPageDisplayUrl || v?.description;
            if (url) pushIfWhitelisted(url, title);
          }
        }
      }
    }

    return res.json({ items });
  } catch (e) {
    console.error("Image search error", e?.message);
    return res.status(500).json({ error: "Image search failed" });
  }
});

// ▶️ AVVIO
app.listen(PORT, () => console.log(`API listening on :${PORT}`));

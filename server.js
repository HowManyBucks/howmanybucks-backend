import express from "express";
import cors from "cors";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
const upload = multer(); // in memoria

const app = express();
const PORT = process.env.PORT || 8080;

// Abilita CORS (serve per Chrome/app)
app.use(cors());

// Fallback Image/Search via SerpAPI (Google)
// ⚠️ Imposta SERP_API_KEY nell'hosting (vedi step 2)
const SERP_API_KEY = process.env.SERP_API_KEY || "";

app.get("/search/web", async (req, res) => {
  // 🔎 Ricerca PER IMMAGINE via Bing Visual Search
const BING_VS_KEY = process.env.BING_VS_KEY || "";
const BING_VS_ENDPOINT = process.env.BING_VS_ENDPOINT || "https://api.bing.microsoft.com/v7.0/images/visualsearch";

app.post("/search/image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing image file (field 'image')" });
    if (!BING_VS_KEY) return res.status(500).json({ error: "BING_VS_KEY missing" });

    // Invia la foto a Bing Visual Search
    const form = new FormData();
    form.append("image", req.file.buffer, { filename: req.file.originalname || "upload.jpg" });

    const { data } = await axios.post(`${BING_VS_ENDPOINT}?mkt=it-IT`, form, {
      headers: {
        ...form.getHeaders(),
        "Ocp-Apim-Subscription-Key": BING_VS_KEY
      },
      timeout: 15000
    });

    // Estrai “pagine che includono l’immagine” o simili
    const items = [];
    const tags = data?.tags || [];
    const whitelistHosts = ["ebay.it", "ebay.fr", "subito.it", "leboncoin.fr"];

    const pushIfWhitelisted = (url, title) => {
      try {
        const host = new URL(url).hostname;
        const ok = whitelistHosts.some(h => host.includes(h));
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
          isAuction: /asta|ench[eè]re|auction|bid/i.test(txt)
        });
      } catch (_) {}
    };

    for (const tag of tags) {
      for (const action of (tag.actions || [])) {
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

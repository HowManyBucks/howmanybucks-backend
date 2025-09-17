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
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing q" });
  if (!SERP_API_KEY) return res.status(500).json({ error: "SERP_API_KEY missing" });

  try {
    const serpUrl = "https://serpapi.com/search.json";
    const { data } = await axios.get(serpUrl, {
      params: {
        engine: "google",
        q,           // esempio: "Nike Air Max 270 usato site:ebay.it OR site:subito.it"
        num: 20,
        api_key: SERP_API_KEY,
        hl: "it",
        gl: "it"
      },
      timeout: 12000
    });

    // Normalizza risultati in uno schema unico per la tua app
    const items = [];
    const results = data.organic_results || [];
    for (const r of results) {
      try {
        const url = r.link || "";
        const host = new URL(url).hostname;

        // Limita ai domini whitelist
        const ok =
          host.includes("ebay.it") || host.includes("ebay.fr") ||
          host.includes("subito.it") || host.includes("leboncoin.fr");
        if (!ok) continue;

        const title = (r.title || "").toString();
        const snippet = (r.snippet || "").toString();

        // Estrai prezzo se presente nel testo
        const m = snippet.match(/(\d+(?:[.,]\d{1,2})?)\s?€/) || title.match(/(\d+(?:[.,]\d{1,2})?)\s?€/);
        const price = m ? parseFloat(m[1].replace(/\./g, "").replace(",", ".")) : 0;

        items.push({
          source: "GoogleWeb",
          country: host.includes("fr") ? "FRANCIA" : "ITALIA",
          title,
          description: snippet || null,
          price,
          shipping: null,
          currency: "EUR",
          url,
          // Filtri base (lato app rifiltriamo meglio)
          isNew: /con\s*etichetta|mai\s*usato|sigillat|comme\s*neuf|with\s*tag/i.test(`${title} ${snippet}`),
          isAuction: /asta|ench[eè]re|auction|bid/i.test(`${title} ${snippet}`)
        });
      } catch (_) {}
    }

    res.json({ items });
  } catch (e) {
    console.error("SerpAPI error", e?.message);
    res.status(500).json({ error: "SerpAPI failed" });
  }
});

// health check
app.get("/", (req, res) => res.json({ ok: true, service: "howmanybucks-backend" }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));

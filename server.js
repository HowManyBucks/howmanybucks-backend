import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json({ limit: '15mb' }));

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

const ENV = {
  GOOGLE_VISION_API_KEY: process.env.GOOGLE_VISION_API_KEY,
  SERP_API_KEY: process.env.SERP_API_KEY,
  PRICE_COUNTRY: process.env.PRICE_COUNTRY || 'IT',
  PRICE_CURRENCY: process.env.PRICE_CURRENCY || 'EUR',
  MAX_RESULTS_PER_SITE: parseInt(process.env.MAX_RESULTS_PER_SITE || '25', 10),
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* =======================
   TEXT & PRICE UTILITIES
   ======================= */
function extractCandidateQuery({ labels = [], logos = [], text = '' }) {
  const brand = logos[0]?.description || '';
  const strongLabels = labels.filter(l => l.score >= 0.75).map(l => l.description);
  const tokens = (text || '').replace(/\n+/g, ' ').split(/\s+/).filter(t => t.length >= 3).slice(0, 12);

  let query = '';
  if (brand) query = [brand, ...strongLabels.slice(0, 2)].join(' ');
  else if (strongLabels.length) query = strongLabels.slice(0, 3).join(' ');
  else if (tokens.length) query = tokens.slice(0, 4).join(' ');

  const lower = (labels.map(l => l.description.toLowerCase()).join(' ') + ' ' + query.toLowerCase());
  if (/(shirt|t shirt|maglietta|apparel|clothing)/i.test(lower) && !/t-?shirt|maglietta/i.test(query)) {
    query = `${query} t-shirt`.trim();
  }
  return query.trim();
}

function parseMoney(s) {
  if (!s) return null;
  const m = s.replace(/[^\d,.\-]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function robustStats(prices) {
  const arr = prices.filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return { median: null, p25: null, p75: null, filtered: [] };

  const q = (p) => {
    const pos = (arr.length - 1) * p;
    const base = Math.floor(pos), rest = pos - base;
    return arr[base + 1] !== undefined ? arr[base] + rest * (arr[base + 1] - arr[base]) : arr[base];
  };
  const p25 = q(0.25), p50 = q(0.5), p75 = q(0.75), iqr = p75 - p25;
  const lo = p25 - 1.5 * iqr, hi = p75 + 1.5 * iqr;
  const filtered = arr.filter(v => v >= lo && v <= hi);
  const mid = Math.floor(filtered.length / 2);
  const median = filtered.length ? (filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2) : p50;
  return { median, p25, p75, filtered };
}

function humanRound(x) {
  if (!Number.isFinite(x)) return null;
  if (x < 20) return Math.round(x);
  if (x < 100) return Math.round(x / 5) * 5;
  if (x < 200) return Math.round(x / 10) * 10;
  if (x < 500) return Math.round(x / 25) * 25;
  return Math.round(x / 50) * 50;
}

/* =======================
   CONDITION HANDLING
   ======================= */
const NEW_RE = /(NUOV[OA]|CON ETICHETTA|WITH TAGS|SEALED|NEW(?!er)|NWT|BNWT|SIGILLAT[OA])/i;
const USED_RE = /(USAT[OA]|PRE-OWNED|WORN|SECONDA MANO|VINTAGE|SEGNI DI USURA|DIFETT[OI]?)/i;

function classifyConditionText(text) {
  if (NEW_RE.test(text)) return 'new';
  if (USED_RE.test(text)) return 'used';
  return 'unknown';
}

function filterItemsByCondition(items, condition) {
  if (condition === 'auto') return items; // nessun filtro diretto, gestito dopo in adjust
  if (condition !== 'new' && condition !== 'used') return items;

  return items.filter(it => {
    const t = `${it.title || ''} ${it.snippet || ''}`.toUpperCase();
    const cls = classifyConditionText(t);
    if (condition === 'new') return cls === 'new';
    if (condition === 'used') return cls === 'used' || cls === 'unknown';
    return true;
  });
}

/* =======================
   SERPAPI HELPERS
   ======================= */
async function serpSearch({ query, site, num }) {
  const params = new URLSearchParams({
    engine: 'google',
    q: `${query} site:${site}`,
    hl: 'it',
    gl: 'it',
    num: String(num || 10),
    api_key: ENV.SERP_API_KEY
  });
  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const { data } = await axios.get(url, { timeout: 15000 });

  const organic = (data.organic_results || []).map(r => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet,
    price_str: r.price || r.snippet
  }));

  const shopping = (data.shopping_results || []).map(s => ({
    title: s.title,
    link: s.link,
    snippet: `${s.source || ''} ${s.extracted_price ? `€${s.extracted_price}` : ''}`,
    price_str: s.price || (s.extracted_price ? `€${s.extracted_price}` : '')
  }));

  return [...shopping, ...organic];
}

async function serpShoppingGlobal({ query, num }) {
  // Google Shopping globale (non filtrabile per dominio specifico)
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query,
    hl: 'it',
    gl: 'it',
    num: String(num || 20),
    api_key: ENV.SERP_API_KEY
  });
  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const { data } = await axios.get(url, { timeout: 15000 });

  const items = (data.shopping_results || []).map(s => ({
    title: s.title,
    link: s.link,
    snippet: [
      s.source,
      s.shipping ? `Sped: ${s.shipping}` : '',
      s.condition ? `Cond: ${s.condition}` : ''
    ].filter(Boolean).join(' · '),
    price_str: s.price || (s.extracted_price ? `€${s.extracted_price}` : ''),
    condition_hint: (s.condition || '').toLowerCase() // "new", "used" se disponibile
  }));

  return items;
}

function dedupeByLink(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.link) continue;
    const key = it.link.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/* =======================
   ADJUST FOR CONDITION
   ======================= */
function adjustForCondition(prices, items, condition) {
  // Se l'utente indica la condizione, diamo priorità a quella.
  if (condition === 'new' || condition === 'used') {
    const { filtered } = robustStats(prices);
    const baseMedian = robustStats(filtered).median;
    return { suggested: humanRound(baseMedian), baseMedian, newRatio: null, mode: condition };
  }

  // AUTO: stimiamo distribuzione "new-like" vs resto
  const upperText = items.map(i => `${i.title} ${i.snippet || ''}`.toUpperCase());
  const newRatio = upperText.filter(t => NEW_RE.test(t)).length / Math.max(1, upperText.length);

  const { filtered } = robustStats(prices);
  let baseMedian = robustStats(filtered).median;

  if (baseMedian == null) return { suggested: null, baseMedian, newRatio, mode: 'auto' };

  if (newRatio < 0.15) {
    const trimmed = filtered.filter(v => v <= baseMedian * 1.35);
    baseMedian = robustStats(trimmed).median || baseMedian;
  }
  return { suggested: humanRound(baseMedian), baseMedian, newRatio, mode: 'auto' };
}

/* =======================
   ROUTES
   ======================= */
app.post('/search/image', async (req, res) => {
  try {
    const {
      imageBase64,
      includeShopping = false,  // boolean: include Google Shopping via SerpAPI
      condition = 'auto'        // 'new' | 'used' | 'auto'
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'imageBase64 mancante' });
    }

    // 1) Vision → query
    const vision = await googleVisionAnnotate(imageBase64);
    const query = extractCandidateQuery(vision);
    if (!query) {
      return res.json({ success: true, query: null, message: 'Nessuna query ricavabile dalla foto', suggestions: [] });
    }

    // 2) SERP su domini second-hand
    const sites = ['ebay.it', 'www.subito.it']; // estendibile
    const results = [];
    for (const site of sites) {
      try {
        const r = await serpSearch({ query, site, num: ENV.MAX_RESULTS_PER_SITE });
        results.push(...r);
        await sleep(400);
      } catch (e) {
        console.warn(`SERP fallita per ${site}:`, e.message);
      }
    }

    // 3) (Opzionale) Google Shopping globale
    let shoppingItems = [];
    if (includeShopping) {
      try {
        shoppingItems = await serpShoppingGlobal({ query, num: 30 });
      } catch (e) {
        console.warn('Google Shopping fallito:', e.message);
      }
    }

    // 4) Merge + dedupe
    const merged = dedupeByLink([...results, ...shoppingItems]).slice(0, 120);

    // 5) Filtro per condizione richiesta
    const conditioned = filterItemsByCondition(merged, condition);

    // 6) Estrazione prezzi
    const prices = conditioned
      .map(it => parseMoney(it.price_str || it.title || it.snippet))
      .filter(Number.isFinite);

    // 7) Statistica + aggiustamento
    const { suggested, baseMedian, newRatio, mode } = adjustForCondition(prices, conditioned, condition);

    res.json({
      success: true,
      query,
      visionPreview: {
        brand: vision.logos?.[0]?.description || null,
        topLabels: vision.labels?.slice(0, 5).map(l => `${l.description} (${(l.score * 100 | 0)}%)`),
        textHint: vision.text?.slice(0, 120) || null
      },
      params: {
        includeShopping: !!includeShopping,
        condition: mode
      },
      stats: {
        totalFound: merged.length,
        afterCondition: conditioned.length,
        pricedCount: prices.length,
        baseMedian,
        newMentionRatio: newRatio
      },
      suggestedPrice: suggested,
      currency: ENV.PRICE_CURRENCY,
      examples: conditioned.slice(0, 18)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (_, res) => res.send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API avviata su :${PORT}`));

/* =======================
   GOOGLE VISION CALL
   ======================= */
async function googleVisionAnnotate(imageBase64) {
  const body = {
    requests: [{
      image: { content: imageBase64 },
      features: [
        { type: 'LOGO_DETECTION',  maxResults: 3 },
        { type: 'LABEL_DETECTION', maxResults: 10 },
        { type: 'TEXT_DETECTION',  maxResults: 1 }
      ]
    }]
  };
  const { data } = await axios.post(
    `${VISION_ENDPOINT}?key=${encodeURIComponent(ENV.GOOGLE_VISION_API_KEY)}`,
    body,
    { timeout: 12000 }
  );
  const r = data.responses?.[0] || {};
  return {
    labels: r.labelAnnotations || [],
    logos:  r.logoAnnotations  || [],
    text:   r.fullTextAnnotation?.text || r.textAnnotations?.[0]?.description || ''
  };
}

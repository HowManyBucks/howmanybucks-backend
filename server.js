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

/* =======================
   TEXT NORMALIZATION
   ======================= */
const STOPWORDS = new Set([
  // inglese generico per capi/materiali
  'textile','fabric','clothing','apparel','garment','sleeve','long','short','active','sports','men','woman','women','kids',
  'size','sizes','adult','youth','regular','fit','dry','active-dry','performance','top','shirt','tee','tshirt','t-shirt',
  'polyester','cotton','nylon','spandex','elastic','blend','material','composition','label','brand','logo','pattern',
  // italiano generico
  'maglia','maglietta','tessuto','abbigliamento','manica','uomo','donna','bambino','bambina','bimbo','bimba','adulto','ragazzo','ragazza'
]);

const CATEGORY_SYNONYMS = {
  't-shirt': ['t-shirt','tshirt','tee','maglietta'],
  'felpa': ['felpa','hoodie','sweatshirt'],
  'polo': ['polo'],
  'camicia': ['camicia','shirt'],
  'pantaloni': ['pantaloni','trousers','pants'],
};

const PATTERN_SYNONYMS = {
  'righe': ['righe','striped','stripes'],
  'quadri': ['quadri','checked','plaid','tartan'],
  'pois': ['pois','polka','polka-dots','dots'],
  'tinta unita': ['tinta','unita','solid','plain'],
  'mimetico': ['mimetico','camo','camouflage'],
  'floreale': ['floreale','floral'],
};

const NEW_RE = /(NUOV[OA]|CON ETICHETTA|WITH TAGS|SEALED|NEW(?!er)|NWT|BNWT|SIGILLAT[OA])/i;

/* =======================
   SMALL UTILS
   ======================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const norm = s => (s || '')
  .normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function uniq(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) { if (!x) continue; const k = norm(x); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}

function tokenizeKeepBrand(s) {
  return norm(s).split(' ').filter(t => t && !STOPWORDS.has(t));
}

function expandCategory(cat) {
  if (!cat) return [];
  const key = norm(cat);
  for (const k of Object.keys(CATEGORY_SYNONYMS)) {
    if (key.includes(k)) return CATEGORY_SYNONYMS[k];
  }
  return [cat];
}

function expandPattern(pat) {
  if (!pat) return [];
  const key = norm(pat);
  for (const k of Object.keys(PATTERN_SYNONYMS)) {
    if (key.includes(k)) return PATTERN_SYNONYMS[k];
  }
  return [pat];
}

/* =======================
   VISION
   ======================= */
async function googleVisionAnnotate(imageBase64) {
  const body = {
    requests: [{
      image: { content: imageBase64 },
      features: [
        { type: 'LOGO_DETECTION',  maxResults: 3 },
        { type: 'TEXT_DETECTION',  maxResults: 1 },
        { type: 'LABEL_DETECTION', maxResults: 10 }
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

/* =======================
   QUERY BUILDER (PRIORITÀ)
   ======================= */
/**
 * buildCandidateQueries:
 * 1) brand+model(+pattern)+category (FORM)
 * 2) brand(VISION logo)+OCR key bits + category/pattern
 * 3) OCR key bits + category
 * 4) labels pulite + category
 */
function buildCandidateQueries(form, vision) {
  const formBrand  = form.brand ? norm(form.brand) : '';
  const formModel  = form.model ? norm(form.model) : '';
  const formCat    = form.category ? expandCategory(form.category).map(norm) : [];
  const formPat    = form.pattern ? expandPattern(form.pattern).map(norm) : [];

  const logoBrand  = vision.logos?.[0]?.description ? norm(vision.logos[0].description) : '';
  const ocrTokens  = tokenizeKeepBrand(vision.text).slice(0, 6); // primi 6 token utili
  const strongLbls = (vision.labels || [])
    .filter(l => l.score >= 0.80)
    .map(l => l.description)
    .map(norm)
    .filter(t => t && !STOPWORDS.has(t));

  // helper per comporre
  const join = (...parts) => norm(parts.filter(Boolean).join(' '));

  const catToken = formCat[0] || '';     // una sola categoria principale
  const patToken = formPat[0] || '';

  const Q = [];

  // 1) FORM forte
  if (formBrand || formModel) {
    Q.push(join(formBrand, formModel, patToken, catToken));
    Q.push(join(formBrand, formModel, catToken));
    if (formBrand) Q.push(join(formBrand, catToken));
  }

  // 2) LOGO + OCR
  if (logoBrand) {
    Q.push(join(logoBrand, ocrTokens.slice(0,2).join(' '), patToken, catToken));
    Q.push(join(logoBrand, catToken));
  }

  // 3) OCR + categoria
  if (ocrTokens.length) {
    Q.push(join(ocrTokens.slice(0,3).join(' '), catToken));
  }

  // 4) Labels pulite + categoria
  if (strongLbls.length) {
    Q.push(join(strongLbls.slice(0,3).join(' '), catToken));
  }

  // Se non abbiamo nulla, fallback "t-shirt"
  if (!Q.length) Q.push('t-shirt');

  // pulizia: rimuovi duplicati, rimuovi query troppo corte
  return uniq(Q).filter(q => q.split(' ').length >= 1);
}

/* =======================
   SERP HELPERS
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
    title: r.title, link: r.link, snippet: r.snippet, price_str: r.price || r.snippet
  }));

  const shopping = (data.shopping_results || []).map(s => ({
    title: s.title,
    link: s.link,
    snippet: `${s.source || ''} ${s.condition ? `Cond: ${s.condition}` : ''} ${s.shipping ? `Sped: ${s.shipping}` : ''}`,
    price_str: s.price || (s.extracted_price ? `€${s.extracted_price}` : '')
  }));

  return [...shopping, ...organic];
}

async function serpShoppingGlobal({ query, num }) {
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

  return (data.shopping_results || []).map(s => ({
    title: s.title,
    link: s.link,
    snippet: [
      s.source,
      s.condition ? `Cond: ${s.condition}` : '',
      s.shipping ? `Sped: ${s.shipping}` : ''
    ].filter(Boolean).join(' · '),
    price_str: s.price || (s.extracted_price ? `€${s.extracted_price}` : '')
  }));
}

function dedupeByLink(items) {
  const seen = new Set(); const out = [];
  for (const it of items) {
    if (!it.link) continue;
    const key = it.link.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key); out.push(it);
  }
  return out;
}

/* =======================
   PRICE STATS + CONDITION
   ======================= */
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

function applyConditionHeuristic(prices, items, condition) {
  if (condition === 'new' || condition === 'used') {
    const { filtered } = robustStats(prices);
    return { baseMedian: robustStats(filtered).median, mode: condition, newRatio: null };
  }
  const upperText = items.map(i => `${i.title} ${i.snippet || ''}`.toUpperCase());
  const newRatio = upperText.filter(t => NEW_RE.test(t)).length / Math.max(1, upperText.length);
  const { filtered } = robustStats(prices);
  let baseMedian = robustStats(filtered).median;
  if (baseMedian != null && newRatio < 0.15) {
    const trimmed = filtered.filter(v => v <= baseMedian * 1.35);
    baseMedian = robustStats(trimmed).median || baseMedian;
  }
  return { baseMedian, mode: 'auto', newRatio };
}

/* =======================
   MAIN ROUTE
   ======================= */
app.post('/search/image', async (req, res) => {
  try {
    const {
      imageBase64,
      includeShopping = false,      // bool
      condition = 'auto',           // 'new' | 'used' | 'auto'
      // ---- Form fields opzionali ----
      brand = '',                   // MARCA (utente)
      model = '',                   // MODELLO (utente)
      category = 't-shirt',         // categoria macro (t-shirt/felpa/...)
      pattern = ''                  // trama (righe/quadri/pois/...)
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'imageBase64 mancante' });
    }

    // 1) Vision
    const vision = await googleVisionAnnotate(imageBase64);

    // 2) Query candidates (priorità: FORM → LOGO/OCR → LABELS)
    const queries = buildCandidateQueries({ brand, model, category, pattern }, vision);

    const sites = ['ebay.it', 'www.subito.it'];
    let merged = [];
    let usedQuery = null;

    // 3) Prova le query dalla più specifica alla più generica
    for (const q of queries) {
      const step = [];
      for (const site of sites) {
        try {
          const r = await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE });
          step.push(...r);
          await sleep(350);
        } catch (e) { /* ignore single site failure */ }
      }
      if (includeShopping) {
        try {
          step.push(...await serpShoppingGlobal({ query: q, num: 25 }));
        } catch (e) { /* ignore */ }
      }
      const deduped = dedupeByLink(step);
      const priced = deduped.filter(it => parseMoney(it.price_str || it.title || it.snippet) != null);

      // criterio di accettazione: almeno 6 prezzi
      if (priced.length >= 6) {
        merged = deduped;
        usedQuery = q;
        break;
      }
      // altrimenti continua con la prossima query
    }

    // se nessuna query ha raggiunto la soglia, prendi l'ultima provata (comunque qualcosa)
    if (!merged.length) {
      const q = queries[0];
      let fallback = [];
      for (const site of sites) {
        try {
          fallback.push(...await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE }));
        } catch (e) {}
      }
      if (includeShopping) {
        try { fallback.push(...await serpShoppingGlobal({ query: q, num: 25 })); } catch (e) {}
      }
      merged = dedupeByLink(fallback);
      usedQuery = q;
    }

    // 4) Price extraction + condition
    const prices = merged.map(it => parseMoney(it.price_str || it.title || it.snippet)).filter(Number.isFinite);
    const { baseMedian, mode, newRatio } = applyConditionHeuristic(prices, merged, condition);
    const suggested = humanRound(baseMedian);

    res.json({
      success: true,
      queryUsed: usedQuery,
      queriesTried: queries.slice(0, 6),
      visionPreview: {
        brandVision: vision.logos?.[0]?.description || null,
        topLabels: (vision.labels || []).slice(0,5).map(l => `${l.description} (${(l.score*100|0)}%)`),
        textHint: vision.text?.slice(0, 120) || null
      },
      params: { includeShopping: !!includeShopping, condition: mode, form: { brand, model, category, pattern } },
      stats: {
        resultsFound: merged.length,
        pricedCount: prices.length,
        baseMedian,
        newMentionRatio: newRatio
      },
      suggestedPrice: suggested,
      currency: ENV.PRICE_CURRENCY,
      examples: merged.slice(0, 18)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API avviata su :${PORT}`));

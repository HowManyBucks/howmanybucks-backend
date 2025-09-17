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
   LEXICON / NORMALIZATION
   ======================= */
const STOPWORDS = new Set([
  // inglese generico capi/materiali/descrizioni generiche
  'textile','fabric','clothing','apparel','garment','sleeve','long','short','active','sports','sport','athletic',
  'men','man','male','woman','women','female','kids','boy','girl','youth','child','children','unisex',
  'size','sizes','regular','fit','dry','performance','top','shirt','tee','tshirt','t-shirt',
  'polyester','cotton','nylon','spandex','elastane','elastic','blend','material','composition','label','brand','logo','pattern',
  // italiano generico
  'maglia','maglietta','tessuto','abbigliamento','manica','uomo','donna','bambino','bambina','bimbo','bimba',
  'adulto','ragazzo','ragazza'
]);

const CATEGORY_SYNONYMS = {
  't-shirt': ['t-shirt','tshirt','tee','maglietta'],
  'felpa': ['felpa','hoodie','sweatshirt'],
  'polo': ['polo'],
  'camicia': ['camicia','shirt'],
  'pantaloni': ['pantaloni','trousers','pants'],
  'shorts': ['shorts','bermuda'],
  'gonna': ['gonna','skirt'],
  'vestito': ['vestito','dress'],
};

const PATTERN_SYNONYMS = {
  // IT → EN (molti pattern comuni moda)
  'righe': ['righe','rigato','a righe','striped','stripes','pinstripe'],
  'quadri': ['quadri','a quadri','checked','check','plaid','tartan','gingham','houndstooth'],
  'pois': ['pois','polka dot','polka','dots','dotted'],
  'mimetico': ['mimetico','camo','camouflage'],
  'floreale': ['floreale','floral','flower'],
  'tinta unita': ['tinta unita','solid','plain','monochrome','single color','mono'],
  'animalier': ['animalier','leopard','zebra','tiger','snake','pyton','cheetah'],
  'geometrico': ['geometrico','geometric','abstract'],
  'fantasia': ['fantasia','patterned','print','printed','allover'],
  'tie dye': ['tie dye','tiedye','batik'],
  'paillettes': ['paillettes','sequins','sequin'],
  'jacquard': ['jacquard'],
  'texture': ['texture','waffle','ribbed','a costine','costine','knit','cable knit','piqué','pique','mesh'],
  'logo': ['logo','monogram','brand allover','logato'],
};

const GENDER_MAP = {
  uomo: ['uomo','men','man','male','maschile'],
  donna: ['donna','women','woman','female','femmina','femminile'],
  unisex: ['unisex','uni'],
  kids: ['bambino','bambina','bimbo','bimba','kid','kids','child','children','youth','boy','girl'],
};

const BASIC_COLORS = {
  nero: [0,0,0], bianco: [255,255,255], grigio: [128,128,128],
  rosso: [200,30,30], arancione: [255,140,0], giallo: [255,215,0],
  verde: [30,160,60], blu: [40,80,200], azzurro: [80,180,255],
  viola: [140,70,170], rosa: [240,130,170], marrone: [120,72,0],
  beige: [220,200,160]
};

const NEW_RE = /(NUOV[OA]|CON ETICHETTA|WITH TAGS|SEALED|NEW(?!er)|NWT|BNWT|SIGILLAT[OA])/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '')
  .normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

function uniq(arr) { const out = []; const seen = new Set();
  for (const x of arr) { const k = norm(x); if (!k || seen.has(k)) continue; seen.add(k); out.push(x.trim()); }
  return out;
}
function tokenizeKeep(s) { return norm(s).split(' ').filter(t => t && !STOPWORDS.has(t)); }

function expandCategory(cat) {
  if (!cat) return [];
  const key = norm(cat);
  for (const k of Object.keys(CATEGORY_SYNONYMS)) if (key.includes(k)) return CATEGORY_SYNONYMS[k];
  return [cat];
}
function expandPattern(pat) {
  if (!pat) return [];
  const key = norm(pat);
  for (const k of Object.keys(PATTERN_SYNONYMS)) if (key.includes(k)) return PATTERN_SYNONYMS[k];
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
        { type: 'LABEL_DETECTION', maxResults: 10 },
        { type: 'IMAGE_PROPERTIES', maxResults: 1 }
      ]
    }]
  };
  const { data } = await axios.post(
    `${VISION_ENDPOINT}?key=${encodeURIComponent(ENV.GOOGLE_VISION_API_KEY)}`,
    body,
    { timeout: 12000 }
  );
  const r = data.responses?.[0] || {};
  const colors = r.imagePropertiesAnnotation?.dominantColors?.colors || [];
  return {
    labels: r.labelAnnotations || [],
    logos:  r.logoAnnotations  || [],
    text:   r.fullTextAnnotation?.text || r.textAnnotations?.[0]?.description || '',
    colors
  };
}

function nearestBasicColorName(rgb) {
  const [r,g,b] = rgb;
  let best = 'nero', bestD = Infinity;
  for (const [name, [R,G,B]] of Object.entries(BASIC_COLORS)) {
    const d = (R-r)**2 + (G-g)**2 + (B-b)**2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}
function colorFromVision(colors) {
  if (!colors?.length) return null;
  // prendi il colore con score maggiore
  const top = [...colors].sort((a,b)=> (b.score||0)-(a.score||0))[0];
  const r = Math.round(top.color?.red || 0);
  const g = Math.round(top.color?.green || 0);
  const b = Math.round(top.color?.blue || 0);
  return nearestBasicColorName([r,g,b]);
}

/* =======================
   QUERY BUILDER (PRIORITÀ)
   ======================= */
function buildCandidateQueries(form, vision) {
  const formBrand  = form.brand ? norm(form.brand) : '';
  const formModel  = form.model ? norm(form.model) : '';
  const formCat    = form.category ? expandCategory(form.category).map(norm) : [];
  const formPat    = form.pattern ? expandPattern(form.pattern).map(norm) : [];
  const formGender = form.gender ? norm(form.gender) : ''; // uomo/donna/unisex/kids
  const formColor  = form.color ? norm(form.color) : '';

  const logoBrand  = vision.logos?.[0]?.description ? norm(vision.logos[0].description) : '';
  const ocrTokens  = tokenizeKeep(vision.text).slice(0, 6);
  const strongLbls = (vision.labels || [])
    .filter(l => l.score >= 0.80)
    .map(l => norm(l.description))
    .filter(t => t && !STOPWORDS.has(t));

  const visionColor = colorFromVision(vision.colors);
  const colorToken  = formColor || visionColor || '';

  const catToken = formCat[0] || '';     // prendi la più importante
  const patToken = formPat[0] || '';

  const J = (...parts) => norm(parts.filter(Boolean).join(' '));
  const Q = [];

  // (1) FORM super-specifico
  if (formBrand || formModel) {
    Q.push(J(formBrand, formModel, patToken, colorToken, formGender, catToken));
    Q.push(J(formBrand, formModel, colorToken, catToken));
    Q.push(J(formBrand, formModel, catToken));
    if (formBrand) Q.push(J(formBrand, colorToken, catToken));
  }

  // (2) LOGO + OCR
  if (logoBrand) {
    Q.push(J(logoBrand, ocrTokens.slice(0,2).join(' '), colorToken, formGender, catToken));
    Q.push(J(logoBrand, colorToken, catToken));
    Q.push(J(logoBrand, catToken));
  }

  // (3) OCR + categoria
  if (ocrTokens.length) {
    Q.push(J(ocrTokens.slice(0,3).join(' '), colorToken, formGender, catToken));
  }

  // (4) Labels + categoria
  if (strongLbls.length) {
    Q.push(J(strongLbls.slice(0,3).join(' '), colorToken, formGender, catToken));
  }

  // (5) fallback
  if (!Q.length) Q.push('t-shirt');

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
   SCORING & FILTERS
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

// Score in 0..100
function scoreItem(it, ctx) {
  const title = norm(`${it.title || ''} ${it.snippet || ''}`);
  let s = 0;

  if (ctx.brand && title.includes(norm(ctx.brand))) s += 26; // forte
  if (ctx.model && title.includes(norm(ctx.model))) s += 20;
  if (ctx.color && title.includes(norm(ctx.color))) s += 6;

  // gender boost/penalty
  if (ctx.gender) {
    const g = norm(ctx.gender);
    const G = {
      uomo: GENDER_MAP.uomo.some(t => title.includes(t)),
      donna: GENDER_MAP.donna.some(t => title.includes(t)),
      kids: GENDER_MAP.kids.some(t => title.includes(t)),
      unisex: title.includes('unisex')
    };
    if (g === 'uomo' && (G.uomo || G.unisex)) s += 6;
    if (g === 'donna' && (G.donna || G.unisex)) s += 6;
    if (g === 'kids' && G.kids) s += 6;
    // penalità soft se mismatch chiaro
    if (g === 'uomo' && G.donna) s -= 8;
    if (g === 'donna' && G.uomo) s -= 8;
    if (g !== 'kids' && G.kids) s -= 6;
  }

  // micro-boost se contiene category token
  if (ctx.category && title.includes(norm(ctx.category))) s += 3;
  return Math.max(0, Math.min(100, s));
}

/* =======================
   CONDITION HEURISTIC
   ======================= */
const NEW_HINT = /(NUOV[OA]|CON ETICHETTA|WITH TAGS|SEALED|NEW(?!er)|NWT|BNWT|SIGILLAT[OA])/i;

function applyConditionHeuristic(prices, items, condition) {
  if (condition === 'new' || condition === 'used') {
    const { filtered } = robustStats(prices);
    return { baseMedian: robustStats(filtered).median, mode: condition, newRatio: null };
  }
  const upperText = items.map(i => `${i.title} ${i.snippet || ''}`.toUpperCase());
  const newRatio = upperText.filter(t => NEW_HINT.test(t)).length / Math.max(1, upperText.length);
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
      includeShopping = false,
      condition = 'auto',       // 'new' | 'used' | 'auto'
      // ---- Form fields opzionali ----
      brand = '',
      model = '',
      category = 't-shirt',
      pattern = '',
      gender = '',              // uomo | donna | unisex | kids
      color = ''                // preferito dall’utente (es. "rosso"), se vuoto useremo Vision
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'imageBase64 mancante' });
    }

    // 1) Vision
    const vision = await googleVisionAnnotate(imageBase64);

    // 2) Query candidates (priorità: FORM → LOGO/OCR → LABELS)
    const queries = buildCandidateQueries(
      { brand, model, category, pattern, gender, color },
      vision
    );

    const sites = ['ebay.it', 'www.subito.it'];
    let merged = [];
    let usedQuery = null;

    // 3) Prova query dalla più specifica alla più generica finché abbiamo abbastanza prezzi
    for (const q of queries) {
      const step = [];
      for (const site of sites) {
        try {
          const r = await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE });
          step.push(...r);
          await sleep(300);
        } catch {}
      }
      if (includeShopping) {
        try { step.push(...await serpShoppingGlobal({ query: q, num: 25 })); } catch {}
      }
      const deduped = dedupeByLink(step);
      const priced = deduped.filter(it => parseMoney(it.price_str || it.title || it.snippet) != null);
      if (priced.length >= 6) { merged = deduped; usedQuery = q; break; }
    }
    if (!merged.length) {
      // fallback: usa la prima query comunque
      const q = queries[0];
      let fb = [];
      for (const site of sites) { try { fb.push(...await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE })); } catch {} }
      if (includeShopping) { try { fb.push(...await serpShoppingGlobal({ query: q, num: 25 })); } catch {} }
      merged = dedupeByLink(fb);
      usedQuery = q;
    }

    // 4) Scoring → re-ranking (brand/model/color/gender)
    const ctx = {
      brand, model,
      color: color || colorFromVision(vision.colors) || '',
      gender, category
    };
    const ranked = [...merged].map(it => ({ ...it, _score: scoreItem(it, ctx) }))
                              .sort((a,b) => b._score - a._score);

    // 5) Estrai prezzi dai top N (più pertinenti)
    const TOP_N = 40;
    const topForPricing = ranked.slice(0, TOP_N);
    const prices = topForPricing.map(it => parseMoney(it.price_str || it.title || it.snippet)).filter(Number.isFinite);

    // 6) Statistica + condizione
    const { baseMedian, mode, newRatio } = applyConditionHeuristic(prices, topForPricing, condition);
    const suggested = humanRound(baseMedian);

    res.json({
      success: true,
      queryUsed: usedQuery,
      queriesTried: queries.slice(0, 8),
      visionPreview: {
        brandVision: vision.logos?.[0]?.description || null,
        topLabels: (vision.labels || []).slice(0,5).map(l => `${l.description} (${(l.score*100|0)}%)`),
        textHint: vision.text?.slice(0, 120) || null,
        colorGuess: colorFromVision(vision.colors) || null
      },
      params: { includeShopping: !!includeShopping, condition: mode, form: { brand, model, category, pattern, gender, color: ctx.color } },
      stats: {
        resultsFound: merged.length,
        rankedTopUsed: Math.min(merged.length, TOP_N),
        pricedCount: prices.length,
        baseMedian,
        newMentionRatio: newRatio
      },
      suggestedPrice: suggested,
      currency: ENV.PRICE_CURRENCY,
      examples: ranked.slice(0, 18)  // i primi 18 già ordinati per punteggio
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (_, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API avviata su :${PORT}`));

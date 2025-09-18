import express from 'express';
import axios from 'axios';
import cors from 'cors';
import fs from 'fs';

const app = express();

// CORS per Flutter web (qualsiasi porta localhost/127.0.0.1) + dominio prod
app.use(cors({
  origin: [
    /^http:\/\/localhost:\d+$/,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    'https://howmanybucks.com',
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));
app.options('*', cors());

// JSON parser
app.use(express.json({ limit: '15mb' }));

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

const ENV = {
  GOOGLE_VISION_API_KEY: process.env.GOOGLE_VISION_API_KEY,
  SERP_API_KEY: process.env.SERP_API_KEY,
  PRICE_COUNTRY: process.env.PRICE_COUNTRY || 'IT',
  PRICE_CURRENCY: process.env.PRICE_CURRENCY || 'EUR',
  MAX_RESULTS_PER_SITE: parseInt(process.env.MAX_RESULTS_PER_SITE || '25', 10),
  MARKETPLACES_CONFIG_PATH: process.env.MARKETPLACES_CONFIG_PATH || './marketplaces_config.json',
};

// ============ CONFIG MARKETPLACES ============
let MP = { countries: {}, continents: {}, blacklist_domains: [] };
try {
  const raw = fs.readFileSync(ENV.MARKETPLACES_CONFIG_PATH, 'utf-8');
  MP = JSON.parse(raw);
  console.log('[CONFIG] marketplaces_config.json caricato.');
} catch (e) {
  console.warn('[CONFIG] marketplaces_config.json non trovato: uso fallback minimo IT.');
  MP = {
    countries: {
      IT: {
        hl: 'it', gl: 'it',
        sites: [
          { domain: 'ebay.it', type: 'general', weight: 0.9 },
          { domain: 'www.subito.it', type: 'classifieds', weight: 1.0 },
          { domain: 'www.vinted.it', type: 'apparel', weight: 1.0 },
          { domain: 'www.depop.com', type: 'apparel', weight: 0.8 },
        ]
      }
    },
    continents: {},
    blacklist_domains: ['pinterest.*','www.youtube.com','m.youtube.com','twitter.com','x.com','www.reddit.com','www.wikipedia.org']
  };
}

// ============ UTILS ============
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const norm = s => (s || '')
  .normalize('NFKD')
  .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const containsWord = (hay, needle) => {
  if (!hay || !needle) return false;
  const H = ` ${norm(hay)} `;
  const N = ` ${norm(needle)} `;
  return H.includes(N);
};
const uniq = arr => {
  const out = []; const seen = new Set();
  for (const x of arr) { const k = norm(x); if (!k || seen.has(k)) continue; seen.add(k); out.push(x.trim()); }
  return out;
};
function domainOf(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname.replace(/^www\./,'');
  } catch {
    const m = (urlStr || '').match(/https?:\/\/([^\/]+)/i);
    return m ? m[1].replace(/^www\./,'') : '';
  }
}

// ============ LEXICON / NORMALIZATION ============
const STOPWORDS = new Set([
  'textile','fabric','clothing','apparel','garment','sleeve','long','short','active','sports','sport','athletic',
  'men','man','male','woman','women','female','kids','boy','girl','youth','child','children','unisex',
  'size','sizes','regular','fit','dry','performance','top','shirt','tee','tshirt','t-shirt',
  'polyester','cotton','nylon','spandex','elastane','elastic','blend','material','composition','label','brand','logo','pattern',
  'maglia','maglietta','tessuto','abbigliamento','manica','uomo','donna','bambino','bambina','bimbo','bimba','adulto','ragazzo','ragazza'
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
  donna: ['donna','women','woman','female','femminile'],
  unisex: ['unisex','uni'],
  kids: ['bambino','bambina','bimbo','bimba','kid','kids','child','children','youth','boy','girl'],
};
const BASIC_COLORS = {
  nero:[0,0,0], bianco:[255,255,255], grigio:[128,128,128], rosso:[200,30,30], arancione:[255,140,0],
  giallo:[255,215,0], verde:[30,160,60], blu:[40,80,200], azzurro:[80,180,255], viola:[140,70,170],
  rosa:[240,130,170], marrone:[120,72,0], beige:[220,200,160]
};
const NEW_HINT = /(NUOV[OA]|CON ETICHETTA|WITH TAGS|SEALED|NEW(?!er)|NWT|BNWT|SIGILLAT[OA])/i;

const tokenizeKeep = s => norm(s).split(' ').filter(t => t && !STOPWORDS.has(t));
const expandCategory = cat => {
  if (!cat) return [];
  const key = norm(cat);
  for (const k of Object.keys(CATEGORY_SYNONYMS)) if (key.includes(k)) return CATEGORY_SYNONYMS[k];
  return [cat];
};
const expandPattern = pat => {
  if (!pat) return [];
  const key = norm(pat);
  for (const k of Object.keys(PATTERN_SYNONYMS)) if (key.includes(k)) return PATTERN_SYNONYMS[k];
  return [pat];
};
const nearestBasicColorName = rgb => {
  const [r,g,b] = rgb; let best='nero', bestD=Infinity;
  for (const [name,[R,G,B]] of Object.entries(BASIC_COLORS)) {
    const d = (R-r)**2 + (G-g)**2 + (B-b)**2; if (d<bestD){bestD=d; best=name;}
  }
  return best;
};

// ============ VISION ============
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
const colorFromVision = colors => {
  if (!colors?.length) return null;
  const top = [...colors].sort((a,b)=> (b.score||0)-(a.score||0))[0];
  const r = Math.round(top.color?.red || 0), g = Math.round(top.color?.green || 0), b = Math.round(top.color?.blue || 0);
  return nearestBasicColorName([r,g,b]);
};

// ============ QUERY BUILDER (precedenza: marca form > marca+modello > marca+logo > logo) ============
function buildCandidateQueries(form, vision) {
  const formBrand  = form.brand ? norm(form.brand) : '';
  const formModel  = form.model ? norm(form.model) : '';
  const formCat    = form.category ? expandCategory(form.category).map(norm) : [];
  const formPat    = form.pattern ? expandPattern(form.pattern).map(norm) : [];
  const formGender = form.gender ? norm(form.gender) : '';
  const formColor  = form.color ? norm(form.color) : '';

  const logoBrand  = vision.logos?.[0]?.description ? norm(vision.logos[0].description) : '';
  const ocrTokens  = tokenizeKeep(vision.text).slice(0, 6);
  const strongLbls = (vision.labels || [])
    .filter(l => l.score >= 0.80)
    .map(l => norm(l.description))
    .filter(t => t && !STOPWORDS.has(t));

  const visionColor = colorFromVision(vision.colors);
  const colorToken  = formColor || visionColor || '';
  const catToken = formCat[0] || '';
  const patToken = formPat[0] || '';
  const J = (...parts) => norm(parts.filter(Boolean).join(' '));

  const Q = [];

  // 1) marca form (forte)
  if (formBrand) {
    // 2) marca + modello
    if (formModel) {
      Q.push(J(formBrand, formModel, patToken, colorToken, formGender, catToken));
      Q.push(J(formBrand, formModel, colorToken, catToken));
      Q.push(J(formBrand, formModel, catToken));
    }
    // 3) marca form + logo vision (se diverso, come arricchimento)
    if (logoBrand && logoBrand !== formBrand) {
      Q.push(J(formBrand, logoBrand, colorToken, catToken));
    }
    // marca secca + contesti
    Q.push(J(formBrand, patToken, colorToken, formGender, catToken));
    Q.push(J(formBrand, colorToken, catToken));
    Q.push(J(formBrand, catToken));
  }

  // 4) solo logo vision (se non c'è marca form)
  if (!formBrand && logoBrand) {
    Q.push(J(logoBrand, ocrTokens.slice(0,2).join(' '), colorToken, formGender, catToken));
    Q.push(J(logoBrand, colorToken, catToken));
    Q.push(J(logoBrand, catToken));
  }

  // OCR/labels come supporto
  if (ocrTokens.length) Q.push(J(ocrTokens.slice(0,3).join(' '), colorToken, formGender, catToken));
  if (strongLbls.length) Q.push(J(strongLbls.slice(0,3).join(' '), colorToken, formGender, catToken));

  if (!Q.length) Q.push('t-shirt');
  const queries = uniq(Q).filter(q => q.split(' ').length >= 1);
  const brandResolved = formBrand || logoBrand || '';
  return { queries, brandResolved };
}

// ============ SERP HELPERS ============
async function serpSearch({ query, site, num, hl='it', gl='it' }) {
  const params = new URLSearchParams({
    engine: 'google',
    q: `${query} site:${site}`,
    hl, gl, num: String(num || 10),
    api_key: ENV.SERP_API_KEY
  });
  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const { data } = await axios.get(url, { timeout: 15000 });

  const organic = (data.organic_results || []).map(r => ({
    title: r.title, link: r.link, snippet: r.snippet, price_str: r.price || r.snippet
  }));
  const shopping = (data.shopping_results || []).map(s => ({
    title: s.title, link: s.link,
    snippet: `${s.source || ''} ${s.condition ? `Cond: ${s.condition}` : ''} ${s.shipping ? `Sped: ${s.shipping}` : ''}`,
    price_str: s.price || (s.extracted_price ? `€${s.extracted_price}` : '')
  }));
  return [...shopping, ...organic];
}
async function serpShoppingGlobal({ query, num, hl='it', gl='it' }) {
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: query, hl, gl, num: String(num || 20),
    api_key: ENV.SERP_API_KEY
  });
  const url = `https://serpapi.com/search.json?${params.toString()}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return (data.shopping_results || []).map(s => ({
    title: s.title, link: s.link,
    snippet: [s.source, s.condition ? `Cond: ${s.condition}` : '', s.shipping ? `Sped: ${s.shipping}` : '']
      .filter(Boolean).join(' · '),
    price_str: s.price || (s.extracted_price ? `€${s.extracted_price}` : '')
  }));
}
const dedupeByLink = items => {
  const seen = new Set(); const out = [];
  for (const it of items) {
    if (!it.link) continue;
    const key = it.link.split('?')[0];
    if (seen.has(key)) continue;
    seen.add(key); out.push(it);
  }
  return out;
};

// ============ SCORING & PRICE ============
const parseMoney = s => {
  if (!s) return null;
  const m = s.replace(/[^\d,.\-]/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
function robustStats(prices) {
  const arr = prices.filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return { median: null, p25: null, p75: null, filtered: [] };
  const q = (p) => { const pos = (arr.length - 1) * p; const base = Math.floor(pos), rest = pos - base;
    return arr[base + 1] !== undefined ? arr[base] + rest * (arr[base + 1] - arr[base]) : arr[base]; };
  const p25 = q(0.25), p50 = q(0.5), p75 = q(0.75), iqr = p75 - p25;
  const lo = p25 - 1.5 * iqr, hi = p75 + 1.5 * iqr;
  const filtered = arr.filter(v => v >= lo && v <= hi);
  const mid = Math.floor(filtered.length / 2);
  const median = filtered.length ? (filtered.length % 2 ? filtered[mid] : (filtered[mid - 1] + filtered[mid]) / 2) : p50;
  return { median, p25, p75, filtered };
}
const humanRound = x => {
  if (!Number.isFinite(x)) return null;
  if (x < 20) return Math.round(x);
  if (x < 100) return Math.round(x / 5) * 5;
  if (x < 200) return Math.round(x / 10) * 10;
  if (x < 500) return Math.round(x / 25) * 25;
  return Math.round(x / 50) * 50;
};

function scoreItem(it, ctx) {
  const title = norm(`${it.title || ''} ${it.snippet || ''}`);
  let s = 0;

  // Boost forti su brand/modello
  if (ctx.brand && containsWord(title, ctx.brand)) s += 40;
  if (ctx.model && containsWord(title, ctx.model)) s += 28;

  if (ctx.color && containsWord(title, ctx.color)) s += 6;

  if (ctx.gender) {
    const G = {
      uomo: GENDER_MAP.uomo.some(t => title.includes(t)),
      donna: GENDER_MAP.donna.some(t => title.includes(t)),
      kids: GENDER_MAP.kids.some(t => title.includes(t)),
      unisex: title.includes('unisex')
    };
    if (ctx.gender === 'uomo' && (G.uomo || G.unisex)) s += 6;
    if (ctx.gender === 'donna' && (G.donna || G.unisex)) s += 6;
    if (ctx.gender === 'kids' && G.kids) s += 6;
    if (ctx.gender === 'uomo' && G.donna) s -= 10;
    if (ctx.gender === 'donna' && G.uomo) s -= 10;
    if (ctx.gender !== 'kids' && G.kids) s -= 6;
  }
  if (ctx.category && containsWord(title, ctx.category)) s += 4;

  // Penalità: se nel form c'è brand, penalizza altri brand noti
  if (ctx.brand) {
    const notThisBrand = ['nike','adidas','puma','reebok','new balance','under armour','levi','h&m','zara','gucci','prada','armani','dolce',
      'diesel','fila','kappa','the north face','north face','patagonia','ralph lauren','lacoste','superdry','harley davidson']
      .filter(b => b !== norm(ctx.brand));
    if (notThisBrand.some(b => containsWord(title, b))) s -= 25;
  }

  // Boost sito locale
  const d = domainOf(it.link);
  const w = ctx.siteWeights[d] || 0;
  s += Math.min(8, Math.round(w * 6));

  return Math.max(0, Math.min(100, s));
}

// ============ CONTEXT ============
function getSearchContext({ country, continent }) {
  if (country && MP.countries[country]) {
    const { hl, gl, sites } = MP.countries[country];
    const sorted = [...sites].sort((a,b)=> (b.weight||0)-(a.weight||0));
    const siteList = sorted.map(s => s.domain);
    const siteWeights = Object.fromEntries(sorted.map(s => [s.domain.replace(/^www\./,''), s.weight||0]));
    return { hl, gl, siteList, siteWeights };
  }
  if (continent && MP.continents[continent]) {
    const byDomain = {};
    for (const n of MP.continents[continent]) {
      const key = n.domain.replace(/^www\./,'');
      const w = n.weight || 0;
      byDomain[key] = Math.max(byDomain[key] || 0, w);
    }
    const sorted = Object.entries(byDomain).sort((a,b)=> b[1]-a[1]).slice(0, 8);
    const siteList = sorted.map(([d]) => d);
    const siteWeights = Object.fromEntries(sorted);
    const fallback = MP.countries[ENV.PRICE_COUNTRY] || { hl:'en', gl:'us' };
    return { hl: fallback.hl, gl: fallback.gl, siteList, siteWeights };
  }
  const fb = MP.countries[ENV.PRICE_COUNTRY] || { hl:'en', gl:'us', sites: [] };
  const sorted = (fb.sites||[]).sort((a,b)=> (b.weight||0)-(a.weight||0));
  const siteList = sorted.map(s => s.domain);
  const siteWeights = Object.fromEntries(sorted.map(s => [s.domain.replace(/^www\./,''), s.weight||0]));
  return { hl: fb.hl || 'en', gl: fb.gl || 'us', siteList, siteWeights };
}
const isBlacklisted = (host) => {
  const h = (host||'').toLowerCase();
  return MP.blacklist_domains.some(b => {
    if (b.endsWith('.*')) {
      const base = b.slice(0, -2);
      return h === base || h.endsWith('.'+base) || h.includes(base);
    }
    return h === b || h.endsWith('.'+b);
  });
};

// ============ ROUTES ============
app.get('/', (_, res) => {
  res.type('html').send(`
    <h1>HOWMANYBUCKS – Backend</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li>POST /search/image – JSON con <code>imageBase64</code> (+ campi form)</li>
    </ul>
  `);
});

app.get('/health', (_, res) => res.send('OK'));

app.post('/search/image', async (req, res) => {
  try {
    const {
      imageBase64,
      includeShopping = false,
      condition = 'auto',
      // Form utente
      brand = '', model = '', category = 't-shirt', pattern = '',
      gender = '', color = '',
      // Scope geografico
      country = '',
      continent = '',
      // K (facoltativo)
      kFactor = null
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'imageBase64 mancante' });
    }

    // 0) contesto paesi/siti
    const ctxGeo = getSearchContext({ country, continent });
    const { hl, gl, siteList, siteWeights } = ctxGeo;
    const TOP_SITES = Math.min(siteList.length, 6);

    // 1) Vision
    const vision = await googleVisionAnnotate(imageBase64);

    // 2) Query candidates + brandResolved
    const qb = buildCandidateQueries({ brand, model, category, pattern, gender, color }, vision);
    const queries = qb.queries;
    const brandResolved = qb.brandResolved;

    let merged = [];
    let usedQuery = null;

    // 3) Prova query dalla più specifica
    for (const q of queries) {
      const step = [];
      for (const site of siteList.slice(0, TOP_SITES)) {
        try {
          const r = await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE, hl, gl });
          step.push(...r);
          await sleep(300);
        } catch (e) { /* ignora singolo sito */ }
      }
      if (includeShopping) {
        try {
          const shop = await serpShoppingGlobal({ query: q, num: 25, hl, gl });
          const shopFiltered = shop.filter(it => !isBlacklisted(domainOf(it.link)));
          step.push(...shopFiltered);
        } catch {}
      }
      const deduped = dedupeByLink(step);
      const priced = deduped.filter(it => parseMoney(it.price_str || it.title || it.snippet) != null);
      if (priced.length >= 6) { merged = deduped; usedQuery = q; break; }
    }

    if (!merged.length) {
      const q = queries[0];
      let fb = [];
      for (const site of siteList.slice(0, TOP_SITES)) {
        try { fb.push(...await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE, hl, gl })); } catch {}
      }
      if (includeShopping) {
        try {
          const shop = await serpShoppingGlobal({ query: q, num: 25, hl, gl });
          fb.push(...shop.filter(it => !isBlacklisted(domainOf(it.link))));
        } catch {}
      }
      merged = dedupeByLink(fb);
      usedQuery = q;
    }

    // 4) Filtra non-whitelist e blacklist
    const whiteSet = new Set(siteList.map(s => s.replace(/^www\./,'')));
    const filteredWL = merged.filter(it => {
      const d = domainOf(it.link);
      if (!d) return false;
      if (isBlacklisted(d)) return false;
      return whiteSet.has(d.replace(/^www\./,'')) || includeShopping;
    });

    // 4b) Hard filter sul brand se specificato (con fallback se troppo stretto)
    let filteredStrict = filteredWL;
    if (brand) {
      filteredStrict = filteredWL.filter(it => {
        const t = `${it.title||''} ${it.snippet||''}`;
        return containsWord(t, brand);
      });
      if (filteredStrict.length < 6) filteredStrict = filteredWL;
    }

    // 5) Re-ranking
    const contextScore = {
      brand, model, gender, color: color || colorFromVision(vision.colors) || '', category,
      siteWeights: Object.fromEntries([...whiteSet].map(d => [d, siteWeights[d] || 0]))
    };
    const ranked = [...filteredStrict].map(it => ({ ...it, _score: scoreItem(it, contextScore) }))
                                      .sort((a,b) => b._score - a._score);

    // 6) Prezzi
    const TOP_N = 40;
    const topForPricing = ranked.slice(0, TOP_N);
    const prices = topForPricing.map(it => parseMoney(it.price_str || it.title || it.snippet)).filter(Number.isFinite);
    const { baseMedian, mode, newRatio } = applyConditionHeuristic(prices, topForPricing, condition);
    const suggested = humanRound(baseMedian);

    // kFactor
    const kVal = (kFactor !== null && !isNaN(Number(kFactor))) ? Number(kFactor) : null;
    const suggestedPriceAdjusted = (kVal && suggested) ? humanRound(suggested * kVal) : suggested;

    res.json({
      success: true,
      geo: { hl, gl, countryUsed: country || ENV.PRICE_COUNTRY, continentUsed: continent || null, sitesQueried: siteList.slice(0, TOP_SITES) },
      brandResolved,
      queryUsed: usedQuery,
      queriesTried: queries.slice(0, 8),
      visionPreview: {
        brandVision: vision.logos?.[0]?.description || null,
        topLabels: (vision.labels || []).slice(0,5).map(l => `${l.description} (${(l.score*100|0)}%)`),
        textHint: vision.text?.slice(0, 120) || null,
        colorGuess: colorFromVision(vision.colors) || null
      },
      params: { includeShopping: !!includeShopping, condition: mode, form: { brand, model, category, pattern, gender, color: contextScore.color }, kFactor: kVal },
      note: (!brand && !model) ? 'Per un’analisi più puntuale, indica marca e/o modello nel form.' : null,
      stats: {
        resultsFound: merged.length,
        afterWhitelist: filteredWL.length,
        afterBrandFilter: filteredStrict.length,
        rankedTopUsed: Math.min(filteredStrict.length, TOP_N),
        pricedCount: prices.length,
        baseMedian,
        newMentionRatio: newRatio
      },
      suggestedPrice: suggested,
      suggestedPriceAdjusted,
      currency: ENV.PRICE_CURRENCY,
      examples: ranked.slice(0, 18)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API avviata su :${PORT}`));

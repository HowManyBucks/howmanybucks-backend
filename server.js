import express from 'express';
import axios from 'axios';
import cors from 'cors';
import fs from 'fs';

const app = express();
const TMP_IMAGE_DIR = '/tmp/howmanybucks_uploads';
const TMP_IMAGE_ROUTE = '/tmp-images';
const TMP_IMAGE_TTL_MS = 5 * 60 * 1000; // 5 minuti

try {
  fs.mkdirSync(TMP_IMAGE_DIR, { recursive: true });
  console.log('[TMP] cartella immagini temporanee pronta:', TMP_IMAGE_DIR);
} catch (e) {
  console.warn('[TMP] errore creazione cartella temporanea:', e.message);
}

app.use(TMP_IMAGE_ROUTE, express.static(TMP_IMAGE_DIR));
function stripBase64Prefix(imageBase64 = '') {
  return String(imageBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
}
function saveTempImageAndGetUrl(req, imageBase64) {
  const cleanBase64 = stripBase64Prefix(imageBase64);
  const fileName = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const filePath = `${TMP_IMAGE_DIR}/${fileName}`;
  fs.writeFileSync(filePath, Buffer.from(cleanBase64, 'base64'));
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('[TMP] immagine eliminata:', fileName);
      }
    } catch (e) {
      console.warn('[TMP] errore eliminazione immagine:', e.message);
    }
  }, TMP_IMAGE_TTL_MS);
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const publicUrl = `${baseUrl}${TMP_IMAGE_ROUTE}/${fileName}`;
  console.log('[TMP] immagine temporanea creata:', publicUrl);
  return {
    fileName,
    filePath,
    publicUrl,
  };
}
const APPAREL_EXCLUDED_TERMS = [
  'case', 'cover', 'phone', 'charger', 'cable', 'lace', 'laces',
  'sock', 'socks', 'belt', 'keychain', 'sticker',
  'watch', 'strap', 'bag', 'wallet', 'perfume'
];
function isExcludedApparelResult(text = '') {
  const t = String(text).toLowerCase();
  return APPAREL_EXCLUDED_TERMS.some(term => t.includes(term));
}
function matchesApparelCategory(text = '', finalCategory = '') {
const t = String(text).toLowerCase();
const c = String(finalCategory).toLowerCase();
if (!c) return true;
const map = {
    't-shirt': ['t-shirt', 'tee', 'shirt', 'short sleeve', 'maglietta'],
    'hoodie': ['hoodie', 'sweatshirt', 'felpa'],
    'jacket': ['jacket', 'coat', 'blazer', 'giacca', 'piumino'],
    'jeans': ['jeans', 'denim'],
    'shirt': ['shirt', 'button down', 'button-up', 'camicia'],
    'dress': ['dress', 'gown', 'vestito'],
    'skirt': ['skirt', 'gonna'],
    'sweater': ['sweater', 'knit', 'pullover', 'maglione', 'cardigan'],
    'polo': ['polo'],
    'shoe': [
      'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers',
      'running shoe', 'basketball shoe', 'skate shoe', 'scarpa', 'scarpe'
    ],
    'hat': ['hat', 'cap', 'cappello', 'cappellino', 'beanie', 'snapback'],
    'sneaker': [
      'shoe', 'shoes', 'sneaker', 'sneakers', 'trainer', 'trainers',
      'running shoe', 'basketball shoe', 'skate shoe', 'scarpa', 'scarpe'
    ],
  };

  const keywords = map[c] || [c];
  return keywords.some(k => t.includes(k)); 
}

// CORS: localhost (qualsiasi porta) + dominio prod
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
  STRICT_BRAND_DEFAULT: (process.env.STRICT_BRAND || 'true').toLowerCase() === 'true',
};

// ===== CONFIG MARKETPLACES =====
let MP = { countries: {}, continents: {}, blacklist_domains: [] };
try {
  const raw = fs.readFileSync(ENV.MARKETPLACES_CONFIG_PATH, 'utf-8');
  MP = JSON.parse(raw);
  console.log('[CONFIG] marketplaces_config.json caricato.');
} catch {
  console.warn('[CONFIG] marketplaces_config.json non trovato: fallback IT.');
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

// ===== UTILS =====
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
function buildVisualHintSignals(items = [], brandSignals = [], categorySignals = []) {
  const generic = new Set([
    ...Array.from(STOPWORDS),
    'new', 'used', 'mens', 'men', 'womens', 'women',
    'size', 'sizes', 'authentic', 'original', 'retro',
    'black', 'white', 'red', 'blue', 'green', 'brown',
    ...brandSignals.map(norm),
    ...categorySignals.map(norm),
  ]);
  const freq = new Map();
  for (const it of items) {
    const tokens = norm(`${it.title || ''} ${it.snippet || ''}`)
      .split(' ')
      .filter(Boolean)
      .filter(t => t.length >= 3)
      .filter(t => !generic.has(t))
      .filter(t => !/^\d+$/.test(t) || /^\d{3,6}$/.test(t));
    for (const t of tokens) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
const STOP_WORDS_EXTRA = [
  'with', 'and', 'the', 'for', 'this', 'that',
  'john', 'man', 'woman'
];

return [...freq.entries()]
  .filter(([_, count]) => count >= 2)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 6)
  .map(([token]) => token)
  .filter(t => t.length > 2 && !STOP_WORDS_EXTRA.includes(t));
  
}

function domainOf(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname.replace(/^www\./,'');
  } catch {
    const m = (urlStr || '').match(/https?:\/\/([^\/]+)/i);
    return m ? m[1].replace(/^www\./,'') : '';
  }
}

// ===== GEMINI ANALYZE =====

async function analyzeItemWithGemini(imageBase64) {
  try {
    const cleanBase64 = stripBase64Prefix(imageBase64);
    console.log('BASE64 LENGTH:', cleanBase64.length);
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Analizza questa immagine di un capo di abbigliamento.
        Rispondi SOLO in JSON valido senza testo extra.
        Formato:
        {
          "brand": "...",
          "model": "...",
          "category": "...",
          "color": "..."
        }`
                  },
                  {
                    inline_data: {
                      mime_type: "image/jpeg",
                      data: cleanBase64
                  }
                }
              ]
            }
          ]
        })
        
      
      }
    );
    const data = await response.json();
    
    console.log('GEMINI FULL RESPONSE:', JSON.stringify(data));  
    
    const parts = data?.candidates?.[0]?.content?.parts || [];
  
    const rawText = parts
      .map(p => p.text || '')
      .join(' ')
      .trim();
  
console.log('GEMINI RAW FULL:', rawText);
console.log('GEMINI RAW:', rawText);
console.log('RAW LENGTH:', rawText.length);
    
let parsed;
    
try {
  const cleaned = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  console.log('GEMINI CLEANED:', cleaned);
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found');
  }
  parsed = JSON.parse(jsonMatch[0]);
} catch (e) {
  console.warn('GEMINI PARSE FALLBACK:', rawText);
  parsed = {
    brand: "Non identificato",
    model: "Non identificato",
    category: "Non identificato",
    color: "Non identificato"
  };
}

return parsed;
} catch (err) {
    console.error('GEMINI ERROR:', err.message);
    return {
      brand: "Non identificato",
      model: "Non identificato",
      category: "Non identificato",
      color: "Non identificato"
    };
  }
}

// ===== LEXICON =====
const STOPWORDS = new Set([
  'textile','fabric','clothing','apparel','garment','sleeve','long','short','active','sports','sport','athletic',
  'men','man','male','woman','women','female','kids','boy','girl','youth','child','children','unisex',
  'size','sizes','regular','fit','dry','performance','top','shirt','tee','tshirt','t-shirt',
  'polyester','cotton','nylon','spandex','elastane','elastic','blend','material','composition','label','brand','logo','pattern',
  'maglia','maglietta','tessuto','abbigliamento','manica','uomo','donna','bambino','bambina','bimbo','bimba','adulto','ragazzo','ragazza'
]);
const CATEGORY_SYNONYMS = {
  't-shirt': ['t-shirt','tshirt','tee','maglietta','shirt'],
  'felpa': ['felpa','hoodie','sweatshirt'],
  'polo': ['polo'],
  'camicia': ['camicia','shirt','button down','button-up'],
  'pantaloni': ['pantaloni','trousers','pants'],
  'shorts': ['shorts','bermuda'],
  'gonna': ['gonna','skirt'],
  'vestito': ['vestito','dress'],
  'jacket': ['jacket','coat','giacca','blazer'],
  'jeans': ['jeans','denim'],
  'sweater': ['sweater','maglione','pullover','cardigan'],
  'shoe': [
    'shoe','shoes','scarpa','scarpe','sneaker','sneakers',
    'trainer','trainers','running shoe','basketball shoe',
    'skate shoe'
  ],
  'sneaker': [
    'shoe','shoes','scarpa','scarpe','sneaker','sneakers',
    'trainer','trainers','running shoe','basketball shoe',
    'skate shoe'
  ],
  'hat': ['hat', 'cap', 'cappello', 'cappellino', 'beanie', 'snapback', 'visor'],
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

// ===== VISION =====
async function googleVisionAnnotate(imageBase64) {
  console.log("VISION_FN_HIT");
  const body = {
    requests: [{
      image: { content: imageBase64 },
      features: [
        { type: 'LOGO_DETECTION',  maxResults: 10 },
        { type: 'TEXT_DETECTION',  maxResults: 10 },
        { type: 'LABEL_DETECTION', maxResults: 5 },
        { type: 'IMAGE_PROPERTIES', maxResults: 10 }
      ]
    }]
  };
  const { data } = await axios.post(
    `${VISION_ENDPOINT}?key=${encodeURIComponent(ENV.GOOGLE_VISION_API_KEY)}`,
    body,
    { timeout: 12000 }
  );

  console.log("VISION RAW:", JSON.stringify(data).slice(0, 800));
  
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

// ===== QUERY BUILDER (precedenza: marca form > marca+modello > marca+logo > logo) =====
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

  if (formBrand) {
    if (formModel) {
      Q.push(J(formBrand, formModel, patToken, colorToken, formGender, catToken));
      Q.push(J(formBrand, formModel, colorToken, catToken));
      Q.push(J(formBrand, formModel, catToken));
    }
    if (logoBrand && logoBrand !== formBrand) {
      Q.push(J(formBrand, logoBrand, colorToken, catToken));
    }
    Q.push(J(formBrand, patToken, colorToken, formGender, catToken));
    Q.push(J(formBrand, colorToken, catToken));
    Q.push(J(formBrand, catToken));
  }

  if (!formBrand && logoBrand) {
    Q.push(J(logoBrand, ocrTokens.slice(0,2).join(' '), colorToken, formGender, catToken));
    Q.push(J(logoBrand, colorToken, catToken));
    Q.push(J(logoBrand, catToken));
  }

  if (ocrTokens.length) Q.push(J(ocrTokens.slice(0,3).join(' '), colorToken, formGender, catToken));
  if (strongLbls.length) Q.push(J(strongLbls.slice(0,3).join(' '), colorToken, formGender, catToken));

  if (!Q.length) Q.push('t-shirt');
  const queries = uniq(Q).filter(q => q.split(' ').length >= 1);
  const brandResolved = formBrand || logoBrand || '';
  return { queries, brandResolved };
}

// ===== SERP HELPERS =====
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

// ===== SCORING & PRICE =====
const parseMoney = s => {
  if (s === null || s === undefined) return null;
  // Se arriva un numero, usalo direttamente
  if (typeof s === 'number') {
    return Number.isFinite(s) ? s : null;
  }
  // Se arriva un oggetto, prova a leggere campi tipici prezzo
  if (typeof s === 'object') {
    const candidate =
      s.price ??
      s.value ??
      s.amount ??
      s.extracted_price ??
      null;
    if (candidate === null || candidate === undefined) return null;
    s = String(candidate);
  }
  // Qualsiasi altro caso → forza a stringa
  s = String(s);
  const m = s
    .replace(/[^\d,.\-]/g, '')
    .replace(',', '.')
    .match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};function robustStats(prices) {
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
  if (ctx.brand) {
    const notThisBrand = ['nike','adidas','puma','reebok','new balance','under armour','levi','h&m','zara','gucci','prada','armani','dolce',
      'diesel','fila','kappa','the north face','north face','patagonia','ralph lauren','lacoste','superdry','harley davidson']
      .filter(b => b !== norm(ctx.brand));
    if (notThisBrand.some(b => containsWord(title, b))) s -= 25;
  }
  const d = domainOf(it.link);
  const w = ctx.siteWeights[d] || 0;
  s += Math.min(8, Math.round(w * 6));
  return Math.max(0, Math.min(100, s));
}

// ===== CONDITION HEURISTIC =====
function percentile(arr, p) {
  const values = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  if (values.length === 1) return values[0];

  const idx = (values.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);

  if (lo === hi) return values[lo];

  const weight = idx - lo;
  return values[lo] * (1 - weight) + values[hi] * weight;
}
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

// ===== CONTEXT (paese/siti) =====
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
      const key = n.domain.replace(/^www\./,''); const w = n.weight || 0;
      byDomain[key] = Math.max(byDomain[key] || 0, w);
    }
    const sorted = Object.entries(byDomain).sort((a,b)=> b[1]-a[1]).slice(0, 8);
    const siteList = sorted.map(([d]) => d);
    const siteWeights = Object.fromEntries(sorted);
    const fb = MP.countries[ENV.PRICE_COUNTRY] || { hl:'en', gl:'us' };
    return { hl: fb.hl, gl: fb.gl, siteList, siteWeights };
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

// 🔵 FUNZIONE ESTRAZIONE INFO PRODOTTO

function extractBrandClusterFromTitles(candidateTitles = []) {
  const BRAND_DICTIONARY = [
    'nike', 'adidas', 'puma', 'reebok', 'new balance', 'asics', 'converse', 'vans',
    'under armour', 'the north face', 'north face', 'patagonia', 'superdry',
    'harley davidson', 'levi\'s', 'levis', 'diesel', 'fila', 'kappa', 'lacoste',
    'ralph lauren', 'polo ralph lauren', 'tommy hilfiger', 'calvin klein',
    'zara', 'h&m', 'hm', 'uniqlo', 'gucci', 'prada', 'armani', 'emporio armani',
    'giorgio armani', 'dolce & gabbana', 'd&g', 'balenciaga', 'louis vuitton',
    'valentino', 'fendi', 'burberry', 'moncler', 'off-white', 'stone island',
    'borsalino'
  ];
  
  const counts = new Map();
 
  for (const rawTitle of candidateTitles) {
    const title = String(rawTitle || '').toLowerCase();
  
    for (const brand of BRAND_DICTIONARY) {
      if (title.includes(brand)) {
        counts.set(brand, (counts.get(brand) || 0) + 1);
      }
    }
  }
 
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  
  if (!ranked.length) {
    return {
      brand: 'Non identificata',
      matches: [],
    };
  }

  const [topBrand, topCount] = ranked[0];
  
  if (topCount < 2) {
    return {
      brand: 'Non identificata',
      matches: ranked,
    };
  }
  return {
    brand: topBrand.toUpperCase(),
    matches: ranked,
  };
}

function extractProductInfo({
  labelAnnotations = [],
  logoAnnotations = [],
  text = '',
  candidateTitles = [],
  visionColors = [],
}) {
  const labels = labelAnnotations.map(l => (l.description || '').toLowerCase());
  const logos = logoAnnotations.map(l => (l.description || '').toLowerCase());
  const ocrText = String(text || '').toLowerCase();
  const titlesText = candidateTitles.join(' ').toLowerCase();
  const searchText = [labels.join(' '), logos.join(' '), ocrText, titlesText].join(' ');

  // 🔹 TIPOLGIA
  let category = "Non identificata";
  if (searchText.includes("shoe") || searchText.includes("sneaker")) category = "Scarpe";
  if (searchText.includes("shirt") || searchText.includes("t-shirt")) category = "Maglietta";
  if (searchText.includes("hoodie") || searchText.includes("sweatshirt")) category = "Felpa";
  if (
    searchText.includes("hat") ||
    searchText.includes("cap") ||
    searchText.includes("cappello") ||
    searchText.includes("cappellino") ||
    searchText.includes("beanie") ||
    searchText.includes("snapback")
  ) category = "Cappello";
  
    // 🔹 TESTI NORMALIZZATI
  const tokens = searchText
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);

  const uniqueTitles = candidateTitles
    .map(t => String(t || '').trim())
    .filter(Boolean);
  
  const brandCluster = extractBrandClusterFromTitles(uniqueTitles);
  
  // 🔹 BRAND CANDIDATES
  const BRAND_DICTIONARY = [
    'nike', 'adidas', 'puma', 'reebok', 'new balance', 'asics', 'converse', 'vans',
    'under armour', 'the north face', 'north face', 'patagonia', 'superdry',
    'harley davidson', 'levi\'s', 'levis', 'diesel', 'fila', 'kappa', 'lacoste',
    'ralph lauren', 'polo ralph lauren', 'tommy hilfiger', 'calvin klein',
    'zara', 'h&m', 'hm', 'uniqlo', 'gucci', 'prada', 'armani', 'emporio armani',
    'giorgio armani', 'dolce & gabbana', 'd&g', 'balenciaga', 'louis vuitton',
    'valentino', 'fendi', 'burberry', 'moncler', 'off-white', 'stone island'
  ];

  const brandScores = new Map();

  function addBrandScore(name, score) {
    if (!name) return;
    const key = name.toLowerCase();
    brandScores.set(key, (brandScores.get(key) || 0) + score);
  }

  // 1) priorità ai loghi Vision
  for (const logo of logos) {
    for (const brandName of BRAND_DICTIONARY) {
      if (logo.includes(brandName)) addBrandScore(brandName, 100);
    }
  }

  // 2) OCR + labels + titoli
  for (const brandName of BRAND_DICTIONARY) {
    if (searchText.includes(brandName)) addBrandScore(brandName, 30);
  }

  // 3) bonus se compare nei titoli più di una volta
  for (const brandName of BRAND_DICTIONARY) {
    let count = 0;
    for (const title of uniqueTitles) {
      if (title.toLowerCase().includes(brandName)) count++;
    }
    if (count > 0) addBrandScore(brandName, count * 20);
  }
  const topTitles = uniqueTitles.slice(0, 2);

  for (const brandName of BRAND_DICTIONARY) {
    let topCount = 0;
    for (const title of topTitles) {
      if (title.toLowerCase().includes(brandName)) topCount++;
    }
    if (topCount > 0) addBrandScore(brandName, topCount * 40);
  }
  // 🔷 BRAND E MODEL DA TITOLI LENS / ANNUNCI
const titleTokenFreq = new Map();

for (const title of uniqueTitles) {
  const cleaned = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t.length >= 2);

  for (const token of cleaned) {
    titleTokenFreq.set(token, (titleTokenFreq.get(token) || 0) + 1);
  }
}

const sortedTitleTokens = [...titleTokenFreq.entries()]
  .sort((a, b) => b[1] - a[1]);

const genericTokens = new Set([
  'new', 'used', 'uomo', 'donna', 'men', 'women',
  'shoe', 'shoes', 'scarpa', 'scarpe', 'sneaker', 'sneakers',
  'shirt', 't-shirt', 'tee', 'hoodie', 'felpa',
  'red', 'black', 'white', 'blue', 'green', 'brown', 'beige',
  'natural', 'color', 'straw', 'woven', 'baseball',
  'hat', 'cap', 'cappello', 'cappellino', 'beanie', 'snapback',
  'taglia', 'size', 'eu', 'us'
]);

let dynamicBrandCandidate = null;

for (const [token, count] of sortedTitleTokens) {
  if (count < 2) continue;
  if (genericTokens.has(token)) continue;
  if (/^\d+$/.test(token)) continue;
  dynamicBrandCandidate = token;
  break;
}
  
  let brand = "Non identificata";
  if (brandCluster.brand !== "Non identificata") {
    brand = brandCluster.brand;
  } else if (brandScores.size) {
    const topBrand = [...brandScores.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];
    brand = topBrand.toUpperCase();
  }
  
// 🔷 BRAND CLEAN — ricostruzione multi-parola dai titoli
if (brand !== "Non identificata") {
  const comboFreq = new Map();
 
  for (const title of uniqueTitles) {
    const words = title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s\/\-]/gu, ' ')
      .replace(/[\/\-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  
    const brandLower = brand.toLowerCase();
    const idx = words.findIndex(w => w === brandLower);
   
    if (idx >= 0 && words[idx + 1]) {
      const combo2 = `${words[idx]} ${words[idx + 1]}`.trim();
      comboFreq.set(combo2, (comboFreq.get(combo2) || 0) + 1);
     
      if (words[idx + 2]) {
        const combo3 = `${words[idx]} ${words[idx + 1]} ${words[idx + 2]}`.trim();
        comboFreq.set(combo3, (comboFreq.get(combo3) || 0) + 1);
      }
    }
  }
  if (comboFreq.size) {
    const bestCombo = [...comboFreq.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];
   
    const comboWords = bestCombo.split(' ');
    
    const badSecondWord = new Set([
      'shirt', 't', 'tee', 'hoodie', 'felpa', 'shoe', 'scarpa',
      'red', 'black', 'white', 'blue', 'green', 'brown',
      'new', 'used', 'vintage'
    ]);
    
    if (
      comboWords.length >= 2 &&
      !badSecondWord.has(comboWords[1])
    ) {
      brand = bestCombo.toUpperCase();
    }
  }
}
  
const brandLower = brand.toLowerCase();

const modelPhraseFreq = new Map();

for (const title of uniqueTitles) {
  const lower = title.toLowerCase();
  const words = lower
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const brandIndex = words.findIndex(w => w === brandLower);
  if (brandIndex >= 0) {
    const phrase = words.slice(brandIndex + 1, brandIndex + 4).join(' ').trim();
    if (phrase && phrase.length >= 3) {
      modelPhraseFreq.set(phrase, (modelPhraseFreq.get(phrase) || 0) + 1);
    }
  }
}

let dynamicModelCandidate = null;
if (modelPhraseFreq.size) {
  dynamicModelCandidate = [...modelPhraseFreq.entries()]
    .sort((a, b) => b[1] - a[1])[0][0];
}
  // 🔹 MODELLO
  let model = "Non identificato";

  const MODEL_BLACKLIST = new Set([
    'nike', 'adidas', 'puma', 'reebok', 'shoe', 'shoes', 'sneaker', 'sneakers',
    'scarpa', 'scarpe', 'shirt', 't-shirt', 'hoodie', 'felpa', 'rosso', 'red',
    'black', 'white', 'blue', 'green', 'new', 'used', 'man', 'woman', 'uomo', 'donna'
  ]);

  const modelCandidates = [];

  // 1) pattern forti nei titoli
  const strongModelPatterns = [
    /\bair force 1\b/gi,
    /\bair max(?:\s?[a-z0-9]+)?\b/gi,
    /\bdunk(?:\s+low|\s+high|\s+sb)?\b/gi,
    /\b574\b/g,
    /\b550\b/g,
    /\b9060\b/g,
    /\b2002r\b/gi,
    /\b530\b/g,
    /\bct[0-9]{3,6}\b/gi,
    /\bdq[0-9]{3,6}\b/gi,
    /\bdm[0-9]{3,6}\b/gi,
    /\bsku[:\s]?[a-z0-9\-]{4,20}\b/gi,
    /\b[a-z]{1,5}[0-9]{2,6}[a-z]?\b/gi,
    /\b[0-9]{3,6}\b/g
  ];

  for (const title of uniqueTitles) {
    const lowerTitle = title.toLowerCase();

    for (const pattern of strongModelPatterns) {
      const matches = lowerTitle.match(pattern);
      if (matches) {
        for (const m of matches) {
          const cleaned = m.trim();
          if (!MODEL_BLACKLIST.has(cleaned)) {
            modelCandidates.push(cleaned);
          }
        }
      }
    }
  }

  // 2) OCR come supporto
  for (const pattern of strongModelPatterns) {
    const matches = ocrText.match(pattern);
    if (matches) {
      for (const m of matches) {
        const cleaned = m.trim();
        if (!MODEL_BLACKLIST.has(cleaned)) {
          modelCandidates.push(cleaned);
        }
      }
    }
  }

  // 3) ranking modello per frequenza
 if (dynamicModelCandidate) {
  model = dynamicModelCandidate;
} else if (modelCandidates.length) {
  const freq = new Map();
  for (const m of modelCandidates) {
    freq.set(m, (freq.get(m) || 0) + 1);
  }
  model = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// pulizia finale modello
if (brand !== "Non identificata" && model !== "Non identificato") {
  const brandWords = brand.toLowerCase().split(' ');
  const modelWords = model.toLowerCase().split(' ').filter(Boolean);

  const cleanedModelWords = modelWords.filter(w => !brandWords.includes(w));

  const modelStopWords = new Set([
    'shirt', 't', 'tee', 'tshirt', 't-shirt', 'maglietta',
    'hoodie', 'felpa', 'shoe', 'scarpa', 'sneaker',
    'red', 'black', 'white', 'blue', 'green', 'brown',
    'new', 'used', 'vintage'
  ]);

  const finalModelWords = cleanedModelWords.filter(w => !modelStopWords.has(w));

  model = finalModelWords.length ? finalModelWords.join(' ') : 'Non identificato';
}

// 🔷 COLORE (VISION FIRST + SOGLIA 33,01%)
let color = "Non identificato";

// 1) prova con colore dominante Vision
if (visionColors.length) {
  const sortedColors = [...visionColors].sort(
    (a, b) => (b.pixelFraction || 0) - (a.pixelFraction || 0)
  );

  const top = sortedColors[0];

  if ((top.pixelFraction || 0) > 0.3301) {
    const red = Math.round(top.color?.red || 0);
    const green = Math.round(top.color?.green || 0);
    const blue = Math.round(top.color?.blue || 0);

    if (red > 200 && green > 200 && blue > 200) color = "Bianco";
    else if (red < 60 && green < 60 && blue < 60) color = "Nero";
    else if (red > 150 && green > 100 && blue < 90) color = "Marrone";
    else if (red > green && red > blue) color = "Rosso";
    else if (green > red && green > blue) color = "Verde";
    else if (blue > red && blue > green) color = "Blu";
    else if (red > 200 && green > 200 && blue < 120) color = "Giallo";
    else if (red > 200 && blue > 150 && green < 180) color = "Rosa";
    else if (red > 150 && green > 120 && blue > 150) color = "Viola";
    else if (red > 120 && green > 120 && blue > 120) color = "Grigio";
    else if (red > 180 && green > 160 && blue > 120) color = "Beige";
  }
}

// 2) fallback su labels/testo solo se Vision non basta
if (color === "Non identificato") {
  const colorKeywords = {
    black: "Nero",
    white: "Bianco",
    red: "Rosso",
    blue: "Blu",
    green: "Verde",
    brown: "Marrone",
    grey: "Grigio",
    gray: "Grigio",
    beige: "Beige",
    yellow: "Giallo",
    pink: "Rosa",
    orange: "Arancione",
  };

  let labelColor = null;
  for (const key in colorKeywords) {
    if (searchText.includes(key)) {
      labelColor = colorKeywords[key];
      break;
    }
  }

  if (labelColor) {
    color = labelColor;
  }
}

console.log('BRAND CLUSTER:', brandCluster);
const knownBrandWords = new Set([
  'nike', 'adidas', 'puma', 'reebok', 'new', 'balance', 'asics', 'converse',
  'vans', 'under', 'armour', 'patagonia', 'superdry', 'harley', 'davidson',
  'levis', 'levi', 'diesel', 'fila', 'kappa', 'lacoste', 'ralph', 'lauren',
  'tommy', 'hilfiger', 'calvin', 'klein', 'zara', 'hm', 'uniqlo', 'gucci',
  'prada', 'armani', 'emporio', 'giorgio', 'dolce', 'gabbana', 'balenciaga',
  'louis', 'vuitton', 'valentino', 'fendi', 'burberry', 'moncler',
  'off', 'white', 'stone', 'island'
]);
  
if (brand !== "Non identificata" && model !== "Non identificato") {
  const brandWords = brand
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  
  const modelWords = model
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  
  const extraBrandWords = brandWords.filter(w => !knownBrandWords.has(w));
  
  if (extraBrandWords.length) {
    const cleanedBrandWords = brandWords.filter(w => knownBrandWords.has(w));
    const rebuiltModelWords = [...extraBrandWords, ...modelWords];
    
    if (cleanedBrandWords.length) {
      brand = cleanedBrandWords.join(' ').toUpperCase();
      model = rebuiltModelWords.join(' ');
    }
  }
}
return {
  category,
  brand,
  model,
  color,
};
} 
// ===== ROUTES =====
app.get('/', (_, res) => {
  res.type('html').send(`<h1>HOWMANYBUCKS – Backend</h1>
  <ul>
    <li><a href="/health">/health</a></li>
    <li>POST /search/image</li>
  </ul>`);
});

app.get('/health', (_, res) => res.send('OK'));

app.post('/analyze-item', async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'imageBase64 mancante'
      });
    }
    const analysis = await analyzeItemWithGemini(imageBase64);
    console.log('GEMINI ANALYSIS:', analysis);
    return res.json({
      success: true,
      analysis
    });
  } catch (err) {
    console.error('ANALYZE ITEM ERROR:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
function normalizeTitleForMatch(title = '') {
  return String(title)
    .toLowerCase()
    .replace(/[\/\-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function extractSignalsFromTitle(title = '') {
  const t = normalizeTitleForMatch(title);
  const detectCategory = () => {
    if (/(hat|cap|cappello|cappellino|beanie|snapback|visor)\b/.test(t)) return 'hat';
    if (/(shoe|shoes|scarpa|scarpe|sneaker|sneakers|trainer|trainers)\b/.test(t)) return 'shoe';
    if (/(hoodie|sweatshirt|felpa)\b/.test(t)) return 'hoodie';
    if (/(shirt|t shirt|tshirt|tee|maglietta|camicia|polo)\b/.test(t)) return 'shirt';
    if (/(jacket|coat|giacca|blazer|piumino)\b/.test(t)) return 'jacket';
    return '';
  };
  const colors = [];
  const colorMap = [
    ['black', 'nero'], ['white', 'bianco'], ['red', 'rosso'], ['blue', 'blu'],
    ['green', 'verde'], ['brown', 'marrone'], ['grey', 'grigio'], ['gray', 'grigio'],
    ['beige', 'beige'], ['pink', 'rosa'], ['yellow', 'giallo'], ['orange', 'arancione'],
    ['navy', 'blu'], ['tan', 'beige']
  ];
  for (const [en, it] of colorMap) {
    if (t.includes(en) || t.includes(it)) colors.push(it);
  }
  return {
    normalized: t,
    category: detectCategory(),
    colors: [...new Set(colors)],
  };
}
function titlesMatchTop2(a, b) {
  const A = extractSignalsFromTitle(a);
  const B = extractSignalsFromTitle(b);
  let score = 0;
  if (A.category && B.category && A.category === B.category) score += 3;
  const sharedColors = A.colors.filter(c => B.colors.includes(c));
  if (sharedColors.length) score += 2;
  const aWords = A.normalized.split(' ').filter(w => w.length >= 3);
  const bWords = B.normalized.split(' ').filter(w => w.length >= 3);
  const stop = new Set([
    'new', 'used', 'vintage', 'uomo', 'donna', 'men', 'women',
    'hat', 'cap', 'cappello', 'cappellino', 'beanie', 'snapback',
    'shirt', 't', 'tee', 'tshirt', 'shoe', 'scarpa', 'sneaker',
    'black', 'white', 'red', 'blue', 'green', 'brown', 'grey', 'gray',
    'nero', 'bianco', 'rosso', 'blu', 'verde', 'marrone', 'grigio'
  ]);
  const aCore = aWords.filter(w => !stop.has(w));
  const bCore = bWords.filter(w => !stop.has(w));
  const sharedCore = aCore.filter(w => bCore.includes(w));
  if (sharedCore.length >= 1) score += 2;
  if (sharedCore.length >= 2) score += 2;
  return {
    ok: score >= 5,
    score,
    sharedCore,
    categoryA: A.category,
    categoryB: B.category,
    colorsA: A.colors,
    colorsB: B.colors,
  };
}
app.post('/search/image', async (req, res) => {
  try {
    console.log("SEARCH_IMAGE_HIT");
    const {
      imageBase64,
      includeShopping = false,
      condition = 'auto',
      brand = '', model = '', category = '', pattern = '',
      gender = '', color = '',
      country = '', continent = '',
      kFactor = null,
      strictBrand: strictBrandFromClient = null,
    } = req.body || {};
console.log("IMAGE LENGTH:", imageBase64 ? imageBase64.length : "NULL");
console.log("IMAGE HEAD:", imageBase64 ? imageBase64.slice(0, 30) : "NULL");
console.log("IMAGE LENGTH:", imageBase64 ? imageBase64.length : "NULL");
    if (!imageBase64) {
      return res.status(400).json({ success: false, error: 'imageBase64 mancante' });
    }

const geminiAnalysis = await analyzeItemWithGemini(imageBase64);
console.log('SEARCH IMAGE - GEMINI ANALYSIS:', geminiAnalysis);

const cleanAiValue = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  if (
    low === 'non identificato' ||
    low === 'non identificata' ||
    low === 'n/a' ||
    low === 'na' ||
    low === 'null' ||
    low === 'undefined' ||
    low === 'unknown'
  ) {
    return '';
  }
  return s;
};

const aiBrand = cleanAiValue(geminiAnalysis?.brand);
const aiModel = cleanAiValue(geminiAnalysis?.model);
const aiCategory = cleanAiValue(geminiAnalysis?.category);
const aiColor = cleanAiValue(geminiAnalysis?.color);
    
const tempImage = saveTempImageAndGetUrl(req, imageBase64);
const tempImageUrl = tempImage.publicUrl;

console.log('TEMP IMAGE URL:', tempImageUrl);
const vision = await googleVisionAnnotate(imageBase64);

const labels = (vision.labels || []).map(l => (l.description || '').toLowerCase());
const logos = (vision.logos || []).map(l => (l.description || '').toLowerCase());
const text = (vision.text || '').toLowerCase();

const visionTextTokens = text
? text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
: [];

const visionSignals = [
...labels,
...logos,
...visionTextTokens
];

console.log("VISION SIGNALS FULL:", JSON.stringify(visionSignals)); 
    
// === DEDUZIONE CATEGORIA ===
let detectedCategory = '';

if (visionSignals.some(l => l.includes('t-shirt') || l.includes('shirt'))) {
  detectedCategory = 't-shirt';
}
if (visionSignals.some(l => l.includes('hoodie') || l.includes('sweatshirt'))) {
  detectedCategory = 'hoodie';
}
if (visionSignals.some(l => l.includes('jacket') || l.includes('coat') || l.includes('blazer'))) {
  detectedCategory = 'jacket';
}
if (visionSignals.some(l => l.includes('jeans') || l.includes('denim'))) {
  detectedCategory = 'jeans';
}
if (visionSignals.some(l =>
  l.includes('hat') ||
  l.includes('cap') ||
  l.includes('cappello') ||
  l.includes('headwear')
)) {
  detectedCategory = 'hat';
}
if (visionSignals.some(l =>
  l.includes('shoe') ||
  l.includes('shoes') ||
  l.includes('sneaker') ||
  l.includes('sneakers') ||
  l.includes('trainer') ||
  l.includes('trainers') ||
  l.includes('running shoe') ||
  l.includes('basketball shoe') ||
  l.includes('skate shoe')
)) {
  detectedCategory = 'shoe';
}
const formCategory = (category || '').toLowerCase().trim();
const photoCategory = (detectedCategory || '').toLowerCase().trim();

let finalCategory = formCategory || photoCategory || 't-shirt';
let categoryValidation = 'no-photo-signal';

if (formCategory && photoCategory) {
  if (formCategory === photoCategory) {
    finalCategory = formCategory;
    categoryValidation = 'match';
  } else {
    finalCategory = photoCategory;
    categoryValidation = 'photo-overrides-form';
  }
} else if (formCategory) {
  finalCategory = formCategory;
  categoryValidation = 'form-only';
} else if (photoCategory) {
  finalCategory = photoCategory;
  categoryValidation = 'photo-only';
}
    
console.log("FINAL CATEGORY:", finalCategory);
console.log("CATEGORY VALIDATION:", categoryValidation);
console.log("VISION LABELS:", labels);
    
    // Geo
    const ctxGeo = getSearchContext({ country, continent });
    const { hl, gl, siteList, siteWeights } = ctxGeo;
    const TOP_SITES = Math.min(siteList.length, 6);

   // Query
    
const finalBrand =
  brand && brand.trim() ? brand.trim() :
  (aiBrand && aiBrand !== 'Non identificato' ? aiBrand.trim() : '');
    
const finalModel =
  model && model.trim() ? model.trim() :
  (aiModel && aiModel !== 'Non identificato' ? aiModel.trim() : '');
    
const finalCategoryFromAI = (() => {
  const c = (aiCategory || '').toLowerCase();
  if (!c || c === 'non identificato') return '';
  if (c.includes('t-shirt') || c.includes('shirt')) return 't-shirt';
  if (c.includes('hoodie') || c.includes('felpa') || c.includes('sweatshirt')) return 'hoodie';
  if (c.includes('jacket') || c.includes('giacca') || c.includes('coat')) return 'jacket';
  if (c.includes('jeans') || c.includes('denim')) return 'jeans';
  if (c.includes('shoe') || c.includes('scarpa') || c.includes('sneaker')) return 'shoe';
  if (c.includes('hat') || c.includes('cap') || c.includes('cappello')) return 'hat';
  return '';
})();
    
const finalColor =
  color && color.trim() ? color.trim() :
  (aiColor && aiColor !== 'Non identificato' ? aiColor.trim() : '');
    
const queryCategory = category && category.trim()
  ? category.trim()
  : (finalCategoryFromAI || '');
    
const qb = buildCandidateQueries(
  {
    brand: finalBrand,
    model: finalModel,
    category: queryCategory,
    pattern,
    gender,
    color: finalColor
  },
  { logos: [], text: '', labels: [], colors: [] }
);
    
const queries = qb.queries;
const brandResolved = qb.brandResolved;

console.log('QUERY INPUTS FINAL:', {
  finalBrand,
  finalModel,
  queryCategory,
  finalColor
});
console.log('QUERIES BUILT:', queries);

// 1) Prima prova vera image-search eBay + Google Lens
let merged = [];
let topResults = [];
let top2Match = null;
let anchorTitle = '';
let usedQuery = 'ebay_image_search';
let dynamicHintSignals = [];

try {
  const ebayImageItems = await ebaySearchByImage(imageBase64, { limit: 20 });
  const googleLensItems = await searchWithGoogleLens(tempImageUrl);

  const combined = [
    ...ebayImageItems,
    ...googleLensItems,
  ];

  merged = dedupeByLink(combined);
  topResults = merged.slice(0, 2);
  
  if (topResults.length >= 2) {
    top2Match = titlesMatchTop2(
      topResults[0]?.title || '',
      topResults[1]?.title || ''
    );
  }
  if (top2Match?.ok) {
    anchorTitle = topResults[0]?.title || '';
  } else if (topResults.length) {
    anchorTitle = topResults[0]?.title || '';
  }
// === FILTRO QUALITÀ BASE ===

merged = merged.filter(item => {
  const text = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();

  // 1) Escludi accessori
  const excludeKeywords = [
    'poster', 'sticker', 'patch', 'keychain', 'mug',
    'cup', 'toy', 'lego', 'figure', 'decal'
  ];
  if (excludeKeywords.some(k => text.includes(k))) return false;

  // 2) Deve contenere almeno un segnale clothing
  const clothingKeywords = [
  // TOP
  'shirt', 't-shirt', 'tee', 'polo', 'top', 'tank', 'canotta',

  // UPPER
  'hoodie', 'sweatshirt', 'felpa', 'maglione', 'sweater', 'cardigan',

  // OUTERWEAR
  'jacket', 'coat', 'giacca', 'piumino', 'blazer',

  // BOTTOM
  'jeans', 'pants', 'trousers', 'pantaloni', 'shorts', 'gonna', 'skirt',

  // FULL BODY
  'dress', 'vestito',

  // SHOES
  'shoe', 'shoes', 'scarpa', 'scarpe', 'sneaker', 'sneakers',
  'trainer', 'trainers', 'running shoe', 'basketball shoe', 'skate shoe',
  
  // HEADWEAR
  'hat', 'cap', 'cappello', 'cappellino', 'beanie', 'snapback', 'visor'
  
  ];
  
  const hasClothing = clothingKeywords.some(k => text.includes(k));
  if (!hasClothing) return false;
  return true;
});
// === FILTRO BRAND + CATEGORIA DINAMICO ===

  const dynamicBrandSignals = uniq([
  brand,
  brandResolved,
  vision.logos?.[0]?.description || ''
])
  .map(x => norm(x))
  .filter(Boolean);

const dynamicCategorySignals = uniq([
  finalCategory,
  ...(CATEGORY_SYNONYMS[finalCategory] || [])
])
  .map(x => norm(x))
  .filter(Boolean);

  dynamicHintSignals = buildVisualHintSignals(
  combined,
  dynamicBrandSignals,
  dynamicCategorySignals
);

merged = merged.filter(item => {
  const text = norm(`${item.title || ''} ${item.snippet || ''}`);

  const hasBrand = dynamicBrandSignals.length
    ? dynamicBrandSignals.some(b => text.includes(b))
    : false;

  const hasCategory = dynamicCategorySignals.length
    ? dynamicCategorySignals.some(c => text.includes(c))
    : true;

  const hasHint = dynamicHintSignals.length
    ? dynamicHintSignals.some(h => text.includes(h))
    : false;

  if (!hasCategory) return false;

  if (dynamicBrandSignals.length) {
    return hasBrand || hasHint;
  }

  return hasHint || hasCategory;
});

console.log('DYNAMIC BRAND SIGNALS:', dynamicBrandSignals);
console.log('DYNAMIC CATEGORY SIGNALS:', dynamicCategorySignals);
console.log('DYNAMIC HINT SIGNALS:', dynamicHintSignals);
console.log('AFTER DYNAMIC BRAND FILTER:', merged.length);


console.log('EBAY IMAGE SEARCH RESULTS:', ebayImageItems.length);
console.log('GOOGLE LENS RESULTS:', googleLensItems.length);
console.log('DYNAMIC BRAND SIGNALS:', dynamicBrandSignals);
console.log('DYNAMIC CATEGORY SIGNALS:', dynamicCategorySignals);
console.log('AFTER DYNAMIC BRAND FILTER:', merged.length);
} catch (e) {
  console.warn('IMAGE SEARCH COMBINED FAILED:', e.message);
}
    
// 2) Se eBay non basta, fallback al vecchio sistema testuale
if (!merged.length) {
  for (const q of queries) {
    const step = [];
    for (const site of siteList.slice(0, TOP_SITES)) {
      try {
        const r = await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE, hl, gl });
        step.push(...r);
        await sleep(300);
      } catch {}
    }
    if (includeShopping) {
      try {
        const shop = await serpShoppingGlobal({ query: q, num: 25, hl, gl });
        step.push(...shop.filter(it => !isBlacklisted(domainOf(it.link))));
      } catch {}
    }
    const deduped = dedupeByLink(step);
    const priced = deduped.filter(it => parseMoney(it.price_str || it.title || it.snippet) != null);
    if (priced.length >= 6) {
      merged = deduped;
      usedQuery = q;
      break;
    }
  }

  if (!merged.length) {
    const q = queries[0];
    let fb = [];
    for (const site of siteList.slice(0, TOP_SITES)) {
      try {
        fb.push(...await serpSearch({ query: q, site, num: ENV.MAX_RESULTS_PER_SITE, hl, gl }));
      } catch {}
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
 }
if (!topResults.length) {
  topResults = merged.slice(0, 2);
}
const titlesForExtraction = anchorTitle
  ? [anchorTitle]
  : topResults.map(it => it.title || '');
    
const productInfo = extractProductInfo({
  labelAnnotations: vision.labels,
  logoAnnotations: vision.logos,
  text: vision.text,
  candidateTitles: titlesForExtraction,
  visionColors: vision.colors,
});
const visionCategory = finalCategory || '';
const visionColor = colorFromVision(vision.colors) || '';
let visionValidation = {
  categoryMatch: false,
  colorMatch: false,
};
if (productInfo.category && visionCategory) {
   const pCat = productInfo.category.toLowerCase();
   const vCat = visionCategory.toLowerCase();
   visionValidation.categoryMatch =
    pCat.includes(vCat) ||
    vCat.includes(pCat) ||
    (pCat === 'maglietta' && (vCat === 't-shirt' || vCat === 'shirt')) ||
    (pCat === 'scarpe' && (vCat === 'shoe' || vCat === 'sneaker')) ||
    (pCat === 'cappello' && vCat === 'hat');
 }
if (productInfo.color && visionColor) {
  visionValidation.colorMatch =
    productInfo.color.toLowerCase() === visionColor.toLowerCase();
}
console.log("PRODUCT INFO:", productInfo);
    
    // Whitelist + blacklist
    const whiteSet = new Set(siteList.map(s => s.replace(/^www\./,'')));
    const filteredWL = merged.filter(it => {
    const d = domainOf(it.link);
      if (!d) return false;
      if (isBlacklisted(d)) return false;

      const dn = d.replace(/^www\./, '');

    // accetta tutti i domini eBay quando la fonte è image-search eBay
      const isAnyEbay = dn === 'ebay.it' || dn === 'ebay.com' || dn.endsWith('.ebay.com');

      return whiteSet.has(dn) || includeShopping || isAnyEbay;
    });
    /// Hard filter brand
    const strictBrand = strictBrandFromClient === null
      ? ENV.STRICT_BRAND_DEFAULT
      : !!strictBrandFromClient;

    let filteredStrict = filteredWL;
    if (brand) {
      const onlyBrand = filteredWL.filter(it => {
      const hay = `${it.title || ''} ${it.snippet || ''}`;
      return containsWord(hay, brand) || containsWord(hay, brandResolved);
      });

    filteredStrict = strictBrand
      ? (onlyBrand.length ? onlyBrand : filteredWL)
      : (onlyBrand.length >= 6 ? onlyBrand : filteredWL);
    }

    // Ranking
    const contextScore = {
      brand, model, gender, color: color || colorFromVision(vision.colors) || '', category,
      siteWeights: Object.fromEntries([...whiteSet].map(d => [d, siteWeights[d] || 0]))
    };
    const cleaned = filteredStrict.filter(it => {
      const text = `${it.title || ''} ${it.snippet || ''}`.toLowerCase();
      return !isExcludedApparelResult(text) && matchesApparelCategory(text, finalCategory);
    });

    const ranked = [...cleaned].map(it => ({ ...it, _score: scoreItem(it, contextScore) }))
      .sort((a,b) => b._score - a._score);

    // Prezzi
    let TOP_N = 40;

    // fallback: se dopo i filtri restano pochi risultati, usa più elementi
    if (ranked.length > 40 && ranked.length < 80) {
      TOP_N = 60;
    }
    if (ranked.length >= 80) {
      TOP_N = 80;
    }

    const topForPricing = ranked.slice(0, TOP_N);

    console.log('TOP_N USATO:', TOP_N);
    console.log('RANKED COUNT:', ranked.length);

const ebayOnly = topForPricing.filter(it =>
  String(it.source || '').includes('ebay')
);

const strongHintMatches = ebayOnly.filter(it => {
  const text = norm(`${it.title || ''} ${it.snippet || ''}`);
  const hitCount = dynamicHintSignals.filter(h => text.includes(h)).length;
  return hitCount >= 2;
});

const priceSource =
  strongHintMatches.length >= 3
    ? strongHintMatches
    : (ebayOnly.length >= 5 ? ebayOnly : topForPricing);

const rawPrices = priceSource
  .map(it => parseMoney(it.price_str || it.title || it.snippet))
  .filter(Number.isFinite);

const sorted = [...rawPrices].sort((a, b) => a - b);
const medianRaw = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;

// filtro outlier più robusto:
// - taglia prezzi sotto il 35% della mediana
// - taglia prezzi sopra il 250% della mediana
let prices = rawPrices.filter(p => {
  if (!medianRaw) return true;
  return p >= (medianRaw * 0.35) && p <= (medianRaw * 2.5);
});

// fallback intelligente se pochi dati
if (prices.length < 8 && rawPrices.length >= 5) {
  console.log('FALLBACK PRICE FILTER ATTIVO');

  prices = rawPrices.filter(p => {
    if (!medianRaw) return true;
    return p >= (medianRaw * 0.25) && p <= (medianRaw * 3.0);
  });
}

console.log('EBAY ONLY COUNT:', ebayOnly.length);
console.log('PRICE SOURCE COUNT:', priceSource.length);
console.log('STRONG HINT MATCHES COUNT:', strongHintMatches.length);
console.log('RAW PRICES COUNT:', rawPrices.length);
console.log('MEDIAN RAW:', medianRaw);
console.log('AFTER PRICE FILTER:', prices.length);
console.log('SELLABLE BASE:', percentile(prices, 0.25));
    
const { baseMedian, mode, newRatio } = applyConditionHeuristic(
  prices,
  priceSource,
  condition
);

const sellableBase = percentile(prices, 0.25) ?? baseMedian;
const suggested = humanRound(sellableBase);
  


    const kVal = (kFactor !== null && !isNaN(Number(kFactor))) ? Number(kFactor) : null;
    const suggestedPriceAdjusted = (kVal && suggested) ? humanRound(suggested * kVal) : suggested;
    console.log("GEO_PRICE_LOG:", JSON.stringify({
      timestamp: new Date().toISOString(),
      country: country || ENV.PRICE_COUNTRY,
      query: usedQuery,
      brand: brandResolved,
      category: finalCategory,
      suggestedPrice: suggested,
      suggestedAdjusted: suggestedPriceAdjusted
    }));
    res.json({
      success: true,
      geo: { hl, gl, countryUsed: country || ENV.PRICE_COUNTRY, continentUsed: continent || null, sitesQueried: siteList.slice(0, TOP_SITES) },
      brandResolved,
      top2Debug: {
        titles: topResults.map(it => it.title || ''),
        match: top2Match,
        anchorTitle
      },
      visionValidation,
      category: productInfo.category,
      brand: productInfo.brand,
      model: productInfo.model,
      color: productInfo.color,
      queryUsed: usedQuery,
      queriesTried: queries.slice(0, 8),
      visionPreview: {
        brandVision: vision.logos?.[0]?.description || null,
        topLabels: (vision.labels || []).slice(0,5).map(l => `${l.description} (${(l.score*100|0)}%)`),
        textHint: vision.text?.slice(0, 120) || null,
        colorGuess: colorFromVision(vision.colors) || null
      },
      params: { includeShopping: !!includeShopping, condition: mode, strictBrand,
      form: { brand, model, category, pattern, gender, color: contextScore.color }, kFactor: kVal },
      note: (!brand && !model) ? 'Per un’analisi più puntuale, indica marca e/o modello nel form.' : null,
      stats: {
        resultsFound: merged.length,
        afterWhitelist: filteredWL.length,
        afterBrandFilter: filteredStrict.length,
        rankedTopUsed: Math.min(filteredStrict.length, TOP_N),
        pricedCount: prices.length,
        baseMedian,
        sellableBase,
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
async function getEbayToken() {
  const credentials = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');

  const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  });

  const data = await response.json();
  return data.access_token;
}
async function ebaySearchByImage(imageBase64, { limit = 20 } = {}) {
  const token = await getEbayToken();
  const response = await fetch(
    `https://api.ebay.com/buy/browse/v1/item_summary/search_by_image?limit=${limit}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image: imageBase64
      }),
    }
  );
  const data = await response.json();
  const items = (data.itemSummaries || []).map(item => ({
    title: item.title || '',
    link: item.itemWebUrl || '',
    snippet: [
      item.condition || '',
      item.categories?.[0]?.categoryName || '',
      item.itemLocation?.country || '',
    ].filter(Boolean).join(' · '),
    price_str: item.price?.value
      ? `${item.price.value} ${item.price.currency || ''}`.trim()
      : '',
    source: 'ebay_image_search',
    image: item.image?.imageUrl || '',
    currency: item.price?.currency || '',
    rawPrice: item.price?.value || null,
  }));
  return items;
}
async function searchWithGoogleLens(imageUrl) {
  try {
    const params = new URLSearchParams({
      engine: 'google_lens',
      url: imageUrl,
      api_key: process.env.SERP_API_KEY,
    });

    const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
      method: 'GET',
    });

    const data = await response.json();

    const visualMatches = data.visual_matches || [];
    const exactMatches = data.exact_matches || [];
    const products = data.shopping_results || data.products || [];

    const allItems = [
      ...visualMatches.map(item => ({
        title: item.title || '',
        link: item.link || '',
        snippet: item.source || '',
        price_str: item.price || '',
        source: 'google_lens_visual',
        image: item.thumbnail || '',
      })),
      ...exactMatches.map(item => ({
        title: item.title || '',
        link: item.link || '',
        snippet: item.source || '',
        price_str: item.price || '',
        source: 'google_lens_exact',
        image: item.thumbnail || '',
      })),
      ...products.map(item => ({
        title: item.title || '',
        link: item.link || '',
        snippet: item.source || '',
        price_str: item.price || '',
        source: 'google_lens_product',
        image: item.thumbnail || '',
      })),
    ];

    return allItems;
  } catch (e) {
    console.warn('GOOGLE LENS ERROR:', e.message);
    return [];
  }
}
app.get('/test-ebay', async (req, res) => {
  try {
    const query = req.query.q || "nike t shirt black";

    const token = await getEbayToken();

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${query}`;

    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();

let category = "t-shirt";

if (query.toLowerCase().includes("hoodie")) category = "hoodie";
if (query.toLowerCase().includes("jacket")) category = "jacket";
if (query.toLowerCase().includes("jeans")) category = "jeans";
if (query.toLowerCase().includes("polo")) category = "polo";
if (query.toLowerCase().includes("hat")) category = "hat";
if (query.toLowerCase().includes("cap")) category = "hat";

const items = (data.itemSummaries || [])
  .filter(item => !isExcludedApparelResult(item.title))
  .filter(item => matchesApparelCategory(item.title, category))
      .map(item => ({
        title: item.title,
        price: item.price?.value,
        currency: item.price?.currency,
        condition: item.condition,
        url: item.itemWebUrl
      }));

    res.send(`<pre>${JSON.stringify(items.slice(0, 10), null, 2)}</pre>`);
  } catch (error) {
    console.error(error);
    res.status(500).send("Errore eBay");
  }
});
app.listen(PORT, '0.0.0.0', () => console.log(`API avviata su :${PORT}`));

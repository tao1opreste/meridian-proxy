const express = require('express')
const fetch = require('node-fetch')
const cors = require('cors')
const app = express()

const publicCors = cors({ origin: '*' })

app.get('/yahoo', publicCors, async (req, res) => {
  try {
    const url = req.query.url
    if (!url) return res.status(400).json({ error: 'No URL' })

    const response = await fetch(decodeURIComponent(url), {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    })

    const data = await response.json()
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(s => s.trim()).filter(Boolean)
const PROXY_SECRET = process.env.PROXY_SECRET || ''
const ALLOWED_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
])
const MAX_TOKENS_CAP = 4000

const anthropicCors = cors({
  origin: ALLOWED_ORIGINS,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-meridian-secret'],
})

app.options('/anthropic', anthropicCors)

app.post('/anthropic', anthropicCors, express.json({ limit: '25mb' }), async (req, res) => {
  if (PROXY_SECRET && req.get('x-meridian-secret') !== PROXY_SECRET) {
    return res.status(401).json({ error: { message: 'Unauthorized proxy request' } })
  }

  const body = req.body || {}

  if (!ALLOWED_MODELS.has(body.model)) {
    return res.status(400).json({ error: { message: `Model not allowed: ${body.model}` } })
  }
  if (body.max_tokens && body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = MAX_TOKENS_CAP
  }

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set on server' } })
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    res.status(upstream.status)
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/json')
    upstream.body.pipe(res)
  } catch (err) {
    res.status(502).json({ error: { message: 'Proxy upstream error: ' + err.message } })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// News via NewsData.io — cheap, commercial-friendly alternative to AI web_search.
// SHARED server-side cache: global sections are fetched ONCE per hour and served
// to every user, so news cost does NOT scale with the number of users.
// Set NEWSDATA_API_KEY in Railway (free key from newsdata.io). "ultima_hora" is
// intentionally NOT here (free tier is delayed) — it stays an AI/Pro feature.
// ─────────────────────────────────────────────────────────────────────────────
// Falls back to a free NewsData key so it works without a Railway env var.
// Low-risk (free tier). Prefer setting NEWSDATA_API_KEY in Railway; rotate if leaked.
const NEWSDATA_KEY = process.env.NEWSDATA_API_KEY || 'pub_4ffbb84d52c340d6873a0bfd17de153b'
const NEWS_TTL_MS = 60 * 60 * 1000 // 1h shared cache
const newsCache = new Map()        // cacheKey -> { ts, data }

// Finance-focused queries (NewsData free q limit is ~100 chars, so keep them short).
const GLOBAL_SECTIONS = {
  destacado:  { q: '"stock market" OR earnings OR Nasdaq OR bolsa OR acciones', category: 'business' },
  macro:      { q: 'inflation OR "interest rates" OR "Federal Reserve" OR ECB', category: 'business' },
  tecnologia: { q: 'semiconductor OR Nvidia OR Apple OR "tech stocks" OR chips', category: 'business' },
  cripto:     { q: 'bitcoin OR ethereum OR cryptocurrency OR crypto', category: 'business' },
  materias:   { q: 'oil prices OR gold OR commodities OR crude', category: 'business' },
}

async function newsdataQuery(params) {
  if (!NEWSDATA_KEY) return []
  const u = new URL('https://newsdata.io/api/1/latest')
  u.searchParams.set('apikey', NEWSDATA_KEY)
  u.searchParams.set('language', 'es,en')
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  try {
    const r = await fetch(u.toString())
    if (!r.ok) return []
    const j = await r.json()
    return Array.isArray(j.results) ? j.results : []
  } catch { return [] }
}

function mapOne(a) {
  return {
    id: a.article_id || a.link || a.title,
    headline: a.title || '',
    summary: a.description || '',
    source: a.source_name || a.source_id || '',
    link: a.link || '',
    ticker: '',
    timeAgo: a.pubDate || '',
  }
}

function mapArticles(arr, limit) {
  return (arr || []).slice(0, limit).map(mapOne)
}

async function getGlobalNews() {
  const cached = newsCache.get('global')
  if (cached && Date.now() - cached.ts < NEWS_TTL_MS) return cached.data
  const keys = Object.keys(GLOBAL_SECTIONS)
  const results = await Promise.all(keys.map(k => newsdataQuery(GLOBAL_SECTIONS[k])))
  const seen = new Set() // dedupe the same article showing up in several sections
  const data = {}
  keys.forEach((k, i) => {
    const limit = k === 'destacado' ? 6 : 4
    const out = []
    for (const a of (results[i] || [])) {
      const titleKey = (a.title || '').toLowerCase().trim()
      if (!titleKey || seen.has(titleKey)) continue
      seen.add(titleKey)
      out.push(mapOne(a))
      if (out.length >= limit) break
    }
    data[k] = out
  })
  newsCache.set('global', { ts: Date.now(), data })
  return data
}

async function getHoldingsNews(q) {
  if (!q) return []
  const key = 'h:' + q
  const cached = newsCache.get(key)
  if (cached && Date.now() - cached.ts < NEWS_TTL_MS) return cached.data
  const data = mapArticles(await newsdataQuery({ q, category: 'business' }), 6)
  newsCache.set(key, { ts: Date.now(), data })
  return data
}

app.options('/news', anthropicCors)
app.post('/news', anthropicCors, express.json({ limit: '256kb' }), async (req, res) => {
  if (PROXY_SECRET && req.get('x-meridian-secret') !== PROXY_SECRET) {
    return res.status(401).json({ error: { message: 'Unauthorized news request' } })
  }
  if (!NEWSDATA_KEY) {
    return res.status(500).json({ error: { message: 'NEWSDATA_API_KEY not set on server' } })
  }
  try {
    const holdingsQuery = (req.body && req.body.q) ? String(req.body.q).slice(0, 200) : ''
    const [global, tus] = await Promise.all([getGlobalNews(), getHoldingsNews(holdingsQuery)])
    res.json({ ...global, tus_acciones: tus })
  } catch (err) {
    res.status(502).json({ error: { message: 'News error: ' + err.message } })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Fear & Greed Index (real, from CNN) — public, free, NO API key, NO AI tokens.
// SHARED server cache (30 min) so it costs the same regardless of user count.
// CNN's dataviz endpoint needs a browser User-Agent or it 403s.
// ─────────────────────────────────────────────────────────────────────────────
const FNG_TTL_MS = 30 * 60 * 1000
let fngCache = null // { ts, data }

app.get('/fng', publicCors, async (req, res) => {
  try {
    if (fngCache && Date.now() - fngCache.ts < FNG_TTL_MS) return res.json(fngCache.data)

    const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
    })
    if (!r.ok) {
      if (fngCache) return res.json(fngCache.data) // serve stale on upstream error
      return res.status(502).json({ error: 'CNN upstream ' + r.status })
    }
    const j = await r.json()
    const fg = j && j.fear_and_greed ? j.fear_and_greed : {}
    const data = {
      score: typeof fg.score === 'number' ? Math.round(fg.score) : null,
      rating: fg.rating || null,
      updated: fg.timestamp || null,
    }
    fngCache = { ts: Date.now(), data }
    res.json(data)
  } catch (err) {
    if (fngCache) return res.json(fngCache.data)
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Text-to-Speech (voz humana) vía Google Cloud TTS. La clave vive SOLO aquí
// (env GOOGLE_TTS_KEY), nunca en la app. Protegido con x-meridian-secret + CORS.
// Sin clave → 503 y la app cae a la voz nativa del dispositivo (no se rompe).
// Voces neurales: español (es-ES) e inglés (en-US). Capa gratis de Google ~1M/mes.
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || ''
// Chirp 3 HD = voces generativas, lo más humano de Google (capa gratis 1M/mes).
// Lista de candidatas EN ORDEN: si una falla, prueba la siguiente (nunca cae a Siri).
// Charon = voz de hombre más grave/resonante; Orus de respaldo; Aoede al final (confirmada).
const TTS_VOICES = {
  es: ['es-ES-Chirp3-HD-Charon', 'es-ES-Chirp3-HD-Orus', 'es-ES-Chirp3-HD-Aoede'],
  en: ['en-US-Chirp3-HD-Charon', 'en-US-Chirp3-HD-Orus', 'en-US-Chirp3-HD-Aoede'],
}
const TTS_LANGCODE = { es: 'es-ES', en: 'en-US' }

app.options('/tts', anthropicCors)
app.post('/tts', anthropicCors, express.json({ limit: '64kb' }), async (req, res) => {
  if (PROXY_SECRET && req.get('x-meridian-secret') !== PROXY_SECRET) {
    return res.status(401).json({ error: { message: 'Unauthorized tts request' } })
  }
  if (!GOOGLE_TTS_KEY) {
    return res.status(503).json({ error: { message: 'GOOGLE_TTS_KEY not set on server' } })
  }
  try {
    const text = (req.body && req.body.text ? String(req.body.text) : '').slice(0, 700).trim()
    if (!text) return res.status(400).json({ error: { message: 'No text' } })
    const lang = (req.body && req.body.lang) === 'en' ? 'en' : 'es'
    const candidates = TTS_VOICES[lang]
    const languageCode = TTS_LANGCODE[lang]
    let audio = null
    let lastErr = ''
    for (const name of candidates) {
      const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(GOOGLE_TTS_KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text }, voice: { languageCode, name }, audioConfig: { audioEncoding: 'MP3' } }),
      })
      if (r.ok) {
        const j = await r.json()
        if (j.audioContent) { audio = j.audioContent; break }
        lastErr = 'no audio (' + name + ')'
      } else {
        lastErr = 'upstream ' + r.status + ' (' + name + ')'
      }
    }
    if (!audio) return res.status(502).json({ error: { message: 'TTS failed: ' + lastErr } })
    res.json({ audio })
  } catch (err) {
    res.status(500).json({ error: { message: 'TTS error: ' + err.message } })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Digests de mercado COMPARTIDOS (no personalizados) por tipo. Se calculan 1 vez por
// periodo (Sonnet + web_search) y se sirven a todos desde caché → coste casi nulo.
//   smartmoney : dark pool/block trades, short interest, insiders, options flow — semanal
//   13f        : movimientos 13F del trimestre (Berkshire, Druckenmiller…) tesis AI infra
// Protegido con x-meridian-secret + CORS.
// ─────────────────────────────────────────────────────────────────────────────
const DAY_MS = 24 * 60 * 60 * 1000
const DIGESTS = {
  smartmoney: {
    ttl: 7 * DAY_MS,
    system: 'Eres un analista de flujos "smart money" senior que explica de forma CLARA y aterrizada, sin jerga sin explicar. Usas web_search para datos recientes y verificados. Tu valor no es soltar tecnicismos ni datos sueltos: es explicar QUE esta pasando y SOBRE TODO POR QUE importa y que suelen anticipar los grandes con eso. Devuelve SOLO JSON valido, sin markdown, sin emojis ni simbolos raros. En espanol de Espana.',
    prompt: `Rastrea las senales de "smart money" mas recientes (ultima semana si es posible) en el mercado de EE.UU.: 1) dark pool y block trades destacados, 2) cambios relevantes en short interest, 3) insider buying/selling (compras y ventas de directivos), 4) options flow inusual.
IMPORTANTE: NO te quedes en lo tecnico ni en datos sueltos, y tampoco des informacion generica y obvia. Para CADA senal: dilo en lenguaje claro, LLEVALO A TIERRA y explica el PORQUE (que implica, que suelen estar anticipando los grandes con ese movimiento). Concreto y util, pero entendible.
Devuelve SOLO este JSON:
{"summary":"1-2 frases con la foto general en lenguaje claro","items":[{"label":"Dark pool","detail":"que esta pasando + por que importa y que implica, claro y aterrizado, 2-3 frases"},{"label":"Short interest","detail":"..."},{"label":"Insiders","detail":"..."},{"label":"Opciones","detail":"..."}],"asOf":"de cuando son los datos mas recientes que has usado","conclusion":"conclusion CLARA y aterrizada: que significa todo esto en conjunto y que deberias vigilar, 2 frases directas"}
Texto en espanol claro, directo, explicando siempre el porque, sin markdown, sin emojis ni simbolos raros.`,
  },
  '13f': {
    ttl: 21 * DAY_MS,
    system: 'Eres un analista que estudia las presentaciones 13F de los grandes fondos. Usa web_search para los datos del ultimo trimestre presentado. Devuelve SOLO JSON valido, sin markdown, sin emojis ni simbolos raros. En espanol de Espana.',
    prompt: `Analiza los movimientos institucionales del ULTIMO trimestre 13F presentado. Centrate en fondos e inversores top (Berkshire Hathaway, Stanley Druckenmiller/Duquesne, y otros grandes relevantes) y FILTRA por la tesis de infraestructura de IA (semiconductores, centros de datos, energia/electricas para IA, redes, memoria, etc.). Profundo, no superficial.
Devuelve SOLO este JSON:
{"summary":"1-2 frases de la foto del trimestre en infraestructura de IA","items":[{"label":"Berkshire Hathaway","detail":"que compro o vendio relevante para AI infrastructure, 1-2 frases"},{"label":"Duquesne (Druckenmiller)","detail":"..."}],"asOf":"el trimestre de los datos (p.ej. Q1 2026)","conclusion":"conclusion en 1-2 frases"}
Incluye 3-5 fondos o inversores en "items". Texto natural en espanol, sin markdown, sin emojis ni simbolos raros.`,
  },
}
const digestCache = {}     // type -> { ts, data }
const digestInFlight = {}  // type -> promise

function parseJSONLoose(text) {
  const cleaned = String(text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) return JSON.parse(m[0])
  throw new Error('No JSON in response')
}

app.options('/digest', anthropicCors)
app.post('/digest', anthropicCors, express.json({ limit: '64kb' }), async (req, res) => {
  if (PROXY_SECRET && req.get('x-meridian-secret') !== PROXY_SECRET) {
    return res.status(401).json({ error: { message: 'Unauthorized digest request' } })
  }
  const type = (req.body && DIGESTS[req.body.type]) ? req.body.type : 'smartmoney'
  const cfg = DIGESTS[type]
  const cached = digestCache[type]
  if (cached && Date.now() - cached.ts < cfg.ttl) {
    return res.json({ ...cached.data, cached: true, ts: cached.ts })
  }
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set on server' } })
  try {
    if (!digestInFlight[type]) {
      digestInFlight[type] = (async () => {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1800,
            system: cfg.system,
            messages: [{ role: 'user', content: cfg.prompt }],
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          }),
        })
        const j = await upstream.json()
        if (!upstream.ok) throw new Error(j?.error?.message || ('upstream ' + upstream.status))
        const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
        const data = parseJSONLoose(text)
        digestCache[type] = { ts: Date.now(), data }
        return data
      })()
    }
    const data = await digestInFlight[type]
    digestInFlight[type] = null
    res.json({ ...data, cached: false, ts: Date.now() })
  } catch (err) {
    digestInFlight[type] = null
    if (digestCache[type]) return res.json({ ...digestCache[type].data, cached: true, stale: true, ts: digestCache[type].ts })
    res.status(502).json({ error: { message: 'Digest error: ' + err.message } })
  }
})

app.get('/health', (req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Proxy running on ${PORT}`))

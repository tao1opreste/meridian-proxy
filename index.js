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

app.post('/anthropic', anthropicCors, express.json({ limit: '1mb' }), async (req, res) => {
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

const GLOBAL_SECTIONS = {
  destacado:  { category: 'business' },
  macro:      { q: 'inflation OR "interest rates" OR "Federal Reserve" OR ECB OR economy', category: 'business' },
  tecnologia: { category: 'technology' },
  cripto:     { q: 'cryptocurrency OR bitcoin OR ethereum' },
  materias:   { q: 'oil OR gold OR commodities' },
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

function mapArticles(arr, limit) {
  return (arr || []).slice(0, limit).map(a => ({
    id: a.article_id || a.link || a.title,
    headline: a.title || '',
    summary: a.description || '',
    source: a.source_name || a.source_id || '',
    link: a.link || '',
    ticker: '',
    timeAgo: a.pubDate || '',
  }))
}

async function getGlobalNews() {
  const cached = newsCache.get('global')
  if (cached && Date.now() - cached.ts < NEWS_TTL_MS) return cached.data
  const keys = Object.keys(GLOBAL_SECTIONS)
  const results = await Promise.all(keys.map(k => newsdataQuery(GLOBAL_SECTIONS[k])))
  const data = {}
  keys.forEach((k, i) => { data[k] = mapArticles(results[i], k === 'destacado' ? 6 : 4) })
  newsCache.set('global', { ts: Date.now(), data })
  return data
}

async function getHoldingsNews(q) {
  if (!q) return []
  const key = 'h:' + q
  const cached = newsCache.get(key)
  if (cached && Date.now() - cached.ts < NEWS_TTL_MS) return cached.data
  const data = mapArticles(await newsdataQuery({ q }), 6)
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

app.get('/health', (req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Proxy running on ${PORT}`))

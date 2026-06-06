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

app.get('/health', (req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Proxy running on ${PORT}`))

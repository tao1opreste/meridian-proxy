const express = require('express')
const fetch = require('node-fetch')
const cors = require('cors')
const app = express()

app.use(cors({ origin: '*' }))

app.get('/yahoo', async (req, res) => {
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

app.get('/health', (req, res) => res.json({ ok: true }))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Proxy running on ${PORT}`))

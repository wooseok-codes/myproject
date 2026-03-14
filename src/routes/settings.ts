import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
}

const settings = new Hono<{ Bindings: Bindings }>()

// ─── API 설정 조회 ────────────────────────────────────────────────────────────
settings.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, provider, account_no, enabled, updated_at FROM api_settings'
  ).all()
  return c.json({ settings: results })
})

// ─── API 설정 저장/수정 ───────────────────────────────────────────────────────
settings.post('/', async (c) => {
  const body = await c.req.json() as any
  const { provider, appKey, appSecret, accountNo, webhookUrl, enabled } = body

  await c.env.DB.prepare(`
    INSERT INTO api_settings (provider, app_key, app_secret, account_no, webhook_url, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET
      app_key=excluded.app_key,
      app_secret=excluded.app_secret,
      account_no=excluded.account_no,
      webhook_url=excluded.webhook_url,
      enabled=excluded.enabled,
      updated_at=CURRENT_TIMESTAMP
  `).bind(provider, appKey || null, appSecret || null, accountNo || null, webhookUrl || null, enabled ? 1 : 0).run()

  return c.json({ message: '설정 저장 완료' })
})

// ─── KIS API 연결 테스트 ──────────────────────────────────────────────────────
settings.post('/test-kis', async (c) => {
  const body = await c.req.json() as any
  const { appKey, appSecret, accountNo, mode } = body

  const baseUrl = mode === 'real'
    ? 'https://openapi.koreainvestment.com:9443'
    : 'https://openapivts.koreainvestment.com:29443'

  try {
    const res = await fetch(`${baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: appKey,
        appsecret: appSecret,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return c.json({ success: false, message: `토큰 발급 실패: ${err}` })
    }

    const data: any = await res.json()
    return c.json({
      success: true,
      message: `✅ ${mode === 'real' ? '실계좌' : '모의계좌'} API 연결 성공`,
      expiresIn: data.expires_in,
    })
  } catch (e: any) {
    return c.json({ success: false, message: e.message })
  }
})

// ─── Slack 웹훅 테스트 ────────────────────────────────────────────────────────
settings.post('/test-slack', async (c) => {
  const body = await c.req.json() as any
  const { webhookUrl } = body

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '✅ StockBot Slack 연결 테스트 성공! 🎉',
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '✅ *StockBot Slack 연결 테스트 성공!* 🎉\n자동 트레이딩 알림이 이 채널로 발송됩니다.' }
          }
        ]
      }),
    })

    if (!res.ok) return c.json({ success: false, message: `Slack 요청 실패: ${res.status}` })
    return c.json({ success: true, message: '✅ Slack 웹훅 테스트 성공' })
  } catch (e: any) {
    return c.json({ success: false, message: e.message })
  }
})

// ─── 거래 내역 조회 ───────────────────────────────────────────────────────────
settings.get('/trades', async (c) => {
  const symbol = c.req.query('symbol') || ''
  const limit = parseInt(c.req.query('limit') || '50')
  let query = 'SELECT * FROM trade_history'
  const bindings: any[] = []
  if (symbol) { query += ' WHERE symbol=?'; bindings.push(symbol.toUpperCase()) }
  query += ' ORDER BY created_at DESC LIMIT ?'
  bindings.push(limit)

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all()
  return c.json({ trades: results })
})

// ─── 거래 통계 ────────────────────────────────────────────────────────────────
settings.get('/stats', async (c) => {
  const stats: any = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total_trades,
      COUNT(CASE WHEN side='buy' THEN 1 END) as buy_count,
      COUNT(CASE WHEN side='sell' THEN 1 END) as sell_count,
      ROUND(SUM(CASE WHEN side='sell' AND pnl IS NOT NULL THEN pnl ELSE 0 END)) as total_pnl,
      ROUND(COUNT(CASE WHEN side='sell' AND pnl > 0 THEN 1 END) * 100.0 /
        NULLIF(COUNT(CASE WHEN side='sell' THEN 1 END), 0), 2) as win_rate
    FROM trade_history
  `).first()

  return c.json(stats)
})

export default settings
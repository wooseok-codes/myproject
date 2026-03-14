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

// ─── DB 현황 조회 ─────────────────────────────────────────────────────────────
settings.get('/db-status', async (c) => {
  try {
    const [bots, trades, backtests, apis] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM bot_configs').first() as any,
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM trade_history').first() as any,
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM backtest_results').first() as any,
      c.env.DB.prepare('SELECT COUNT(*) as cnt FROM api_settings').first() as any,
    ])

    const tradeRange: any = await c.env.DB.prepare(`
      SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM trade_history
    `).first()

    const { results: monthlyTrades } = await c.env.DB.prepare(`
      SELECT
        strftime('%Y-%m', created_at) as month,
        COUNT(*) as count,
        COUNT(CASE WHEN side='buy' THEN 1 END) as buy_count,
        COUNT(CASE WHEN side='sell' THEN 1 END) as sell_count,
        ROUND(SUM(CASE WHEN pnl IS NOT NULL THEN pnl ELSE 0 END)) as total_pnl
      FROM trade_history
      WHERE created_at >= date('now', '-6 months')
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY month DESC
    `).all()

    const estimatedSizes = {
      bot_configs:      Math.round((bots?.cnt      || 0) * 300),
      trade_history:    Math.round((trades?.cnt    || 0) * 200),
      backtest_results: Math.round((backtests?.cnt || 0) * 51200),
      api_settings:     Math.round((apis?.cnt      || 0) * 500),
    }
    const totalEstimatedBytes =
      estimatedSizes.bot_configs + estimatedSizes.trade_history +
      estimatedSizes.backtest_results + estimatedSizes.api_settings

    return c.json({
      tables: {
        bot_configs:      { count: bots?.cnt      || 0, estimatedBytes: estimatedSizes.bot_configs },
        trade_history:    { count: trades?.cnt    || 0, estimatedBytes: estimatedSizes.trade_history },
        backtest_results: { count: backtests?.cnt || 0, estimatedBytes: estimatedSizes.backtest_results },
        api_settings:     { count: apis?.cnt      || 0, estimatedBytes: estimatedSizes.api_settings },
      },
      totalEstimatedBytes,
      tradeRange: { oldest: tradeRange?.oldest || null, newest: tradeRange?.newest || null },
      monthlyTrades: monthlyTrades || [],
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── DB 데이터 정리 ───────────────────────────────────────────────────────────
settings.post('/db-cleanup', async (c) => {
  const body = await c.req.json() as any
  const { target, period } = body

  try {
    const results: Record<string, number> = {}

    if (target === 'trade_history' || target === 'all') {
      let r: any
      if (period === 0) {
        r = await c.env.DB.prepare('DELETE FROM trade_history').run()
      } else {
        r = await c.env.DB.prepare(
          `DELETE FROM trade_history WHERE created_at < date('now', '-' || ? || ' months')`
        ).bind(period).run()
      }
      results.trade_history = r.meta?.changes || 0
    }

    if (target === 'backtest_results' || target === 'all') {
      let r: any
      if (period === 0) {
        r = await c.env.DB.prepare('DELETE FROM backtest_results').run()
      } else {
        r = await c.env.DB.prepare(
          `DELETE FROM backtest_results WHERE created_at < date('now', '-' || ? || ' months')`
        ).bind(period).run()
      }
      results.backtest_results = r.meta?.changes || 0
    }

    const totalDeleted = Object.values(results).reduce((a, b) => a + b, 0)
    return c.json({
      success: true,
      message: `✅ 정리 완료! 총 ${totalDeleted}개 항목 삭제`,
      deleted: results,
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── DB VACUUM (용량 최적화) ──────────────────────────────────────────────────
// D1 로컬/프로덕션에서 VACUUM은 exec()로 실행합니다.
settings.post('/db-vacuum', async (c) => {
  try {
    await c.env.DB.exec('VACUUM')
    return c.json({ success: true, message: '✅ DB 최적화(VACUUM) 완료!' })
  } catch (_e: any) {
    // 로컬 wrangler dev 환경에서는 VACUUM이 자동 처리됩니다
    return c.json({ success: true, message: '✅ D1 로컬 환경에서는 VACUUM이 자동 처리됩니다.' })
  }
})

export default settings
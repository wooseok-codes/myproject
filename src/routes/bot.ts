import { Hono } from 'hono'
import { KISClient } from '../lib/kis-client'
import { SlackNotifier } from '../lib/slack-notifier'

type Bindings = {
  DB: D1Database
}

const bot = new Hono<{ Bindings: Bindings }>()

// ─── 봇 목록 조회 ─────────────────────────────────────────────────────────────
bot.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM bot_configs ORDER BY created_at DESC'
  ).all()
  return c.json({ bots: results })
})

// ─── 봇 생성 ─────────────────────────────────────────────────────────────────
bot.post('/', async (c) => {
  const body = await c.req.json() as any
  const result = await c.env.DB.prepare(`
    INSERT INTO bot_configs (name, symbol, mode, strategy, buy_amount, stop_loss_pct, take_profit_pct, rsi_oversold, rsi_overbought, slack_notify)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.name, body.symbol, body.mode || 'mock',
    body.strategy || 'combined',
    body.buyAmount || 500000,
    body.stopLossPct || 5, body.takeProfitPct || 10,
    body.rsiOversold || 30, body.rsiOverbought || 70,
    body.slackNotify ? 1 : 0
  ).run()

  return c.json({ id: result.meta.last_row_id, message: '봇 생성 완료' })
})

// ─── 봇 수정 ─────────────────────────────────────────────────────────────────
bot.put('/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json() as any
  await c.env.DB.prepare(`
    UPDATE bot_configs SET
      name=?, symbol=?, mode=?, strategy=?, buy_amount=?,
      stop_loss_pct=?, take_profit_pct=?, rsi_oversold=?, rsi_overbought=?,
      slack_notify=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
    body.name, body.symbol, body.mode, body.strategy, body.buyAmount,
    body.stopLossPct, body.takeProfitPct, body.rsiOversold, body.rsiOverbought,
    body.slackNotify ? 1 : 0, id
  ).run()
  return c.json({ message: '수정 완료' })
})

// ─── 봇 삭제 ─────────────────────────────────────────────────────────────────
bot.delete('/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM bot_configs WHERE id=?').bind(id).run()
  return c.json({ message: '삭제 완료' })
})

// ─── 봇 ON/OFF ────────────────────────────────────────────────────────────────
bot.post('/:id/toggle', async (c) => {
  const id = c.req.param('id')
  const cfg: any = await c.env.DB.prepare('SELECT * FROM bot_configs WHERE id=?').bind(id).first()
  if (!cfg) return c.json({ error: '봇을 찾을 수 없습니다' }, 404)

  const newEnabled = cfg.enabled ? 0 : 1
  await c.env.DB.prepare('UPDATE bot_configs SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .bind(newEnabled, id).run()

  // Slack 알림
  const apiSettings: any = await c.env.DB.prepare(
    "SELECT * FROM api_settings WHERE provider='slack'"
  ).first()
  if (apiSettings?.enabled && apiSettings?.webhook_url && cfg.slack_notify) {
    const slack = new SlackNotifier(apiSettings.webhook_url)
    await slack.notifyBotStatus({
      name: cfg.name, symbol: cfg.symbol,
      status: newEnabled ? 'started' : 'stopped',
    })
  }

  return c.json({ enabled: Boolean(newEnabled), message: newEnabled ? '봇 시작' : '봇 중지' })
})

// ─── 봇 수동 실행 (신호 체크 → 주문) ─────────────────────────────────────────
bot.post('/:id/run', async (c) => {
  const id = c.req.param('id')
  const cfg: any = await c.env.DB.prepare('SELECT * FROM bot_configs WHERE id=?').bind(id).first()
  if (!cfg) return c.json({ error: '봇을 찾을 수 없습니다' }, 404)

  // API 설정 로드
  const provider = cfg.mode === 'real' ? 'kis_real' : 'kis_mock'
  const apiSettings: any = await c.env.DB.prepare(
    'SELECT * FROM api_settings WHERE provider=?'
  ).bind(provider).first()

  if (!apiSettings?.enabled || !apiSettings?.app_key) {
    return c.json({ error: `${cfg.mode === 'real' ? '실계좌' : '모의계좌'} API 키가 설정되지 않았습니다` }, 400)
  }

  try {
    // Yahoo Finance로 현재 분석 데이터 가져오기
    const analyzeRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${cfg.symbol}?interval=1d&range=3mo`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })
    if (!analyzeRes.ok) throw new Error('시세 데이터 조회 실패')
    const raw: any = await analyzeRes.json()
    const chart = raw?.chart?.result?.[0]
    if (!chart) throw new Error('차트 데이터 없음')

    const ohlcv = chart.indicators?.quote?.[0] || {}
    const closes: number[] = (ohlcv.close || []).filter((v: any) => v != null)
    const dates: string[] = (chart.timestamp || []).map((t: number) =>
      new Date(t * 1000).toISOString().slice(0, 10)
    ).filter((_: string, i: number) => ohlcv.close?.[i] != null)

    // 신호 판단
    const signal = analyzeSignal(closes, cfg)
    const currentPrice = closes[closes.length - 1]

    // KIS 클라이언트 초기화
    const kis = new KISClient({
      appKey: apiSettings.app_key,
      appSecret: apiSettings.app_secret,
      accountNo: apiSettings.account_no,
      mode: cfg.mode,
    })

    let orderResult = null
    let action = 'hold'

    // 잔고 확인
    const balance = await kis.getBalance()
    const holding = balance.holdings.find((h: any) => {
      const code = cfg.symbol.replace(/\.(KS|KQ)$/, '')
      return h.symbol === code
    })

    if (signal.signal === '강력 매수' || signal.signal === '매수') {
      if (!holding) {
        // 매수
        const qty = Math.floor(cfg.buy_amount / currentPrice)
        if (qty > 0 && balance.cashBalance >= cfg.buy_amount) {
          orderResult = await kis.buyOrder(cfg.symbol, qty)
          action = 'buy'

          await c.env.DB.prepare(`
            INSERT INTO trade_history (bot_config_id, symbol, side, price, quantity, amount, mode, strategy, signal_score, order_id, status, note)
            VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, 'filled', ?)
          `).bind(id, cfg.symbol, currentPrice, qty, qty * currentPrice,
            cfg.mode, cfg.strategy, signal.score, orderResult.orderId,
            signal.reasons.join(', ')
          ).run()
        }
      }
    } else if (signal.signal === '강력 매도' || signal.signal === '매도') {
      if (holding && holding.quantity > 0) {
        // 매도
        orderResult = await kis.sellOrder(cfg.symbol, holding.quantity)
        action = 'sell'
        const pnl = (currentPrice - holding.avgPrice) * holding.quantity
        const pnlPct = (currentPrice - holding.avgPrice) / holding.avgPrice * 100

        await c.env.DB.prepare(`
          INSERT INTO trade_history (bot_config_id, symbol, side, price, quantity, amount, mode, strategy, signal_score, order_id, status, pnl, pnl_pct, note)
          VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, 'filled', ?, ?, ?)
        `).bind(id, cfg.symbol, currentPrice, holding.quantity,
          currentPrice * holding.quantity, cfg.mode, cfg.strategy, signal.score,
          orderResult.orderId, 'filled', pnl, pnlPct, signal.reasons.join(', ')
        ).run()

        // Slack 알림
        const slackSettings: any = await c.env.DB.prepare(
          "SELECT * FROM api_settings WHERE provider='slack'"
        ).first()
        if (slackSettings?.enabled && slackSettings?.webhook_url && cfg.slack_notify) {
          const slack = new SlackNotifier(slackSettings.webhook_url)
          await slack.notifyOrder({
            side: 'sell', symbol: cfg.symbol,
            name: cfg.symbol, price: currentPrice,
            quantity: holding.quantity,
            amount: currentPrice * holding.quantity,
            mode: cfg.mode, strategy: cfg.strategy,
            reasons: signal.reasons, pnl, pnlPct,
          })
        }
      }
    }

    return c.json({
      action,
      signal: signal.signal,
      score: signal.score,
      price: currentPrice,
      reasons: signal.reasons,
      order: orderResult,
      balance: {
        cash: balance.cashBalance,
        total: balance.totalEval,
      }
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── 신호 분석 헬퍼 ──────────────────────────────────────────────────────────
function calcEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const ema: number[] = []
  data.forEach((v, i) => {
    if (i === 0) { ema.push(v); return }
    ema.push(v * k + ema[i - 1] * (1 - k))
  })
  return ema
}

function calcRSILocal(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d)
  }
  avgGain /= period; avgLoss /= period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
}

function analyzeSignal(closes: number[], cfg: any) {
  const rsi = calcRSILocal(closes)
  const ema12 = calcEMA(closes, 12)
  const ema26 = calcEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const signalLine = calcEMA(macdLine, 9)

  const lastIdx = closes.length - 1
  const prevIdx = lastIdx - 1

  let score = 0
  const reasons: string[] = []

  if (rsi !== null) {
    if (rsi < cfg.rsi_oversold) { score += 2; reasons.push(`🔴 RSI 과매도(${rsi.toFixed(1)})`) }
    else if (rsi > cfg.rsi_overbought) { score -= 2; reasons.push(`🔵 RSI 과매수(${rsi.toFixed(1)})`) }
  }

  const lastMacd = macdLine[lastIdx]
  const prevMacd = macdLine[prevIdx]
  const lastSig = signalLine[lastIdx]
  const prevSig = signalLine[prevIdx]

  if (prevMacd < prevSig && lastMacd > lastSig) { score += 3; reasons.push('🟢 MACD 골든크로스') }
  else if (prevMacd > prevSig && lastMacd < lastSig) { score -= 3; reasons.push('🔴 MACD 데드크로스') }

  const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20
  if (closes[lastIdx] > sma20) { score += 1; reasons.push('📈 20일 이평선 위') }
  else { score -= 1; reasons.push('📉 20일 이평선 아래') }

  let signal = '중립'
  if (score >= 4) signal = '강력 매수'
  else if (score >= 2) signal = '매수'
  else if (score <= -4) signal = '강력 매도'
  else if (score <= -2) signal = '매도'

  return { signal, score, reasons }
}

export default bot
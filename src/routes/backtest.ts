import { Hono } from 'hono'
import { runBacktest } from '../lib/backtest'

type Bindings = {
  DB: D1Database
}

const backtest = new Hono<{ Bindings: Bindings }>()

// ─── 백테스팅 실행 ────────────────────────────────────────────────────────────
backtest.post('/run', async (c) => {
  const body = await c.req.json() as any
  const { symbol, strategy, params } = body

  if (!symbol || !strategy) {
    return c.json({ error: '종목 코드와 전략을 입력하세요' }, 400)
  }

  try {
    // Yahoo Finance에서 데이터 가져오기 (2년치)
    const range = params?.range || '2y'
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=${range}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    })
    if (!res.ok) throw new Error(`데이터 조회 실패: ${res.status}`)
    const raw: any = await res.json()
    const chart = raw?.chart?.result?.[0]
    if (!chart) throw new Error('차트 데이터 없음')

    const timestamps: number[] = chart.timestamp || []
    const ohlcvRaw = chart.indicators?.quote?.[0] || {}

    // null 데이터 필터링
    const valid = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: ohlcvRaw.open?.[i],
      high: ohlcvRaw.high?.[i],
      low: ohlcvRaw.low?.[i],
      close: ohlcvRaw.close?.[i],
      volume: ohlcvRaw.volume?.[i],
    })).filter(x => x.close != null)

    const dates = valid.map(x => x.date)
    const ohlcv = valid.map(x => ({
      open: x.open || x.close,
      high: x.high || x.close,
      low: x.low || x.close,
      close: x.close!,
      volume: x.volume || 0,
    }))

    const result = runBacktest(symbol, dates, ohlcv, {
      strategy,
      initialCapital: params?.initialCapital || 10_000_000,
      rsiOversold: params?.rsiOversold || 30,
      rsiOverbought: params?.rsiOverbought || 70,
      stopLossPct: params?.stopLossPct || 5,
      takeProfitPct: params?.takeProfitPct || 10,
      feeRate: params?.feeRate || 0.00015,
    })

    // DB에 저장
    await c.env.DB.prepare(`
      INSERT INTO backtest_results (symbol, strategy, start_date, end_date, initial_capital, final_capital,
        total_return_pct, max_drawdown_pct, win_rate, total_trades, sharpe_ratio, params, trades)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      result.symbol, result.strategy, result.startDate, result.endDate,
      result.initialCapital, result.finalCapital, result.totalReturnPct,
      result.maxDrawdownPct, result.winRate, result.totalTrades, result.sharpeRatio,
      JSON.stringify(params), JSON.stringify(result.trades.slice(-100))
    ).run()

    return c.json(result)
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── 백테스팅 히스토리 조회 ───────────────────────────────────────────────────
backtest.get('/history', async (c) => {
  const symbol = c.req.query('symbol') || ''
  let query = 'SELECT id, symbol, strategy, start_date, end_date, initial_capital, final_capital, total_return_pct, max_drawdown_pct, win_rate, total_trades, sharpe_ratio, created_at FROM backtest_results'
  const bindings: any[] = []
  if (symbol) {
    query += ' WHERE symbol=?'
    bindings.push(symbol.toUpperCase())
  }
  query += ' ORDER BY created_at DESC LIMIT 50'

  const stmt = c.env.DB.prepare(query)
  const { results } = bindings.length > 0 ? await stmt.bind(...bindings).all() : await stmt.all()
  return c.json({ results })
})

// ─── 백테스팅 상세 조회 ───────────────────────────────────────────────────────
backtest.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result: any = await c.env.DB.prepare('SELECT * FROM backtest_results WHERE id=?').bind(id).first()
  if (!result) return c.json({ error: '결과를 찾을 수 없습니다' }, 404)

  result.trades = JSON.parse(result.trades || '[]')
  result.params = JSON.parse(result.params || '{}')
  return c.json(result)
})

export default backtest
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import botRoutes from './routes/bot'
import backtestRoutes from './routes/backtest'
import settingsRoutes from './routes/settings'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// ─── Yahoo Finance API Helper ─────────────────────────────────────────────────
async function fetchYahooQuote(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  })
  if (!res.ok) throw new Error(`Yahoo Finance 요청 실패: ${res.status}`)
  return res.json() as any
}

async function fetchYahooSearch(query: string) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&lang=ko-KR&region=KR&quotesCount=6&newsCount=0`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  })
  if (!res.ok) throw new Error('검색 실패')
  return res.json() as any
}

// ─── 기술적 지표 계산 ─────────────────────────────────────────────────────────
function calcSMA(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  })
}
function calcEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1); const ema: number[] = []
  data.forEach((v, i) => { if (i === 0) { ema.push(v); return }; ema.push(v * k + ema[i - 1] * (1 - k)) })
  return ema
}
function calcRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(period).fill(null)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) avgGain += d; else avgLoss += Math.abs(d) }
  avgGain /= period; avgLoss /= period
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }
  return result
}
function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12); const ema26 = calcEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const signalLine = calcEMA(macdLine, 9)
  return { macdLine, signalLine, histogram: macdLine.map((v, i) => v - signalLine[i]) }
}
function calcBollingerBands(closes: number[], period = 20, stdDev = 2) {
  const sma = calcSMA(closes, period)
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, middle: null, lower: null }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = sma[i]!; const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period; const sd = Math.sqrt(variance)
    return { upper: mean + stdDev * sd, middle: mean, lower: mean - stdDev * sd }
  })
}
function calcStochastic(highs: number[], lows: number[], closes: number[], k = 14, d = 3) {
  const kLine: (number | null)[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < k - 1) { kLine.push(null); continue }
    const hSlice = highs.slice(i - k + 1, i + 1); const lSlice = lows.slice(i - k + 1, i + 1)
    const highest = Math.max(...hSlice); const lowest = Math.min(...lSlice)
    kLine.push(highest === lowest ? 50 : ((closes[i] - lowest) / (highest - lowest)) * 100)
  }
  const dLine: (number | null)[] = kLine.map((_, i) => {
    const validK = kLine.slice(Math.max(0, i - d + 1), i + 1).filter(v => v !== null) as number[]
    if (validK.length < d) return null; return validK.reduce((a, b) => a + b, 0) / d
  })
  return { kLine, dLine }
}
function generateSignal(rsi: (number | null)[], macd: any, close: number[], sma20: (number | null)[], bb: any[]) {
  const lastRsi = rsi[rsi.length - 1] ?? 50
  const lastMacd = macd.macdLine[macd.macdLine.length - 1]; const prevMacd = macd.macdLine[macd.macdLine.length - 2]
  const lastSignal = macd.signalLine[macd.signalLine.length - 1]; const prevSignal = macd.signalLine[macd.signalLine.length - 2]
  const lastClose = close[close.length - 1]; const lastSma20 = sma20[sma20.length - 1]; const lastBb = bb[bb.length - 1]
  let score = 0; const reasons: string[] = []
  if (lastRsi < 30) { score += 2; reasons.push('🔴 RSI 과매도 구간 (매수 신호)') }
  else if (lastRsi > 70) { score -= 2; reasons.push('🔵 RSI 과매수 구간 (매도 신호)') }
  else if (lastRsi < 50) { score += 1; reasons.push('⬇️ RSI 중립 이하') }
  else { score -= 1; reasons.push('⬆️ RSI 중립 이상') }
  if (prevMacd < prevSignal && lastMacd > lastSignal) { score += 3; reasons.push('🟢 MACD 골든 크로스 (강한 매수)') }
  else if (prevMacd > prevSignal && lastMacd < lastSignal) { score -= 3; reasons.push('🔴 MACD 데드 크로스 (강한 매도)') }
  else if (lastMacd > lastSignal) { score += 1; reasons.push('📈 MACD 시그널선 위') }
  else { score -= 1; reasons.push('📉 MACD 시그널선 아래') }
  if (lastBb.lower && lastClose < lastBb.lower) { score += 2; reasons.push('📊 볼린저 밴드 하단 이탈 (반등 가능)') }
  else if (lastBb.upper && lastClose > lastBb.upper) { score -= 2; reasons.push('📊 볼린저 밴드 상단 돌파 (과열)') }
  if (lastSma20 && lastClose > lastSma20) { score += 1; reasons.push('📈 20일 이동평균선 위 (상승 추세)') }
  else if (lastSma20) { score -= 1; reasons.push('📉 20일 이동평균선 아래 (하락 추세)') }
  let signal = '중립'; let color = 'yellow'
  if (score >= 4) { signal = '강력 매수'; color = 'green' }
  else if (score >= 2) { signal = '매수'; color = 'lightgreen' }
  else if (score <= -4) { signal = '강력 매도'; color = 'red' }
  else if (score <= -2) { signal = '매도'; color = 'orange' }
  return { signal, color, score, reasons }
}

// ─── API 라우트 ───────────────────────────────────────────────────────────────
app.get('/api/search', async (c) => {
  const query = c.req.query('q') || ''
  if (!query) return c.json({ error: '검색어를 입력하세요' }, 400)
  try {
    const data = await fetchYahooSearch(query)
    const quotes = (data.quotes || []).map((q: any) => ({
      symbol: q.symbol, name: q.shortname || q.longname || q.symbol,
      exchange: q.exchange, type: q.quoteType,
    }))
    return c.json({ quotes })
  } catch (e: any) { return c.json({ error: e.message }, 500) }
})

app.get('/api/analyze/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  try {
    const raw = await fetchYahooQuote(symbol)
    const chart = raw?.chart?.result?.[0]
    if (!chart) return c.json({ error: '종목 데이터를 찾을 수 없습니다' }, 404)
    const meta = chart.meta; const timestamps: number[] = chart.timestamp || []
    const ohlcv = chart.indicators?.quote?.[0] || {}
    const closes: number[] = ohlcv.close || []; const opens: number[] = ohlcv.open || []
    const highs: number[] = ohlcv.high || []; const lows: number[] = ohlcv.low || []; const volumes: number[] = ohlcv.volume || []
    const valid = closes.map((c, i) => ({ c, o: opens[i], h: highs[i], l: lows[i], v: volumes[i], t: timestamps[i] })).filter(x => x.c != null)
    const vCloses = valid.map(x => x.c); const vHighs = valid.map(x => x.h); const vLows = valid.map(x => x.l)
    const vDates = valid.map(x => new Date(x.t * 1000).toISOString().slice(0, 10))
    const sma5 = calcSMA(vCloses, 5); const sma20 = calcSMA(vCloses, 20)
    const sma60 = calcSMA(vCloses, 60); const sma120 = calcSMA(vCloses, 120)
    const rsi = calcRSI(vCloses); const macd = calcMACD(vCloses)
    const bb = calcBollingerBands(vCloses); const stoch = calcStochastic(vHighs, vLows, vCloses)
    const signal = generateSignal(rsi, macd, vCloses, sma20, bb)
    const lastClose = vCloses[vCloses.length - 1]; const prevClose = vCloses[vCloses.length - 2]
    const change = lastClose - prevClose; const changePct = (change / prevClose) * 100
    const yearSlice = vCloses.slice(-252); const week52High = Math.max(...yearSlice); const week52Low = Math.min(...yearSlice)
    return c.json({
      symbol, name: meta.shortName || meta.longName || symbol,
      currency: meta.currency || 'KRW', exchange: meta.exchangeName,
      currentPrice: lastClose, change, changePct,
      week52High, week52Low,
      fromHigh: ((lastClose - week52High) / week52High) * 100,
      fromLow: ((lastClose - week52Low) / week52Low) * 100,
      volume: valid[valid.length - 1].v, marketCap: meta.marketCap,
      dates: vDates,
      ohlcv: valid.map(x => ({ open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v })),
      indicators: {
        sma5, sma20, sma60, sma120, rsi,
        macd: macd.macdLine, macdSignal: macd.signalLine, macdHistogram: macd.histogram,
        bbUpper: bb.map(b => b.upper), bbMiddle: bb.map(b => b.middle), bbLower: bb.map(b => b.lower),
        stochK: stoch.kLine, stochD: stoch.dLine,
      },
      signal,
    })
  } catch (e: any) { return c.json({ error: e.message }, 500) }
})

// ─── 봇 / 백테스팅 / 설정 라우트 마운트 ─────────────────────────────────────
app.route('/api/bots', botRoutes)
app.route('/api/backtest', backtestRoutes)
app.route('/api/settings', settingsRoutes)

// ─── DB 초기화 엔드포인트 ─────────────────────────────────────────────────────
app.post('/api/db/init', async (c) => {
  try {
    const sqls = [
      `CREATE TABLE IF NOT EXISTS bot_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, symbol TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'mock', strategy TEXT NOT NULL DEFAULT 'combined',
        enabled INTEGER NOT NULL DEFAULT 0, buy_amount INTEGER NOT NULL DEFAULT 500000,
        stop_loss_pct REAL NOT NULL DEFAULT 5.0, take_profit_pct REAL NOT NULL DEFAULT 10.0,
        rsi_oversold REAL NOT NULL DEFAULT 30, rsi_overbought REAL NOT NULL DEFAULT 70,
        slack_notify INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_config_id INTEGER, symbol TEXT NOT NULL, side TEXT NOT NULL,
        price REAL NOT NULL, quantity INTEGER NOT NULL, amount REAL NOT NULL,
        mode TEXT NOT NULL DEFAULT 'mock', strategy TEXT, signal_score INTEGER,
        order_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
        pnl REAL, pnl_pct REAL, note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bot_config_id) REFERENCES bot_configs(id)
      )`,
      `CREATE TABLE IF NOT EXISTS backtest_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL, strategy TEXT NOT NULL,
        start_date TEXT NOT NULL, end_date TEXT NOT NULL,
        initial_capital REAL NOT NULL, final_capital REAL NOT NULL,
        total_return_pct REAL NOT NULL, max_drawdown_pct REAL NOT NULL,
        win_rate REAL NOT NULL, total_trades INTEGER NOT NULL,
        sharpe_ratio REAL, params TEXT, trades TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS api_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL UNIQUE, app_key TEXT, app_secret TEXT,
        account_no TEXT, webhook_url TEXT, enabled INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ]
    for (const sql of sqls) {
      await c.env.DB.prepare(sql).run()
    }
    return c.json({ message: '✅ DB 초기화 완료 (4개 테이블 생성)' })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── 메인 페이지 ─────────────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.html(mainPageHTML())
})

function mainPageHTML(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>📈 StockBot Pro - 자동 트레이딩 대시보드</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <style>
    body { background: #0a0d1a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; }
    .card-dark { background: #0d111e; border: 1px solid #1a2030; border-radius: 10px; }
    .nav-tab { transition: all 0.2s; cursor: pointer; border-bottom: 2px solid transparent; }
    .nav-tab.active { color: #6366f1; border-bottom-color: #6366f1; }
    .tab-section { display: none; }
    .tab-section.active { display: block; }
    .btn-primary { background: linear-gradient(135deg,#6366f1,#8b5cf6); color: white; border-radius: 8px; padding: 8px 16px; font-size: 14px; cursor: pointer; border: none; transition: opacity 0.2s; }
    .btn-primary:hover { opacity: 0.85; }
    .btn-success { background: #065f46; color: #34d399; border: 1px solid #34d399; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
    .btn-danger { background: #7f1d1d; color: #f87171; border: 1px solid #f87171; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
    .btn-warn { background: #78350f; color: #fbbf24; border: 1px solid #fbbf24; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
    .badge-buy { background: #065f46; color: #34d399; border: 1px solid #34d399; padding: 2px 8px; border-radius: 9999px; font-size: 11px; }
    .badge-sell { background: #7f1d1d; color: #f87171; border: 1px solid #f87171; padding: 2px 8px; border-radius: 9999px; font-size: 11px; }
    .badge-mock { background: #1e3a5f; color: #60a5fa; border: 1px solid #60a5fa; padding: 2px 8px; border-radius: 9999px; font-size: 11px; }
    .badge-real { background: #4a1942; color: #e879f9; border: 1px solid #e879f9; padding: 2px 8px; border-radius: 9999px; font-size: 11px; }
    .badge-on { background: #065f46; color: #34d399; border-radius: 9999px; padding: 2px 8px; font-size: 11px; }
    .badge-off { background: #374151; color: #9ca3af; border-radius: 9999px; padding: 2px 8px; font-size: 11px; }
    .up { color: #ef4444; } .down { color: #3b82f6; }
    input, select, textarea { background: #111827; border: 1px solid #374151; color: #e0e0e0; border-radius: 8px; padding: 8px 12px; font-size: 14px; width: 100%; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: #6366f1; }
    ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: #111827; } ::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
    .signal-strong-buy { background: linear-gradient(135deg,#065f46,#064e3b); border: 1px solid #34d399; }
    .signal-buy { background: linear-gradient(135deg,#14532d,#0f3d23); border: 1px solid #4ade80; }
    .signal-sell { background: linear-gradient(135deg,#7f1d1d,#6b1212); border: 1px solid #f87171; }
    .signal-strong-sell { background: linear-gradient(135deg,#991b1b,#7f1d1d); border: 1px solid #ef4444; }
    .signal-neutral { background: linear-gradient(135deg,#78350f,#62270a); border: 1px solid #f59e0b; }
    .skeleton { background: linear-gradient(90deg,#111827 25%,#1f2937 50%,#111827 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
    .tab-btn { transition: all 0.2s; }
    .tab-btn.active { background: #6366f1; color: white; }
    .search-item:hover { background: #1f2937; }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .modal-box { background: #111827; border: 1px solid #374151; border-radius: 16px; width: 90%; max-width: 560px; max-height: 90vh; overflow-y: auto; padding: 24px; }
    .pulse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .pulse-green { background: #34d399; animation: pulse 2s infinite; }
    .pulse-gray { background: #6b7280; }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    .progress-bar { height: 6px; border-radius: 3px; background: #1f2937; overflow: hidden; }
    .progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }
    .result-positive { color: #34d399; }
    .result-negative { color: #f87171; }
  </style>
</head>
<body class="min-h-screen">

<!-- 헤더 -->
<header class="border-b border-gray-800 px-6 py-4 flex items-center justify-between sticky top-0 z-50" style="background:#0a0d1a;">
  <div class="flex items-center gap-3">
    <div class="w-10 h-10 rounded-xl flex items-center justify-center" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">
      <i class="fas fa-robot text-white"></i>
    </div>
    <div>
      <h1 class="font-bold text-lg text-white">StockBot Pro</h1>
      <p class="text-xs text-gray-500">한국투자증권 자동 트레이딩 시스템</p>
    </div>
  </div>
  <div class="flex items-center gap-4">
    <div id="statsBar" class="hidden md:flex items-center gap-4 text-xs text-gray-400">
      <span>총 거래: <span id="hdrTrades" class="text-white font-semibold">-</span></span>
      <span>총 손익: <span id="hdrPnl" class="font-semibold">-</span></span>
      <span>승률: <span id="hdrWinRate" class="text-white font-semibold">-</span></span>
    </div>
    <button onclick="initDB()" class="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 transition-all">
      <i class="fas fa-database mr-1"></i>DB 초기화
    </button>
  </div>
</header>

<!-- 네비게이션 탭 -->
<div class="border-b border-gray-800 px-6" style="background:#0a0d1a;">
  <nav class="flex gap-0">
    <button onclick="switchNav('analyze')" id="nav-analyze" class="nav-tab active px-5 py-3.5 text-sm font-medium text-gray-400 flex items-center gap-2">
      <i class="fas fa-chart-line"></i> 주식 분석
    </button>
    <button onclick="switchNav('bot')" id="nav-bot" class="nav-tab px-5 py-3.5 text-sm font-medium text-gray-400 flex items-center gap-2">
      <i class="fas fa-robot"></i> 자동 트레이딩 봇
    </button>
    <button onclick="switchNav('backtest')" id="nav-backtest" class="nav-tab px-5 py-3.5 text-sm font-medium text-gray-400 flex items-center gap-2">
      <i class="fas fa-flask"></i> 백테스팅
    </button>
    <button onclick="switchNav('trades')" id="nav-trades" class="nav-tab px-5 py-3.5 text-sm font-medium text-gray-400 flex items-center gap-2">
      <i class="fas fa-history"></i> 거래 내역
    </button>
    <button onclick="switchNav('settings')" id="nav-settings" class="nav-tab px-5 py-3.5 text-sm font-medium text-gray-400 flex items-center gap-2">
      <i class="fas fa-gear"></i> API 설정
    </button>
  </nav>
</div>

<div class="max-w-screen-2xl mx-auto px-4 py-6">

<!-- ════════ TAB 1: 주식 분석 ════════ -->
<div id="tab-analyze" class="tab-section active">
  <div class="card p-6 mb-6">
    <div class="flex flex-col md:flex-row gap-4 items-start md:items-center">
      <div class="flex-1 relative">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm"></i>
        <input id="searchInput" type="text" placeholder="종목명 또는 티커 입력 (예: 삼성전자, AAPL, 005930.KS)" style="padding-left:2.5rem;"/>
        <div id="searchDropdown" class="absolute top-full left-0 right-0 mt-1 card z-50 hidden overflow-hidden"></div>
      </div>
      <button onclick="analyzeStock()" class="btn-primary flex items-center gap-2" style="white-space:nowrap;">
        <i class="fas fa-magnifying-glass-chart"></i> 분석 시작
      </button>
    </div>
    <div class="mt-4 flex flex-wrap gap-2">
      <span class="text-xs text-gray-500 mr-1 self-center">인기 종목:</span>
      <button onclick="quickAnalyze('005930.KS')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">삼성전자</button>
      <button onclick="quickAnalyze('000660.KS')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">SK하이닉스</button>
      <button onclick="quickAnalyze('035720.KS')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">카카오</button>
      <button onclick="quickAnalyze('035420.KS')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">NAVER</button>
      <button onclick="quickAnalyze('AAPL')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">Apple</button>
      <button onclick="quickAnalyze('TSLA')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">Tesla</button>
      <button onclick="quickAnalyze('NVDA')" class="px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1a2030;border:1px solid #2a3040;color:#9ca3af;">NVIDIA</button>
    </div>
  </div>
  <div id="loading" class="hidden text-center py-20">
    <div class="inline-block w-14 h-14 rounded-full border-4 border-indigo-500 border-t-transparent animate-spin mb-4"></div>
    <p class="text-gray-400">데이터를 불러오는 중...</p>
  </div>
  <div id="errorMsg" class="hidden card p-6 text-center">
    <i class="fas fa-triangle-exclamation text-3xl text-yellow-500 mb-3"></i>
    <p id="errorText" class="text-gray-400"></p>
  </div>
  <div id="result" class="hidden space-y-6">
    <div class="card p-6">
      <div class="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3 mb-1">
            <h2 id="stockName" class="text-2xl font-bold text-white"></h2>
            <span id="stockSymbol" class="text-sm px-2 py-0.5 rounded" style="background:#1f2937;color:#9ca3af;"></span>
            <span id="stockExchange" class="text-xs px-2 py-0.5 rounded" style="background:#1a2030;color:#6366f1;"></span>
          </div>
          <div class="flex items-baseline gap-3">
            <span id="stockPrice" class="text-4xl font-bold text-white"></span>
            <span id="stockChange" class="text-lg font-semibold"></span>
          </div>
          <div class="flex gap-4 mt-2 text-xs text-gray-500">
            <span>52주 고가: <span id="w52High" class="text-gray-300"></span></span>
            <span>52주 저가: <span id="w52Low" class="text-gray-300"></span></span>
            <span>거래량: <span id="stockVolume" class="text-gray-300"></span></span>
          </div>
        </div>
        <div id="signalBox" class="p-5 rounded-xl min-w-52">
          <div class="text-center">
            <div class="text-xs text-gray-400 mb-1">종합 매매 신호</div>
            <div id="signalText" class="text-2xl font-bold"></div>
            <div id="signalScore" class="text-xs mt-1 text-gray-400"></div>
          </div>
          <div id="signalReasons" class="mt-3 space-y-1"></div>
        </div>
      </div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="card p-4"><div class="text-xs text-gray-500 mb-1">RSI (14)</div><div id="rsiVal" class="text-2xl font-bold"></div><div id="rsiStatus" class="text-xs mt-1"></div><div class="mt-2 h-2 rounded-full" style="background:#1f2937;"><div id="rsiBar" class="h-2 rounded-full transition-all" style="background:linear-gradient(90deg,#6366f1,#8b5cf6);"></div></div></div>
      <div class="card p-4"><div class="text-xs text-gray-500 mb-1">MACD</div><div id="macdVal" class="text-2xl font-bold"></div><div id="macdStatus" class="text-xs mt-1 text-gray-400"></div></div>
      <div class="card p-4"><div class="text-xs text-gray-500 mb-1">볼린저 밴드 위치</div><div id="bbVal" class="text-2xl font-bold"></div><div id="bbStatus" class="text-xs mt-1 text-gray-400"></div></div>
      <div class="card p-4"><div class="text-xs text-gray-500 mb-1">스토캐스틱 K/D</div><div id="stochVal" class="text-2xl font-bold"></div><div id="stochStatus" class="text-xs mt-1 text-gray-400"></div></div>
    </div>
    <div class="card p-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-white">📊 차트 분석</h3>
        <div class="flex gap-1 p-1 rounded-lg" style="background:#0a0d1a;">
          <button onclick="switchTab('price')" id="tab-price" class="tab-btn active px-3 py-1.5 rounded-md text-xs font-medium text-gray-400">가격+MA</button>
          <button onclick="switchTab('rsi')" id="tab-rsi" class="tab-btn px-3 py-1.5 rounded-md text-xs font-medium text-gray-400">RSI</button>
          <button onclick="switchTab('macd')" id="tab-macd" class="tab-btn px-3 py-1.5 rounded-md text-xs font-medium text-gray-400">MACD</button>
          <button onclick="switchTab('bb')" id="tab-bb" class="tab-btn px-3 py-1.5 rounded-md text-xs font-medium text-gray-400">볼린저</button>
          <button onclick="switchTab('stoch')" id="tab-stoch" class="tab-btn px-3 py-1.5 rounded-md text-xs font-medium text-gray-400">스토캐스틱</button>
          <button onclick="switchTab('volume')" id="tab-volume" class="tab-btn px-3 py-1.5 rounded-md text-xs font-medium text-gray-400">거래량</button>
        </div>
      </div>
      <div style="position:relative;height:420px;"><canvas id="mainChart"></canvas></div>
    </div>
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-4">📐 이동평균선 분석</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="card-dark p-4"><div class="text-xs text-gray-500 mb-1">SMA 5일</div><div id="sma5" class="text-lg font-bold text-white"></div><div id="sma5diff" class="text-xs mt-1"></div></div>
        <div class="card-dark p-4"><div class="text-xs text-gray-500 mb-1">SMA 20일</div><div id="sma20" class="text-lg font-bold text-white"></div><div id="sma20diff" class="text-xs mt-1"></div></div>
        <div class="card-dark p-4"><div class="text-xs text-gray-500 mb-1">SMA 60일</div><div id="sma60" class="text-lg font-bold text-white"></div><div id="sma60diff" class="text-xs mt-1"></div></div>
        <div class="card-dark p-4"><div class="text-xs text-gray-500 mb-1">SMA 120일</div><div id="sma120" class="text-lg font-bold text-white"></div><div id="sma120diff" class="text-xs mt-1"></div></div>
      </div>
    </div>
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-4">📋 최근 20일 가격 데이터</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-xs text-gray-500 border-b border-gray-800">
            <th class="text-left py-2 pr-4">날짜</th><th class="text-right py-2 px-4">시가</th><th class="text-right py-2 px-4">고가</th><th class="text-right py-2 px-4">저가</th><th class="text-right py-2 px-4">종가</th><th class="text-right py-2 px-4">거래량</th><th class="text-right py-2 px-4">등락</th><th class="text-right py-2 pl-4">RSI</th>
          </tr></thead>
          <tbody id="priceTable"></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ════════ TAB 2: 자동 트레이딩 봇 ════════ -->
<div id="tab-bot" class="tab-section">
  <div class="flex items-center justify-between mb-6">
    <div>
      <h2 class="text-xl font-bold text-white">🤖 자동 트레이딩 봇 관리</h2>
      <p class="text-sm text-gray-500 mt-1">한국투자증권 API 연동 · 실계좌/모의계좌 지원</p>
    </div>
    <button onclick="openBotModal()" class="btn-primary flex items-center gap-2">
      <i class="fas fa-plus"></i> 봇 추가
    </button>
  </div>
  <!-- 봇 목록 -->
  <div id="botList" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6"></div>
  <!-- 빈 상태 -->
  <div id="botEmpty" class="hidden card p-12 text-center">
    <div class="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4" style="background:#1f2937;">
      <i class="fas fa-robot text-3xl text-gray-500"></i>
    </div>
    <h3 class="text-lg font-semibold text-gray-400 mb-2">봇이 없습니다</h3>
    <p class="text-sm text-gray-600 mb-4">첫 번째 트레이딩 봇을 만들어 보세요</p>
    <button onclick="openBotModal()" class="btn-primary">+ 봇 만들기</button>
  </div>
</div>

<!-- ════════ TAB 3: 백테스팅 ════════ -->
<div id="tab-backtest" class="tab-section">
  <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
    <!-- 설정 패널 -->
    <div class="lg:col-span-1">
      <div class="card p-6">
        <h3 class="font-semibold text-white mb-4 flex items-center gap-2"><i class="fas fa-flask text-indigo-400"></i> 백테스팅 설정</h3>
        <div class="space-y-4">
          <div>
            <label class="text-xs text-gray-400 mb-1 block">종목 코드</label>
            <input id="btSymbol" type="text" placeholder="005930.KS, AAPL ..." value="005930.KS"/>
          </div>
          <div>
            <label class="text-xs text-gray-400 mb-1 block">전략</label>
            <select id="btStrategy">
              <option value="combined">복합 전략 (RSI+MACD+BB)</option>
              <option value="rsi">RSI 전략</option>
              <option value="macd">MACD 전략</option>
              <option value="bb">볼린저 밴드 전략</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-gray-400 mb-1 block">기간</label>
            <select id="btRange">
              <option value="1y">1년</option>
              <option value="2y" selected>2년</option>
              <option value="5y">5년</option>
            </select>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-gray-400 mb-1 block">초기 자본 (원)</label>
              <input id="btCapital" type="number" value="10000000"/>
            </div>
            <div>
              <label class="text-xs text-gray-400 mb-1 block">수수료율 (%)</label>
              <input id="btFee" type="number" value="0.015" step="0.001"/>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-gray-400 mb-1 block">손절 (%)</label>
              <input id="btStopLoss" type="number" value="5"/>
            </div>
            <div>
              <label class="text-xs text-gray-400 mb-1 block">익절 (%)</label>
              <input id="btTakeProfit" type="number" value="10"/>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-gray-400 mb-1 block">RSI 과매도</label>
              <input id="btRsiOversold" type="number" value="30"/>
            </div>
            <div>
              <label class="text-xs text-gray-400 mb-1 block">RSI 과매수</label>
              <input id="btRsiOverbought" type="number" value="70"/>
            </div>
          </div>
          <button onclick="runBacktest()" id="btRunBtn" class="btn-primary w-full flex items-center justify-center gap-2">
            <i class="fas fa-play"></i> 백테스팅 실행
          </button>
        </div>
      </div>
      <!-- 백테스팅 히스토리 -->
      <div class="card p-6 mt-4">
        <h3 class="font-semibold text-white mb-3 text-sm">📋 최근 백테스팅 결과</h3>
        <div id="btHistory" class="space-y-2 text-xs text-gray-400">로딩 중...</div>
      </div>
    </div>
    <!-- 결과 패널 -->
    <div class="lg:col-span-2">
      <div id="btLoading" class="hidden card p-12 text-center">
        <div class="inline-block w-12 h-12 rounded-full border-4 border-indigo-500 border-t-transparent animate-spin mb-4"></div>
        <p class="text-gray-400">백테스팅 실행 중... 잠시만 기다려주세요</p>
      </div>
      <div id="btResult" class="hidden space-y-4">
        <!-- 핵심 지표 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="card p-4 text-center">
            <div class="text-xs text-gray-500 mb-1">총 수익률</div>
            <div id="btReturnPct" class="text-2xl font-bold"></div>
            <div class="text-xs text-gray-500 mt-1">전략</div>
          </div>
          <div class="card p-4 text-center">
            <div class="text-xs text-gray-500 mb-1">Buy&Hold 수익률</div>
            <div id="btBnhReturn" class="text-2xl font-bold"></div>
            <div class="text-xs text-gray-500 mt-1">단순 보유</div>
          </div>
          <div class="card p-4 text-center">
            <div class="text-xs text-gray-500 mb-1">최대 낙폭</div>
            <div id="btDrawdown" class="text-2xl font-bold text-red-400"></div>
            <div class="text-xs text-gray-500 mt-1">MDD</div>
          </div>
          <div class="card p-4 text-center">
            <div class="text-xs text-gray-500 mb-1">승률</div>
            <div id="btWinRate" class="text-2xl font-bold text-green-400"></div>
            <div class="text-xs text-gray-500 mt-1">Win Rate</div>
          </div>
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="card p-4"><div class="text-xs text-gray-500">최종 자본</div><div id="btFinalCapital" class="text-lg font-bold text-white mt-1"></div></div>
          <div class="card p-4"><div class="text-xs text-gray-500">총 거래</div><div id="btTotalTrades" class="text-lg font-bold text-white mt-1"></div></div>
          <div class="card p-4"><div class="text-xs text-gray-500">샤프 비율</div><div id="btSharpe" class="text-lg font-bold text-white mt-1"></div></div>
          <div class="card p-4"><div class="text-xs text-gray-500">손익비</div><div id="btProfitFactor" class="text-lg font-bold text-white mt-1"></div></div>
        </div>
        <!-- 자산 곡선 차트 -->
        <div class="card p-6">
          <h3 class="font-semibold text-white mb-4">📈 자산 곡선 (Equity Curve)</h3>
          <div style="position:relative;height:300px;"><canvas id="btChart"></canvas></div>
        </div>
        <!-- 거래 내역 -->
        <div class="card p-6">
          <h3 class="font-semibold text-white mb-4">📋 거래 내역 (최근 30건)</h3>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead><tr class="text-gray-500 border-b border-gray-800">
                <th class="text-left py-2 pr-3">날짜</th><th class="text-center py-2 px-3">매수/매도</th><th class="text-right py-2 px-3">가격</th><th class="text-right py-2 px-3">수량</th><th class="text-right py-2 px-3">손익</th><th class="text-left py-2 pl-3">사유</th>
              </tr></thead>
              <tbody id="btTradeTable"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div id="btEmpty" class="card p-12 text-center">
        <i class="fas fa-flask text-4xl text-gray-600 mb-3"></i>
        <p class="text-gray-500">설정을 입력하고 백테스팅을 실행하세요</p>
      </div>
    </div>
  </div>
</div>

<!-- ════════ TAB 4: 거래 내역 ════════ -->
<div id="tab-trades" class="tab-section">
  <div class="flex items-center justify-between mb-6">
    <h2 class="text-xl font-bold text-white">📋 거래 내역</h2>
    <button onclick="loadTrades()" class="btn-primary text-sm flex items-center gap-2">
      <i class="fas fa-refresh"></i> 새로고침
    </button>
  </div>
  <!-- 통계 -->
  <div id="tradeStats" class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6"></div>
  <!-- 테이블 -->
  <div class="card p-6">
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr class="text-xs text-gray-500 border-b border-gray-800">
          <th class="text-left py-2 pr-4">시간</th><th class="text-left py-2 px-4">종목</th><th class="text-center py-2 px-4">구분</th><th class="text-right py-2 px-4">가격</th><th class="text-right py-2 px-4">수량</th><th class="text-right py-2 px-4">금액</th><th class="text-right py-2 px-4">손익</th><th class="text-center py-2 px-4">모드</th><th class="text-left py-2 pl-4">전략/사유</th>
        </tr></thead>
        <tbody id="tradeTable"><tr><td colspan="9" class="text-center py-8 text-gray-500">거래 내역을 불러오는 중...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<!-- ════════ TAB 5: API 설정 ════════ -->
<div id="tab-settings" class="tab-section">
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- 모의계좌 설정 -->
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-1 flex items-center gap-2">
        <span class="badge-mock">모의계좌</span> 한국투자증권 모의계좌 API
      </h3>
      <p class="text-xs text-gray-500 mb-4">https://openapivts.koreainvestment.com:29443</p>
      <div class="space-y-3">
        <div><label class="text-xs text-gray-400 mb-1 block">App Key</label><input id="mockAppKey" type="text" placeholder="P-xxxxxxxx..."/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">App Secret</label><input id="mockAppSecret" type="password" placeholder="••••••••••••"/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">계좌번호 (예: 50012345-01)</label><input id="mockAccountNo" type="text" placeholder="50012345-01"/></div>
        <div class="flex gap-2 mt-2">
          <button onclick="saveApiSettings('kis_mock')" class="btn-primary flex-1 text-sm">저장</button>
          <button onclick="testKisApi('mock')" class="btn-warn text-sm px-4">연결 테스트</button>
        </div>
        <div id="mockTestResult" class="text-xs p-2 rounded hidden"></div>
      </div>
    </div>
    <!-- 실계좌 설정 -->
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-1 flex items-center gap-2">
        <span class="badge-real">실계좌</span> 한국투자증권 실계좌 API
      </h3>
      <p class="text-xs text-gray-500 mb-4">https://openapi.koreainvestment.com:9443</p>
      <div class="space-y-3">
        <div><label class="text-xs text-gray-400 mb-1 block">App Key</label><input id="realAppKey" type="text" placeholder="xxxxxxxx..."/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">App Secret</label><input id="realAppSecret" type="password" placeholder="••••••••••••"/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">계좌번호 (예: 50012345-01)</label><input id="realAccountNo" type="text" placeholder="50012345-01"/></div>
        <div class="flex gap-2 mt-2">
          <button onclick="saveApiSettings('kis_real')" class="btn-primary flex-1 text-sm">저장</button>
          <button onclick="testKisApi('real')" class="btn-warn text-sm px-4">연결 테스트</button>
        </div>
        <div id="realTestResult" class="text-xs p-2 rounded hidden"></div>
        <div class="text-xs text-yellow-500 flex gap-2 items-start">
          <i class="fas fa-exclamation-triangle mt-0.5"></i>
          <span>실계좌는 실제 금전 거래가 발생합니다. 신중히 사용하세요.</span>
        </div>
      </div>
    </div>
    <!-- Slack 웹훅 설정 -->
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-1 flex items-center gap-2">
        <i class="fab fa-slack text-purple-400"></i> Slack 알림 연동
      </h3>
      <p class="text-xs text-gray-500 mb-4">Incoming Webhook URL을 입력하세요</p>
      <div class="space-y-3">
        <div><label class="text-xs text-gray-400 mb-1 block">Webhook URL</label><input id="slackWebhook" type="text" placeholder="https://hooks.slack.com/services/..."/></div>
        <div class="flex gap-2 mt-2">
          <button onclick="saveApiSettings('slack')" class="btn-primary flex-1 text-sm">저장</button>
          <button onclick="testSlack()" class="btn-warn text-sm px-4">테스트 전송</button>
        </div>
        <div id="slackTestResult" class="text-xs p-2 rounded hidden"></div>
      </div>
      <div class="mt-4 p-3 rounded-lg text-xs text-gray-400" style="background:#0d111e;border:1px solid #1a2030;">
        <p class="font-semibold text-gray-300 mb-2">📌 Slack Webhook 설정 방법</p>
        <ol class="space-y-1 list-decimal list-inside">
          <li>Slack 앱 → "Apps" → "Incoming WebHooks" 검색</li>
          <li>"Add to Slack" 클릭 → 채널 선택</li>
          <li>Webhook URL 복사 → 위에 붙여넣기</li>
        </ol>
      </div>
    </div>
    <!-- API 도움말 -->
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-3 flex items-center gap-2">
        <i class="fas fa-book text-blue-400"></i> 한국투자증권 API 신청 방법
      </h3>
      <div class="space-y-3 text-sm text-gray-400">
        <div class="p-3 rounded-lg" style="background:#0d111e;border:1px solid #1a2030;">
          <p class="font-semibold text-white mb-2">모의계좌 API (무료)</p>
          <ol class="space-y-1 list-decimal list-inside text-xs">
            <li>한국투자증권 홈페이지 로그인</li>
            <li>트레이딩 → Open API → KIS Developers</li>
            <li>계좌 개설 (모의계좌)</li>
            <li>앱 등록 → App Key, App Secret 발급</li>
          </ol>
        </div>
        <div class="p-3 rounded-lg" style="background:#0d111e;border:1px solid #1a2030;">
          <p class="font-semibold text-white mb-2">실계좌 API</p>
          <ol class="space-y-1 list-decimal list-inside text-xs">
            <li>실계좌 개설 완료 후 신청 가능</li>
            <li>KIS Developers에서 실계좌 앱 등록</li>
            <li>승인 후 App Key, App Secret 발급</li>
          </ol>
        </div>
        <a href="https://apiportal.koreainvestment.com" target="_blank" class="flex items-center gap-2 text-indigo-400 hover:text-indigo-300 text-xs">
          <i class="fas fa-external-link-alt"></i> KIS Developers 바로가기
        </a>
      </div>
    </div>
  </div>
</div>

</div><!-- /max-w -->

<!-- 푸터 -->
<footer class="text-center py-6 text-xs text-gray-700 border-t border-gray-900 mt-8">
  <p>📈 StockBot Pro | 한국투자증권 API 연동 자동 트레이딩 | 투자 판단은 본인 책임입니다</p>
</footer>

<!-- ────── 봇 생성/수정 모달 ────── -->
<div id="botModal" class="modal-overlay hidden">
  <div class="modal-box">
    <div class="flex items-center justify-between mb-6">
      <h3 id="modalTitle" class="text-lg font-bold text-white">봇 추가</h3>
      <button onclick="closeBotModal()" class="text-gray-500 hover:text-white text-xl">×</button>
    </div>
    <input type="hidden" id="editBotId"/>
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-400 mb-1 block">봇 이름</label><input id="botName" type="text" placeholder="삼성전자 RSI봇"/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">종목 코드</label><input id="botSymbol" type="text" placeholder="005930.KS"/></div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="text-xs text-gray-400 mb-1 block">계좌 모드</label>
          <select id="botMode">
            <option value="mock">모의계좌</option>
            <option value="real">실계좌 (주의)</option>
          </select>
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">전략</label>
          <select id="botStrategy">
            <option value="combined">복합 전략 (권장)</option>
            <option value="rsi">RSI 전략</option>
            <option value="macd">MACD 전략</option>
            <option value="bb">볼린저 밴드</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-400 mb-1 block">1회 매수 금액 (원)</label><input id="botBuyAmount" type="number" value="500000"/></div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Slack 알림</label>
          <select id="botSlackNotify">
            <option value="1">활성화</option>
            <option value="0">비활성화</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-400 mb-1 block">손절 (%)</label><input id="botStopLoss" type="number" value="5"/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">익절 (%)</label><input id="botTakeProfit" type="number" value="10"/></div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs text-gray-400 mb-1 block">RSI 과매도 기준</label><input id="botRsiOversold" type="number" value="30"/></div>
        <div><label class="text-xs text-gray-400 mb-1 block">RSI 과매수 기준</label><input id="botRsiOverbought" type="number" value="70"/></div>
      </div>
      <div class="flex gap-3 pt-2">
        <button onclick="saveBotConfig()" class="btn-primary flex-1 flex items-center justify-center gap-2">
          <i class="fas fa-save"></i> <span id="modalSaveText">봇 저장</span>
        </button>
        <button onclick="closeBotModal()" class="px-4 py-2 rounded-lg text-gray-400 text-sm" style="background:#1f2937;">취소</button>
      </div>
    </div>
  </div>
</div>

<script>
// ══════════════════════════════════════════════════════
// 전역 상태
// ══════════════════════════════════════════════════════
let currentData = null;
let mainChart = null;
let btChart = null;
let currentTab = 'price';

// ══════════════════════════════════════════════════════
// 네비게이션
// ══════════════════════════════════════════════════════
function switchNav(name) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(t => t.classList.remove('active'));
  document.getElementById('nav-' + name).classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'bot') loadBots();
  if (name === 'trades') loadTrades();
  if (name === 'backtest') loadBtHistory();
  if (name === 'settings') loadSettings();
}

// ══════════════════════════════════════════════════════
// DB 초기화
// ══════════════════════════════════════════════════════
async function initDB() {
  try {
    const r = await fetch('/api/db/init', { method: 'POST' });
    const d = await r.json();
    alert(d.message || d.error);
    loadStats();
  } catch(e) { alert('오류: ' + e.message); }
}

// ══════════════════════════════════════════════════════
// 상단 통계 로드
// ══════════════════════════════════════════════════════
async function loadStats() {
  try {
    const r = await fetch('/api/settings/stats');
    const d = await r.json();
    if (d.total_trades > 0) {
      document.getElementById('statsBar').classList.remove('hidden');
      document.getElementById('hdrTrades').textContent = d.total_trades + '건';
      const pnl = d.total_pnl || 0;
      const pnlEl = document.getElementById('hdrPnl');
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + pnl.toLocaleString('ko-KR') + '원';
      pnlEl.className = 'font-semibold ' + (pnl >= 0 ? 'text-green-400' : 'text-red-400');
      document.getElementById('hdrWinRate').textContent = (d.win_rate || 0) + '%';
    }
  } catch(e) {}
}

// ══════════════════════════════════════════════════════
// 주식 분석 (기존)
// ══════════════════════════════════════════════════════
let searchTimeout;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  if (!q) { document.getElementById('searchDropdown').classList.add('hidden'); return; }
  searchTimeout = setTimeout(() => searchStocks(q), 350);
});
document.getElementById('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { document.getElementById('searchDropdown').classList.add('hidden'); analyzeStock(); }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#searchInput') && !e.target.closest('#searchDropdown'))
    document.getElementById('searchDropdown').classList.add('hidden');
});
async function searchStocks(q) {
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    const dd = document.getElementById('searchDropdown');
    if (!data.quotes || !data.quotes.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = data.quotes.slice(0,6).map(s =>
      '<div class="search-item px-4 py-2.5 cursor-pointer flex items-center justify-between" onclick="selectStock(\\'' + s.symbol + '\\')">' +
        '<div><div class="text-sm text-white font-medium">' + (s.name||s.symbol) + '</div>' +
        '<div class="text-xs text-gray-500">' + s.symbol + ' · ' + (s.exchange||'') + '</div></div>' +
        '<span class="text-xs px-2 py-0.5 rounded" style="background:#1a2030;color:#6366f1;">' + (s.type||'') + '</span>' +
      '</div>'
    ).join('<div class="border-t border-gray-800"></div>');
    dd.classList.remove('hidden');
  } catch(e) {}
}
function selectStock(symbol) {
  document.getElementById('searchInput').value = symbol;
  document.getElementById('searchDropdown').classList.add('hidden');
  analyzeStock();
}
function quickAnalyze(symbol) {
  document.getElementById('searchInput').value = symbol;
  analyzeStock();
}
async function analyzeStock() {
  const symbol = document.getElementById('searchInput').value.trim();
  if (!symbol) return;
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('result').classList.add('hidden');
  document.getElementById('errorMsg').classList.add('hidden');
  try {
    const res = await fetch('/api/analyze/' + encodeURIComponent(symbol));
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    currentData = data;
    renderResult(data);
    document.getElementById('result').classList.remove('hidden');
  } catch(e) {
    document.getElementById('errorText').textContent = '오류: ' + e.message;
    document.getElementById('errorMsg').classList.remove('hidden');
  } finally { document.getElementById('loading').classList.add('hidden'); }
}
function fmt(n, decimals=0) {
  if (n == null || isNaN(n)) return '-';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function renderResult(d) {
  const ind = d.indicators;
  const lastRsi = ind.rsi.filter(v => v != null).pop();
  const lastMacd = ind.macd[ind.macd.length-1]; const lastSig = ind.macdSignal[ind.macdSignal.length-1];
  const lastBbU = ind.bbUpper.filter(v=>v!=null).pop(); const lastBbL = ind.bbLower.filter(v=>v!=null).pop();
  const lastK = ind.stochK.filter(v=>v!=null).pop(); const lastD = ind.stochD.filter(v=>v!=null).pop();
  const lastSma5 = ind.sma5.filter(v=>v!=null).pop(); const lastSma20 = ind.sma20.filter(v=>v!=null).pop();
  const lastSma60 = ind.sma60.filter(v=>v!=null).pop(); const lastSma120 = ind.sma120.filter(v=>v!=null).pop();
  const price = d.currentPrice;
  document.getElementById('stockName').textContent = d.name;
  document.getElementById('stockSymbol').textContent = d.symbol;
  document.getElementById('stockExchange').textContent = d.exchange||'';
  document.getElementById('stockPrice').textContent = fmt(price, price>100?0:2)+' '+(d.currency==='KRW'?'원':d.currency);
  const chgEl = document.getElementById('stockChange');
  chgEl.textContent = (d.change>=0?'+':'')+fmt(d.change,price>100?0:2)+' ('+(d.change>=0?'+':'')+d.changePct.toFixed(2)+'%)';
  chgEl.className = 'text-lg font-semibold '+(d.change>=0?'up':'down');
  document.getElementById('w52High').textContent = fmt(d.week52High)+' ('+d.fromHigh.toFixed(1)+'%)';
  document.getElementById('w52Low').textContent = fmt(d.week52Low)+' (+'+d.fromLow.toFixed(1)+'%)';
  document.getElementById('stockVolume').textContent = fmt(d.volume);
  const s = d.signal; const signalBox = document.getElementById('signalBox');
  signalBox.className = 'p-5 rounded-xl min-w-52 ';
  if (s.signal.includes('강력 매수')) signalBox.classList.add('signal-strong-buy');
  else if (s.signal.includes('매수')) signalBox.classList.add('signal-buy');
  else if (s.signal.includes('강력 매도')) signalBox.classList.add('signal-strong-sell');
  else if (s.signal.includes('매도')) signalBox.classList.add('signal-sell');
  else signalBox.classList.add('signal-neutral');
  document.getElementById('signalText').textContent = s.signal;
  document.getElementById('signalScore').textContent = '점수: '+s.score+'/7';
  document.getElementById('signalReasons').innerHTML = s.reasons.map(r=>'<div class="text-xs text-gray-300 py-0.5">'+r+'</div>').join('');
  document.getElementById('rsiVal').textContent = lastRsi?lastRsi.toFixed(1):'-';
  document.getElementById('rsiVal').className = 'text-2xl font-bold '+(lastRsi<30?'up':lastRsi>70?'down':'text-white');
  document.getElementById('rsiStatus').textContent = lastRsi<30?'🔴 과매도':lastRsi>70?'🔵 과매수':'⚪ 중립';
  document.getElementById('rsiBar').style.width = (lastRsi||50)+'%';
  document.getElementById('macdVal').textContent = lastMacd?lastMacd.toFixed(2):'-';
  document.getElementById('macdVal').className = 'text-2xl font-bold '+(lastMacd>lastSig?'up':'down');
  document.getElementById('macdStatus').textContent = lastMacd>lastSig?'📈 강세':'📉 약세';
  if (lastBbU && lastBbL) {
    const bbPct = ((price-lastBbL)/(lastBbU-lastBbL)*100).toFixed(1);
    document.getElementById('bbVal').textContent = bbPct+'%';
    document.getElementById('bbStatus').textContent = price>lastBbU?'🔴 상단 돌파':price<lastBbL?'🟢 하단 이탈':'밴드 폭: '+(lastBbU-lastBbL).toFixed(0);
  }
  document.getElementById('stochVal').textContent = lastK?lastK.toFixed(1):'-';
  document.getElementById('stochStatus').textContent = 'D: '+(lastD?lastD.toFixed(1):'-')+(lastK>80?' ⚠️ 과매수':lastK<20?' ✅ 과매도':'');
  [['sma5',lastSma5],['sma20',lastSma20],['sma60',lastSma60],['sma120',lastSma120]].forEach(([id,v])=>{
    document.getElementById(id).textContent = fmt(v,price>100?0:2);
    if(v){const diff=((price-v)/v*100).toFixed(2);document.getElementById(id+'diff').textContent=(diff>=0?'▲':'▼')+' '+Math.abs(diff)+'%';document.getElementById(id+'diff').className='text-xs mt-1 '+(diff>=0?'up':'down');}
  });
  const recent = d.dates.slice(-20).map((date,i0)=>{
    const i=d.dates.length-20+i0; const ohlcv=d.ohlcv[i]; const rsiV=ind.rsi[i]; const prev=d.ohlcv[i-1];
    const chg=prev?((ohlcv.close-prev.close)/prev.close*100):0; return {date,...ohlcv,rsi:rsiV,chg};
  }).reverse();
  document.getElementById('priceTable').innerHTML = recent.map(r =>
    '<tr class="border-b border-gray-800 hover:bg-gray-900 transition-colors">'+
    '<td class="py-2 pr-4 text-gray-400 text-xs">'+r.date+'</td>'+
    '<td class="py-2 px-4 text-right text-gray-300">'+fmt(r.open)+'</td>'+
    '<td class="py-2 px-4 text-right up">'+fmt(r.high)+'</td>'+
    '<td class="py-2 px-4 text-right down">'+fmt(r.low)+'</td>'+
    '<td class="py-2 px-4 text-right font-semibold text-white">'+fmt(r.close)+'</td>'+
    '<td class="py-2 px-4 text-right text-gray-400">'+(r.volume?(r.volume/1000).toFixed(0)+'K':'-')+'</td>'+
    '<td class="py-2 px-4 text-right '+(r.chg>=0?'up':'down')+'">'+(r.chg>=0?'+':'')+r.chg.toFixed(2)+'%</td>'+
    '<td class="py-2 pl-4 text-right">'+(r.rsi?'<span class="px-2 py-0.5 rounded text-xs '+(r.rsi<30?'badge-buy':r.rsi>70?'badge-sell':'')+'">'+r.rsi.toFixed(1)+'</span>':'-')+'</td>'+
    '</tr>'
  ).join('');
  switchTab(currentTab, true);
}
function switchTab(tab, force=false) {
  if (tab===currentTab&&!force&&mainChart) return;
  currentTab=tab;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  renderChart(tab);
}
function renderChart(tab) {
  if (!currentData) return;
  if (mainChart) { mainChart.destroy(); mainChart=null; }
  const ctx = document.getElementById('mainChart').getContext('2d');
  const d=currentData; const ind=d.indicators; const N=Math.min(d.dates.length,252);
  const labels=d.dates.slice(-N);
  const gridColor='rgba(255,255,255,0.04)';
  const baseOpts = {
    responsive:true,maintainAspectRatio:false,animation:{duration:200},
    interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{color:'#9ca3af',font:{size:11},boxWidth:20}},tooltip:{backgroundColor:'#1f2937',borderColor:'#374151',borderWidth:1,titleColor:'#e0e0e0',bodyColor:'#9ca3af'}},
    scales:{x:{ticks:{color:'#6b7280',font:{size:10},maxTicksLimit:12},grid:{color:gridColor}},y:{ticks:{color:'#6b7280',font:{size:11}},grid:{color:gridColor}}}
  };
  if (tab==='price') {
    mainChart=new Chart(ctx,{type:'line',data:{labels,datasets:[
      {label:'종가',data:d.ohlcv.slice(-N).map(x=>x.close),borderColor:'#6366f1',borderWidth:2,pointRadius:0,tension:0.1},
      {label:'SMA5',data:ind.sma5.slice(-N),borderColor:'#fbbf24',borderWidth:1,pointRadius:0,tension:0.1},
      {label:'SMA20',data:ind.sma20.slice(-N),borderColor:'#34d399',borderWidth:1,pointRadius:0,tension:0.1},
      {label:'SMA60',data:ind.sma60.slice(-N),borderColor:'#f87171',borderWidth:1,pointRadius:0,tension:0.1},
      {label:'SMA120',data:ind.sma120.slice(-N),borderColor:'#a78bfa',borderWidth:1.5,pointRadius:0,tension:0.1},
    ]},options:{...baseOpts}});
  } else if (tab==='rsi') {
    mainChart=new Chart(ctx,{type:'line',data:{labels,datasets:[{label:'RSI(14)',data:ind.rsi.slice(-N),borderColor:'#6366f1',borderWidth:2,pointRadius:0,tension:0.1}]},options:{...baseOpts,scales:{...baseOpts.scales,y:{...baseOpts.scales.y,min:0,max:100}}}});
  } else if (tab==='macd') {
    mainChart=new Chart(ctx,{type:'bar',data:{labels,datasets:[
      {type:'bar',label:'히스토그램',data:ind.macdHistogram.slice(-N),backgroundColor:ind.macdHistogram.slice(-N).map(v=>v>=0?'rgba(52,211,153,0.5)':'rgba(248,113,113,0.5)'),order:2},
      {type:'line',label:'MACD',data:ind.macd.slice(-N),borderColor:'#6366f1',borderWidth:2,pointRadius:0,order:1},
      {type:'line',label:'Signal',data:ind.macdSignal.slice(-N),borderColor:'#f97316',borderWidth:1.5,pointRadius:0,order:0},
    ]},options:{...baseOpts}});
  } else if (tab==='bb') {
    mainChart=new Chart(ctx,{type:'line',data:{labels,datasets:[
      {label:'상단',data:ind.bbUpper.slice(-N),borderColor:'#f87171',borderWidth:1,pointRadius:0,borderDash:[4,4],fill:false},
      {label:'중간(SMA20)',data:ind.bbMiddle.slice(-N),borderColor:'#a78bfa',borderWidth:1.5,pointRadius:0,fill:false},
      {label:'하단',data:ind.bbLower.slice(-N),borderColor:'#34d399',borderWidth:1,pointRadius:0,borderDash:[4,4],fill:false},
      {label:'종가',data:d.ohlcv.slice(-N).map(x=>x.close),borderColor:'#fbbf24',borderWidth:2,pointRadius:0,fill:false},
    ]},options:{...baseOpts}});
  } else if (tab==='stoch') {
    mainChart=new Chart(ctx,{type:'line',data:{labels,datasets:[
      {label:'K',data:ind.stochK.slice(-N),borderColor:'#6366f1',borderWidth:2,pointRadius:0,tension:0.2},
      {label:'D',data:ind.stochD.slice(-N),borderColor:'#f97316',borderWidth:1.5,pointRadius:0,tension:0.2},
    ]},options:{...baseOpts,scales:{...baseOpts.scales,y:{...baseOpts.scales.y,min:0,max:100}}}});
  } else if (tab==='volume') {
    mainChart=new Chart(ctx,{type:'bar',data:{labels,datasets:[
      {label:'거래량',data:d.ohlcv.slice(-N).map(x=>x.volume),backgroundColor:d.ohlcv.slice(-N).map((x,i,arr)=>i>0&&x.close>=arr[i-1].close?'rgba(239,68,68,0.6)':'rgba(59,130,246,0.6)'),yAxisID:'y'},
      {type:'line',label:'종가',data:d.ohlcv.slice(-N).map(x=>x.close),borderColor:'#fbbf24',borderWidth:1.5,pointRadius:0,yAxisID:'y1'},
    ]},options:{...baseOpts,scales:{...baseOpts.scales,y:{...baseOpts.scales.y,position:'left'},y1:{position:'right',ticks:{color:'#6b7280'},grid:{display:false}}}}});
  }
}

// ══════════════════════════════════════════════════════
// 봇 관리
// ══════════════════════════════════════════════════════
async function loadBots() {
  try {
    const r = await fetch('/api/bots');
    const d = await r.json();
    renderBots(d.bots || []);
  } catch(e) { document.getElementById('botList').innerHTML = '<p class="text-red-400 text-sm col-span-3">DB가 초기화되지 않았습니다. 우측 상단 "DB 초기화" 버튼을 눌러주세요.</p>'; }
}

const strategyLabel = { combined:'복합(RSI+MACD+BB)', rsi:'RSI', macd:'MACD', bb:'볼린저밴드' };

function renderBots(bots) {
  const list = document.getElementById('botList');
  const empty = document.getElementById('botEmpty');
  if (!bots.length) { list.innerHTML=''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = bots.map(b => \`
    <div class="card p-5" id="bot-\${b.id}">
      <div class="flex items-start justify-between mb-3">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="pulse-dot \${b.enabled?'pulse-green':'pulse-gray'}"></span>
            <h4 class="font-semibold text-white">\${b.name}</h4>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-gray-400">\${b.symbol}</span>
            <span class="\${b.mode==='real'?'badge-real':'badge-mock'}">\${b.mode==='real'?'실계좌':'모의계좌'}</span>
            <span class="text-xs px-2 py-0.5 rounded" style="background:#1a2030;color:#6366f1;">\${strategyLabel[b.strategy]||b.strategy}</span>
          </div>
        </div>
        <span class="\${b.enabled?'badge-on':'badge-off'}">\${b.enabled?'실행중':'중지'}</span>
      </div>
      <div class="grid grid-cols-3 gap-2 mb-4 text-xs">
        <div class="card-dark p-2 text-center"><div class="text-gray-500">매수금액</div><div class="text-white font-semibold">\${(b.buy_amount/10000).toFixed(0)}만원</div></div>
        <div class="card-dark p-2 text-center"><div class="text-gray-500">손절/익절</div><div class="text-white font-semibold">\${b.stop_loss_pct}% / \${b.take_profit_pct}%</div></div>
        <div class="card-dark p-2 text-center"><div class="text-gray-500">RSI 기준</div><div class="text-white font-semibold">\${b.rsi_oversold} / \${b.rsi_overbought}</div></div>
      </div>
      <div class="flex gap-2">
        <button onclick="toggleBot(\${b.id})" class="\${b.enabled?'btn-danger':'btn-success'} flex-1 text-xs py-1.5">
          <i class="fas fa-\${b.enabled?'stop':'play'} mr-1"></i>\${b.enabled?'중지':'시작'}
        </button>
        <button onclick="runBot(\${b.id})" class="btn-warn text-xs px-3 py-1.5" title="수동 실행">
          <i class="fas fa-bolt"></i>
        </button>
        <button onclick="editBot(\${JSON.stringify(b).replace(/"/g,'&quot;')})" class="text-xs px-3 py-1.5 rounded-lg text-gray-400" style="background:#1f2937;">
          <i class="fas fa-pen"></i>
        </button>
        <button onclick="deleteBot(\${b.id})" class="text-xs px-3 py-1.5 rounded-lg text-red-400" style="background:#1f2937;">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>
  \`).join('');
}

function openBotModal() {
  document.getElementById('editBotId').value = '';
  document.getElementById('modalTitle').textContent = '봇 추가';
  document.getElementById('modalSaveText').textContent = '봇 저장';
  document.getElementById('botName').value = '';
  document.getElementById('botSymbol').value = '';
  document.getElementById('botMode').value = 'mock';
  document.getElementById('botStrategy').value = 'combined';
  document.getElementById('botBuyAmount').value = '500000';
  document.getElementById('botStopLoss').value = '5';
  document.getElementById('botTakeProfit').value = '10';
  document.getElementById('botRsiOversold').value = '30';
  document.getElementById('botRsiOverbought').value = '70';
  document.getElementById('botSlackNotify').value = '1';
  document.getElementById('botModal').classList.remove('hidden');
}

function editBot(b) {
  document.getElementById('editBotId').value = b.id;
  document.getElementById('modalTitle').textContent = '봇 수정';
  document.getElementById('modalSaveText').textContent = '수정 저장';
  document.getElementById('botName').value = b.name;
  document.getElementById('botSymbol').value = b.symbol;
  document.getElementById('botMode').value = b.mode;
  document.getElementById('botStrategy').value = b.strategy;
  document.getElementById('botBuyAmount').value = b.buy_amount;
  document.getElementById('botStopLoss').value = b.stop_loss_pct;
  document.getElementById('botTakeProfit').value = b.take_profit_pct;
  document.getElementById('botRsiOversold').value = b.rsi_oversold;
  document.getElementById('botRsiOverbought').value = b.rsi_overbought;
  document.getElementById('botSlackNotify').value = b.slack_notify;
  document.getElementById('botModal').classList.remove('hidden');
}

function closeBotModal() { document.getElementById('botModal').classList.add('hidden'); }

async function saveBotConfig() {
  const id = document.getElementById('editBotId').value;
  const body = {
    name: document.getElementById('botName').value,
    symbol: document.getElementById('botSymbol').value,
    mode: document.getElementById('botMode').value,
    strategy: document.getElementById('botStrategy').value,
    buyAmount: parseInt(document.getElementById('botBuyAmount').value),
    stopLossPct: parseFloat(document.getElementById('botStopLoss').value),
    takeProfitPct: parseFloat(document.getElementById('botTakeProfit').value),
    rsiOversold: parseFloat(document.getElementById('botRsiOversold').value),
    rsiOverbought: parseFloat(document.getElementById('botRsiOverbought').value),
    slackNotify: document.getElementById('botSlackNotify').value === '1',
  };
  if (!body.name || !body.symbol) { alert('봇 이름과 종목 코드를 입력하세요'); return; }
  try {
    const url = id ? '/api/bots/' + id : '/api/bots';
    const method = id ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    closeBotModal();
    loadBots();
  } catch(e) { alert('오류: ' + e.message); }
}

async function toggleBot(id) {
  try {
    const r = await fetch('/api/bots/' + id + '/toggle', { method: 'POST' });
    const d = await r.json();
    if (d.error) { alert('오류: ' + d.error); return; }
    loadBots();
  } catch(e) { alert('오류: ' + e.message); }
}

async function runBot(id) {
  try {
    const r = await fetch('/api/bots/' + id + '/run', { method: 'POST' });
    const d = await r.json();
    if (d.error) { alert('❌ 오류: ' + d.error); return; }
    const actionLabel = { buy: '✅ 매수 실행', sell: '✅ 매도 실행', hold: '⏸ 홀드 (신호 없음)' };
    alert(
      (actionLabel[d.action] || d.action) + '\\n' +
      '신호: ' + d.signal + ' (점수: ' + d.score + ')\\n' +
      '현재가: ' + (d.price||0).toLocaleString() + '원\\n' +
      '근거: ' + (d.reasons||[]).join(', ')
    );
    loadBots();
  } catch(e) { alert('오류: ' + e.message); }
}

async function deleteBot(id) {
  if (!confirm('봇을 삭제하시겠습니까?')) return;
  try {
    await fetch('/api/bots/' + id, { method: 'DELETE' });
    loadBots();
  } catch(e) { alert('오류: ' + e.message); }
}

// ══════════════════════════════════════════════════════
// 백테스팅
// ══════════════════════════════════════════════════════
async function runBacktest() {
  const symbol = document.getElementById('btSymbol').value.trim();
  const strategy = document.getElementById('btStrategy').value;
  if (!symbol) { alert('종목 코드를 입력하세요'); return; }

  document.getElementById('btRunBtn').disabled = true;
  document.getElementById('btLoading').classList.remove('hidden');
  document.getElementById('btResult').classList.add('hidden');
  document.getElementById('btEmpty').classList.add('hidden');

  try {
    const r = await fetch('/api/backtest/run', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        symbol,
        strategy,
        params: {
          range: document.getElementById('btRange').value,
          initialCapital: parseInt(document.getElementById('btCapital').value),
          feeRate: parseFloat(document.getElementById('btFee').value) / 100,
          stopLossPct: parseFloat(document.getElementById('btStopLoss').value),
          takeProfitPct: parseFloat(document.getElementById('btTakeProfit').value),
          rsiOversold: parseFloat(document.getElementById('btRsiOversold').value),
          rsiOverbought: parseFloat(document.getElementById('btRsiOverbought').value),
        }
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    renderBacktestResult(d);
    document.getElementById('btResult').classList.remove('hidden');
    loadBtHistory();
  } catch(e) {
    alert('백테스팅 오류: ' + e.message);
    document.getElementById('btEmpty').classList.remove('hidden');
  } finally {
    document.getElementById('btLoading').classList.add('hidden');
    document.getElementById('btRunBtn').disabled = false;
  }
}

function renderBacktestResult(d) {
  const isPos = v => v >= 0;
  const fmtPct = v => (isPos(v)?'+':'') + v.toFixed(2) + '%';
  const fmtNum = v => v.toLocaleString('ko-KR') + '원';

  document.getElementById('btReturnPct').textContent = fmtPct(d.totalReturnPct);
  document.getElementById('btReturnPct').className = 'text-2xl font-bold ' + (isPos(d.totalReturnPct)?'result-positive':'result-negative');
  document.getElementById('btBnhReturn').textContent = fmtPct(d.buyAndHoldReturn);
  document.getElementById('btBnhReturn').className = 'text-2xl font-bold ' + (isPos(d.buyAndHoldReturn)?'result-positive':'result-negative');
  document.getElementById('btDrawdown').textContent = '-' + d.maxDrawdownPct.toFixed(2) + '%';
  document.getElementById('btWinRate').textContent = d.winRate.toFixed(1) + '%';
  document.getElementById('btFinalCapital').textContent = fmtNum(d.finalCapital);
  document.getElementById('btTotalTrades').textContent = d.totalTrades + '건';
  document.getElementById('btSharpe').textContent = d.sharpeRatio.toFixed(3);
  document.getElementById('btProfitFactor').textContent = d.profitFactor.toFixed(3);

  // 자산 곡선 차트
  if (btChart) { btChart.destroy(); btChart = null; }
  const ctx = document.getElementById('btChart').getContext('2d');
  const eq = d.equityCurve;
  btChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: eq.map(e=>e.date),
      datasets: [
        {label:'자산가치',data:eq.map(e=>e.value),borderColor:'#6366f1',borderWidth:2,pointRadius:0,tension:0.1,fill:true,backgroundColor:'rgba(99,102,241,0.1)'},
        {label:'초기자본',data:eq.map(()=>d.initialCapital),borderColor:'#6b7280',borderWidth:1,borderDash:[4,4],pointRadius:0},
      ]
    },
    options: {
      responsive:true,maintainAspectRatio:false,animation:{duration:200},
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{labels:{color:'#9ca3af',font:{size:11}}},tooltip:{backgroundColor:'#1f2937',borderColor:'#374151',borderWidth:1,titleColor:'#e0e0e0',bodyColor:'#9ca3af',callbacks:{label:(c)=>c.dataset.label+': '+c.parsed.y.toLocaleString('ko-KR')+'원'}}},
      scales:{x:{ticks:{color:'#6b7280',font:{size:10},maxTicksLimit:12},grid:{color:'rgba(255,255,255,0.04)'}},y:{ticks:{color:'#6b7280',font:{size:11},callback:(v)=>(v/10000).toFixed(0)+'만'},grid:{color:'rgba(255,255,255,0.04)'}}}
    }
  });

  // 거래 내역
  const recent = (d.trades||[]).slice(-30).reverse();
  document.getElementById('btTradeTable').innerHTML = recent.map(t => {
    const pnl = t.pnl != null ? ((t.pnl>=0?'+':'')+t.pnl.toLocaleString('ko-KR')+'원') : '-';
    const pnlClass = t.pnl != null ? (t.pnl>=0?'result-positive':'result-negative') : '';
    return '<tr class="border-b border-gray-800 hover:bg-gray-900">'+
      '<td class="py-1.5 pr-3 text-gray-400">'+t.date+'</td>'+
      '<td class="py-1.5 px-3 text-center"><span class="'+(t.side==='buy'?'badge-buy':'badge-sell')+'">+'+(t.side==='buy'?'매수':'매도')+'</span></td>'+
      '<td class="py-1.5 px-3 text-right text-white">'+t.price.toLocaleString('ko-KR')+'</td>'+
      '<td class="py-1.5 px-3 text-right text-gray-300">'+t.quantity+'주</td>'+
      '<td class="py-1.5 px-3 text-right '+pnlClass+'">'+pnl+'</td>'+
      '<td class="py-1.5 pl-3 text-gray-400">'+t.reason+'</td>'+
    '</tr>';
  }).join('');
}

async function loadBtHistory() {
  try {
    const r = await fetch('/api/backtest/history');
    const d = await r.json();
    const h = document.getElementById('btHistory');
    if (!d.results || !d.results.length) { h.innerHTML = '<p class="text-center py-4">백테스팅 기록 없음</p>'; return; }
    h.innerHTML = d.results.slice(0,10).map(r =>
      '<div class="p-2 rounded-lg cursor-pointer hover:bg-gray-800 flex items-center justify-between" style="background:#0d111e;border:1px solid #1a2030;">'+
      '<div><div class="text-gray-200 font-medium">'+r.symbol+' · '+r.strategy+'</div>'+
      '<div class="text-gray-500 mt-0.5">'+r.start_date+' ~ '+r.end_date+'</div></div>'+
      '<div class="text-right"><div class="'+(r.total_return_pct>=0?'result-positive':'result-negative')+' font-semibold">'+
      (r.total_return_pct>=0?'+':'')+r.total_return_pct+'%</div>'+
      '<div class="text-gray-500">승률 '+r.win_rate+'%</div></div>'+
      '</div>'
    ).join('');
  } catch(e) {}
}

// ══════════════════════════════════════════════════════
// 거래 내역
// ══════════════════════════════════════════════════════
async function loadTrades() {
  loadStats();
  try {
    // 통계
    const sr = await fetch('/api/settings/stats');
    const stats = await sr.json();
    document.getElementById('tradeStats').innerHTML = [
      ['총 거래', stats.total_trades+'건', 'text-white'],
      ['매수', stats.buy_count+'건', 'text-green-400'],
      ['매도', stats.sell_count+'건', 'text-red-400'],
      ['총 손익', (stats.total_pnl>=0?'+':'')+Math.round(stats.total_pnl||0).toLocaleString('ko-KR')+'원', stats.total_pnl>=0?'text-green-400':'text-red-400'],
      ['승률', (stats.win_rate||0)+'%', 'text-yellow-400'],
    ].map(([label,val,cls])=>
      '<div class="card p-4 text-center"><div class="text-xs text-gray-500 mb-1">'+label+'</div><div class="text-xl font-bold '+cls+'">'+val+'</div></div>'
    ).join('');

    const r = await fetch('/api/settings/trades?limit=100');
    const d = await r.json();
    const tbody = document.getElementById('tradeTable');
    if (!d.trades || !d.trades.length) { tbody.innerHTML = '<tr><td colspan="9" class="text-center py-8 text-gray-500">거래 내역이 없습니다</td></tr>'; return; }
    tbody.innerHTML = d.trades.map(t => {
      const pnl = t.pnl != null ? (t.pnl>=0?'+':'')+Math.round(t.pnl).toLocaleString('ko-KR')+'원' : '-';
      const pnlClass = t.pnl != null ? (t.pnl>=0?'text-green-400':'text-red-400') : '';
      return '<tr class="border-b border-gray-800 hover:bg-gray-900">'+
        '<td class="py-2 pr-4 text-xs text-gray-400">'+t.created_at.slice(0,16)+'</td>'+
        '<td class="py-2 px-4 text-white font-medium">'+t.symbol+'</td>'+
        '<td class="py-2 px-4 text-center"><span class="'+(t.side==='buy'?'badge-buy':'badge-sell')+'">+'+(t.side==='buy'?'매수':'매도')+'</span></td>'+
        '<td class="py-2 px-4 text-right text-gray-300">'+Math.round(t.price).toLocaleString('ko-KR')+'</td>'+
        '<td class="py-2 px-4 text-right text-gray-300">'+t.quantity+'주</td>'+
        '<td class="py-2 px-4 text-right text-gray-300">'+Math.round(t.amount).toLocaleString('ko-KR')+'</td>'+
        '<td class="py-2 px-4 text-right '+pnlClass+'">'+pnl+'</td>'+
        '<td class="py-2 px-4 text-center"><span class="'+(t.mode==='real'?'badge-real':'badge-mock')+'">+'+(t.mode==='real'?'실계좌':'모의')+'</span></td>'+
        '<td class="py-2 pl-4 text-xs text-gray-400">+'+(t.note||t.strategy||'-')+'</td>'+
        '</tr>';
    }).join('');
  } catch(e) { document.getElementById('tradeTable').innerHTML = '<tr><td colspan="9" class="text-center py-8 text-red-400">DB를 초기화하세요</td></tr>'; }
}

// ══════════════════════════════════════════════════════
// 설정 저장/로드
// ══════════════════════════════════════════════════════
async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    const d = await r.json();
    (d.settings || []).forEach(s => {
      if (s.provider === 'kis_mock' && s.account_no) document.getElementById('mockAccountNo').value = s.account_no;
      if (s.provider === 'kis_real' && s.account_no) document.getElementById('realAccountNo').value = s.account_no;
    });
  } catch(e) {}
}

async function saveApiSettings(provider) {
  let body = {};
  if (provider === 'kis_mock') {
    body = { provider, appKey: document.getElementById('mockAppKey').value, appSecret: document.getElementById('mockAppSecret').value, accountNo: document.getElementById('mockAccountNo').value, enabled: true };
  } else if (provider === 'kis_real') {
    body = { provider, appKey: document.getElementById('realAppKey').value, appSecret: document.getElementById('realAppSecret').value, accountNo: document.getElementById('realAccountNo').value, enabled: true };
  } else if (provider === 'slack') {
    body = { provider, webhookUrl: document.getElementById('slackWebhook').value, enabled: true };
  }
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    alert(d.message || d.error);
  } catch(e) { alert('오류: ' + e.message); }
}

async function testKisApi(mode) {
  const elKey = mode === 'mock' ? 'mockAppKey' : 'realAppKey';
  const elSec = mode === 'mock' ? 'mockAppSecret' : 'realAppSecret';
  const elAcct = mode === 'mock' ? 'mockAccountNo' : 'realAccountNo';
  const elResult = mode === 'mock' ? 'mockTestResult' : 'realTestResult';
  const el = document.getElementById(elResult);
  el.textContent = '연결 테스트 중...'; el.classList.remove('hidden'); el.style.background='#1f2937'; el.style.color='#9ca3af';
  try {
    const r = await fetch('/api/settings/test-kis', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ appKey: document.getElementById(elKey).value, appSecret: document.getElementById(elSec).value, accountNo: document.getElementById(elAcct).value, mode })
    });
    const d = await r.json();
    el.textContent = d.message;
    el.style.background = d.success ? '#065f46' : '#7f1d1d';
    el.style.color = d.success ? '#34d399' : '#f87171';
  } catch(e) { el.textContent = '오류: '+e.message; el.style.background='#7f1d1d'; el.style.color='#f87171'; }
}

async function testSlack() {
  const el = document.getElementById('slackTestResult');
  el.textContent = '전송 중...'; el.classList.remove('hidden'); el.style.background='#1f2937'; el.style.color='#9ca3af';
  try {
    const r = await fetch('/api/settings/test-slack', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ webhookUrl: document.getElementById('slackWebhook').value })
    });
    const d = await r.json();
    el.textContent = d.message;
    el.style.background = d.success ? '#065f46' : '#7f1d1d';
    el.style.color = d.success ? '#34d399' : '#f87171';
  } catch(e) { el.textContent = '오류: '+e.message; el.style.background='#7f1d1d'; el.style.color='#f87171'; }
}

// 초기 로드
loadStats();
</script>
</body>
</html>`;
}

export default app
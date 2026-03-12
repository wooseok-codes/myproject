import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

app.use('/api/*', cors())

// ─── Yahoo Finance API Helper ────────────────────────────────────────────────

async function fetchYahooQuote(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
    }
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
    const slice = data.slice(i - period + 1, i + 1)
    return slice.reduce((a, b) => a + b, 0) / period
  })
}

function calcEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const ema: number[] = []
  data.forEach((v, i) => {
    if (i === 0) { ema.push(v); return }
    ema.push(v * k + ema[i - 1] * (1 - k))
  })
  return ema
}

function calcRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(period).fill(null)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d)
  }
  avgGain /= period; avgLoss /= period
  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    const gain = d > 0 ? d : 0
    const loss = d < 0 ? Math.abs(d) : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }
  return result
}

function calcMACD(closes: number[]) {
  const ema12 = calcEMA(closes, 12)
  const ema26 = calcEMA(closes, 26)
  const macdLine = ema12.map((v, i) => v - ema26[i])
  const signalLine = calcEMA(macdLine, 9)
  const histogram = macdLine.map((v, i) => v - signalLine[i])
  return { macdLine, signalLine, histogram }
}

function calcBollingerBands(closes: number[], period = 20, stdDev = 2) {
  const sma = calcSMA(closes, period)
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, middle: null, lower: null }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = sma[i]!
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period
    const sd = Math.sqrt(variance)
    return { upper: mean + stdDev * sd, middle: mean, lower: mean - stdDev * sd }
  })
}

function calcStochastic(highs: number[], lows: number[], closes: number[], k = 14, d = 3) {
  const kLine: (number | null)[] = []
  for (let i = 0; i < closes.length; i++) {
    if (i < k - 1) { kLine.push(null); continue }
    const hSlice = highs.slice(i - k + 1, i + 1)
    const lSlice = lows.slice(i - k + 1, i + 1)
    const highest = Math.max(...hSlice)
    const lowest = Math.min(...lSlice)
    kLine.push(highest === lowest ? 50 : ((closes[i] - lowest) / (highest - lowest)) * 100)
  }
  const dLine: (number | null)[] = kLine.map((_, i) => {
    const validK = kLine.slice(Math.max(0, i - d + 1), i + 1).filter(v => v !== null) as number[]
    if (validK.length < d) return null
    return validK.reduce((a, b) => a + b, 0) / d
  })
  return { kLine, dLine }
}

function generateSignal(rsi: (number | null)[], macd: any, close: number[], sma20: (number | null)[], bb: any[]) {
  const lastRsi = rsi[rsi.length - 1] ?? 50
  const lastMacd = macd.macdLine[macd.macdLine.length - 1]
  const prevMacd = macd.macdLine[macd.macdLine.length - 2]
  const lastSignal = macd.signalLine[macd.signalLine.length - 1]
  const prevSignal = macd.signalLine[macd.signalLine.length - 2]
  const lastClose = close[close.length - 1]
  const lastSma20 = sma20[sma20.length - 1]
  const lastBb = bb[bb.length - 1]

  let score = 0
  const reasons: string[] = []

  // RSI
  if (lastRsi < 30) { score += 2; reasons.push('🔴 RSI 과매도 구간 (매수 신호)') }
  else if (lastRsi > 70) { score -= 2; reasons.push('🔵 RSI 과매수 구간 (매도 신호)') }
  else if (lastRsi < 50) { score += 1; reasons.push('⬇️ RSI 중립 이하') }
  else { score -= 1; reasons.push('⬆️ RSI 중립 이상') }

  // MACD 골든/데드 크로스
  if (prevMacd < prevSignal && lastMacd > lastSignal) { score += 3; reasons.push('🟢 MACD 골든 크로스 (강한 매수)') }
  else if (prevMacd > prevSignal && lastMacd < lastSignal) { score -= 3; reasons.push('🔴 MACD 데드 크로스 (강한 매도)') }
  else if (lastMacd > lastSignal) { score += 1; reasons.push('📈 MACD 시그널선 위') }
  else { score -= 1; reasons.push('📉 MACD 시그널선 아래') }

  // 볼린저 밴드
  if (lastBb.lower && lastClose < lastBb.lower) { score += 2; reasons.push('📊 볼린저 밴드 하단 이탈 (반등 가능)') }
  else if (lastBb.upper && lastClose > lastBb.upper) { score -= 2; reasons.push('📊 볼린저 밴드 상단 돌파 (과열)') }

  // 20일 이동평균
  if (lastSma20 && lastClose > lastSma20) { score += 1; reasons.push('📈 20일 이동평균선 위 (상승 추세)') }
  else if (lastSma20) { score -= 1; reasons.push('📉 20일 이동평균선 아래 (하락 추세)') }

  let signal = '중립'
  let color = 'yellow'
  if (score >= 4) { signal = '강력 매수'; color = 'green' }
  else if (score >= 2) { signal = '매수'; color = 'lightgreen' }
  else if (score <= -4) { signal = '강력 매도'; color = 'red' }
  else if (score <= -2) { signal = '매도'; color = 'orange' }

  return { signal, color, score, reasons }
}

// ─── API 라우트 ───────────────────────────────────────────────────────────────

// 종목 검색
app.get('/api/search', async (c) => {
  const query = c.req.query('q') || ''
  if (!query) return c.json({ error: '검색어를 입력하세요' }, 400)
  try {
    const data = await fetchYahooSearch(query)
    const quotes = (data.quotes || []).map((q: any) => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      exchange: q.exchange,
      type: q.quoteType,
    }))
    return c.json({ quotes })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// 종목 분석 (핵심 API)
app.get('/api/analyze/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  try {
    const raw = await fetchYahooQuote(symbol)
    const chart = raw?.chart?.result?.[0]
    if (!chart) return c.json({ error: '종목 데이터를 찾을 수 없습니다' }, 404)

    const meta = chart.meta
    const timestamps: number[] = chart.timestamp || []
    const ohlcv = chart.indicators?.quote?.[0] || {}
    const closes: number[] = ohlcv.close || []
    const opens: number[] = ohlcv.open || []
    const highs: number[] = ohlcv.high || []
    const lows: number[] = ohlcv.low || []
    const volumes: number[] = ohlcv.volume || []

    // null 제거된 유효 데이터
    const valid = closes.map((c, i) => ({ c, o: opens[i], h: highs[i], l: lows[i], v: volumes[i], t: timestamps[i] })).filter(x => x.c != null)
    const vCloses = valid.map(x => x.c)
    const vHighs = valid.map(x => x.h)
    const vLows = valid.map(x => x.l)
    const vDates = valid.map(x => new Date(x.t * 1000).toISOString().slice(0, 10))

    // 지표 계산
    const sma5 = calcSMA(vCloses, 5)
    const sma20 = calcSMA(vCloses, 20)
    const sma60 = calcSMA(vCloses, 60)
    const sma120 = calcSMA(vCloses, 120)
    const rsi = calcRSI(vCloses)
    const macd = calcMACD(vCloses)
    const bb = calcBollingerBands(vCloses)
    const stoch = calcStochastic(vHighs, vLows, vCloses)
    const signal = generateSignal(rsi, macd, vCloses, sma20, bb)

    // 변동률
    const lastClose = vCloses[vCloses.length - 1]
    const prevClose = vCloses[vCloses.length - 2]
    const change = lastClose - prevClose
    const changePct = (change / prevClose) * 100

    // 52주 고가/저가
    const yearSlice = vCloses.slice(-252)
    const week52High = Math.max(...yearSlice)
    const week52Low = Math.min(...yearSlice)
    const fromHigh = ((lastClose - week52High) / week52High) * 100
    const fromLow = ((lastClose - week52Low) / week52Low) * 100

    return c.json({
      symbol,
      name: meta.shortName || meta.longName || symbol,
      currency: meta.currency || 'KRW',
      exchange: meta.exchangeName,
      currentPrice: lastClose,
      change,
      changePct,
      week52High,
      week52Low,
      fromHigh,
      fromLow,
      volume: valid[valid.length - 1].v,
      marketCap: meta.marketCap,
      dates: vDates,
      ohlcv: valid.map(x => ({ open: x.o, high: x.h, low: x.l, close: x.c, volume: x.v })),
      indicators: {
        sma5, sma20, sma60, sma120,
        rsi,
        macd: macd.macdLine,
        macdSignal: macd.signalLine,
        macdHistogram: macd.histogram,
        bbUpper: bb.map(b => b.upper),
        bbMiddle: bb.map(b => b.middle),
        bbLower: bb.map(b => b.lower),
        stochK: stoch.kLine,
        stochD: stoch.dLine,
      },
      signal,
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── 정적 파일 & 메인 페이지 ─────────────────────────────────────────────────

// app.use('/static/*', serveStatic({ root: './' }))

app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>📈 주식 분석 대시보드</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-chart-financial@0.1.1/dist/chartjs-chart-financial.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css"/>
  <style>
    body { background: #0f1117; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; }
    .card { background: #1a1d2e; border: 1px solid #2a2d3e; border-radius: 12px; }
    .card-dark { background: #141622; border: 1px solid #252838; border-radius: 10px; }
    .badge-buy { background: #0d4f3c; color: #00d084; border: 1px solid #00d084; }
    .badge-sell { background: #4f1a1a; color: #ff4757; border: 1px solid #ff4757; }
    .badge-neutral { background: #3d3a1a; color: #ffa502; border: 1px solid #ffa502; }
    .up { color: #ff4757; }
    .down { color: #1e90ff; }
    .signal-strong-buy { background: linear-gradient(135deg, #0d4f3c, #0a3d2e); border: 1px solid #00d084; }
    .signal-buy { background: linear-gradient(135deg, #1a3d2a, #122d20); border: 1px solid #52c41a; }
    .signal-sell { background: linear-gradient(135deg, #4f1a1a, #3d1313); border: 1px solid #ff4757; }
    .signal-strong-sell { background: linear-gradient(135deg, #5c1010, #440c0c); border: 1px solid #ff0000; }
    .signal-neutral { background: linear-gradient(135deg, #3d3a1a, #2d2b14); border: 1px solid #ffa502; }
    .chart-container { position: relative; }
    input[type="text"] { background: #1a1d2e; border: 1px solid #3a3d4e; color: #e0e0e0; }
    input[type="text"]:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.2); }
    .skeleton { background: linear-gradient(90deg, #1a1d2e 25%, #252838 50%, #1a1d2e 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    ::-webkit-scrollbar { width: 6px; } ::-webkit-scrollbar-track { background: #1a1d2e; } ::-webkit-scrollbar-thumb { background: #3a3d4e; border-radius: 3px; }
    .tab-btn { transition: all 0.2s; }
    .tab-btn.active { background: #6366f1; color: white; }
    .search-item:hover { background: #252838; }
    .tooltip-custom { position: absolute; background: #252838; border: 1px solid #3a3d4e; border-radius: 8px; padding: 8px 12px; font-size: 12px; pointer-events: none; z-index: 100; }
  </style>
</head>
<body class="min-h-screen">

<!-- 헤더 -->
<header class="border-b border-gray-800 px-6 py-4 flex items-center justify-between sticky top-0 z-50" style="background:#0f1117;">
  <div class="flex items-center gap-3">
    <div class="w-9 h-9 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#6366f1,#8b5cf6)">
      <i class="fas fa-chart-line text-white text-sm"></i>
    </div>
    <div>
      <h1 class="font-bold text-lg text-white">StockAnalyzer Pro</h1>
      <p class="text-xs text-gray-500">실시간 주식 기술적 분석 대시보드</p>
    </div>
  </div>
  <div class="flex items-center gap-2 text-xs text-gray-500">
    <i class="fas fa-circle text-green-500 text-xs animate-pulse"></i>
    <span>Yahoo Finance 연동</span>
  </div>
</header>

<!-- 메인 컨텐츠 -->
<div class="max-w-screen-2xl mx-auto px-4 py-6">

  <!-- 검색 섹션 -->
  <div class="card p-6 mb-6">
    <div class="flex flex-col md:flex-row gap-4 items-start md:items-center">
      <div class="flex-1 relative">
        <i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm"></i>
        <input id="searchInput" type="text" placeholder="종목명 또는 티커 입력 (예: 삼성전자, AAPL, 005930.KS)"
          class="w-full pl-10 pr-4 py-3 rounded-xl text-sm"
          style="background:#0f1117; border:1px solid #3a3d4e; color:#e0e0e0;"/>
        <div id="searchDropdown" class="absolute top-full left-0 right-0 mt-1 card z-50 hidden overflow-hidden"></div>
      </div>
      <button onclick="analyzeStock()" class="px-6 py-3 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90 flex items-center gap-2"
        style="background:linear-gradient(135deg,#6366f1,#8b5cf6); white-space:nowrap;">
        <i class="fas fa-magnifying-glass-chart"></i> 분석 시작
      </button>
    </div>
    <!-- 빠른 접근 종목 -->
    <div class="mt-4 flex flex-wrap gap-2">
      <span class="text-xs text-gray-500 mr-1 self-center">인기 종목:</span>
      <button onclick="quickAnalyze('005930.KS')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">삼성전자</button>
      <button onclick="quickAnalyze('000660.KS')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">SK하이닉스</button>
      <button onclick="quickAnalyze('035720.KS')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">카카오</button>
      <button onclick="quickAnalyze('035420.KS')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">NAVER</button>
      <button onclick="quickAnalyze('AAPL')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">Apple</button>
      <button onclick="quickAnalyze('TSLA')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">Tesla</button>
      <button onclick="quickAnalyze('NVDA')" class="quick-btn px-3 py-1.5 rounded-lg text-xs font-medium" style="background:#1e2235; border:1px solid #2a2d3e; color:#a0a3b1;">NVIDIA</button>
    </div>
  </div>

  <!-- 로딩 / 에러 -->
  <div id="loading" class="hidden text-center py-20">
    <div class="inline-block w-16 h-16 rounded-full border-4 border-indigo-500 border-t-transparent animate-spin mb-4"></div>
    <p class="text-gray-400">데이터를 불러오는 중...</p>
  </div>
  <div id="errorMsg" class="hidden card p-6 text-center">
    <i class="fas fa-triangle-exclamation text-3xl text-yellow-500 mb-3"></i>
    <p id="errorText" class="text-gray-400"></p>
  </div>

  <!-- 분석 결과 -->
  <div id="result" class="hidden space-y-6">

    <!-- 종목 헤더 -->
    <div class="card p-6">
      <div class="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3 mb-1">
            <h2 id="stockName" class="text-2xl font-bold text-white"></h2>
            <span id="stockSymbol" class="text-sm px-2 py-0.5 rounded" style="background:#252838; color:#8b8fa8;"></span>
            <span id="stockExchange" class="text-xs px-2 py-0.5 rounded" style="background:#1e2235; color:#6366f1;"></span>
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
        <!-- 매매 신호 -->
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

    <!-- 지표 카드 4개 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="card p-4">
        <div class="text-xs text-gray-500 mb-1">RSI (14)</div>
        <div id="rsiVal" class="text-2xl font-bold"></div>
        <div id="rsiStatus" class="text-xs mt-1"></div>
        <div class="mt-2 h-2 rounded-full" style="background:#252838;">
          <div id="rsiBar" class="h-2 rounded-full transition-all" style="background:linear-gradient(90deg,#6366f1,#8b5cf6);"></div>
        </div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-gray-500 mb-1">MACD</div>
        <div id="macdVal" class="text-2xl font-bold"></div>
        <div id="macdStatus" class="text-xs mt-1 text-gray-400"></div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-gray-500 mb-1">볼린저 밴드 위치</div>
        <div id="bbVal" class="text-2xl font-bold"></div>
        <div id="bbStatus" class="text-xs mt-1 text-gray-400"></div>
      </div>
      <div class="card p-4">
        <div class="text-xs text-gray-500 mb-1">스토캐스틱 K/D</div>
        <div id="stochVal" class="text-2xl font-bold"></div>
        <div id="stochStatus" class="text-xs mt-1 text-gray-400"></div>
      </div>
    </div>

    <!-- 차트 탭 -->
    <div class="card p-6">
      <div class="flex items-center justify-between mb-4">
        <h3 class="font-semibold text-white">📊 차트 분석</h3>
        <div class="flex gap-1 p-1 rounded-lg" style="background:#0f1117;">
          <button onclick="switchTab('price')" id="tab-price" class="tab-btn active px-4 py-1.5 rounded-md text-xs font-medium text-gray-400">가격 + MA</button>
          <button onclick="switchTab('rsi')" id="tab-rsi" class="tab-btn px-4 py-1.5 rounded-md text-xs font-medium text-gray-400">RSI</button>
          <button onclick="switchTab('macd')" id="tab-macd" class="tab-btn px-4 py-1.5 rounded-md text-xs font-medium text-gray-400">MACD</button>
          <button onclick="switchTab('bb')" id="tab-bb" class="tab-btn px-4 py-1.5 rounded-md text-xs font-medium text-gray-400">볼린저밴드</button>
          <button onclick="switchTab('stoch')" id="tab-stoch" class="tab-btn px-4 py-1.5 rounded-md text-xs font-medium text-gray-400">스토캐스틱</button>
          <button onclick="switchTab('volume')" id="tab-volume" class="tab-btn px-4 py-1.5 rounded-md text-xs font-medium text-gray-400">거래량</button>
        </div>
      </div>
      <div class="chart-container" style="height:420px;">
        <canvas id="mainChart"></canvas>
      </div>
    </div>

    <!-- 이동평균선 분석 -->
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-4">📐 이동평균선 분석</h3>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="card-dark p-4">
          <div class="text-xs text-gray-500 mb-1">SMA 5일</div>
          <div id="sma5" class="text-lg font-bold text-white"></div>
          <div id="sma5diff" class="text-xs mt-1"></div>
        </div>
        <div class="card-dark p-4">
          <div class="text-xs text-gray-500 mb-1">SMA 20일</div>
          <div id="sma20" class="text-lg font-bold text-white"></div>
          <div id="sma20diff" class="text-xs mt-1"></div>
        </div>
        <div class="card-dark p-4">
          <div class="text-xs text-gray-500 mb-1">SMA 60일</div>
          <div id="sma60" class="text-lg font-bold text-white"></div>
          <div id="sma60diff" class="text-xs mt-1"></div>
        </div>
        <div class="card-dark p-4">
          <div class="text-xs text-gray-500 mb-1">SMA 120일</div>
          <div id="sma120" class="text-lg font-bold text-white"></div>
          <div id="sma120diff" class="text-xs mt-1"></div>
        </div>
      </div>
    </div>

    <!-- 가격 이력 테이블 -->
    <div class="card p-6">
      <h3 class="font-semibold text-white mb-4">📋 최근 20일 가격 데이터</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-gray-500 border-b border-gray-800">
              <th class="text-left py-2 pr-4">날짜</th>
              <th class="text-right py-2 px-4">시가</th>
              <th class="text-right py-2 px-4">고가</th>
              <th class="text-right py-2 px-4">저가</th>
              <th class="text-right py-2 px-4">종가</th>
              <th class="text-right py-2 px-4">거래량</th>
              <th class="text-right py-2 px-4">등락</th>
              <th class="text-right py-2 pl-4">RSI</th>
            </tr>
          </thead>
          <tbody id="priceTable"></tbody>
        </table>
      </div>
    </div>

  </div>
</div>

<!-- 푸터 -->
<footer class="text-center py-6 text-xs text-gray-600 border-t border-gray-800 mt-8">
  <p>📊 StockAnalyzer Pro | 데이터 제공: Yahoo Finance | 투자 판단은 본인 책임입니다</p>
</footer>

<script>
let currentData = null;
let mainChart = null;
let currentTab = 'price';

// 검색 자동완성
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
  if (!e.target.closest('#searchInput') && !e.target.closest('#searchDropdown')) {
    document.getElementById('searchDropdown').classList.add('hidden');
  }
});

async function searchStocks(q) {
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    const dd = document.getElementById('searchDropdown');
    if (!data.quotes || !data.quotes.length) { dd.classList.add('hidden'); return; }
    dd.innerHTML = data.quotes.slice(0,6).map(s =>
      '<div class="search-item px-4 py-2.5 cursor-pointer flex items-center justify-between" onclick="selectStock(\\'' + s.symbol + '\\')">' +
        '<div><div class="text-sm text-white font-medium">' + (s.name || s.symbol) + '</div>' +
        '<div class="text-xs text-gray-500">' + s.symbol + ' · ' + (s.exchange || '') + '</div></div>' +
        '<span class="text-xs px-2 py-0.5 rounded" style="background:#1e2235;color:#6366f1;">' + (s.type || '') + '</span>' +
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
  } finally {
    document.getElementById('loading').classList.add('hidden');
  }
}

function fmt(n, decimals=0) {
  if (n == null || isNaN(n)) return '-';
  return n.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function renderResult(d) {
  const ind = d.indicators;
  const lastRsi = ind.rsi.filter(v => v != null).pop();
  const lastMacd = ind.macd[ind.macd.length - 1];
  const lastSig = ind.macdSignal[ind.macdSignal.length - 1];
  const lastBbU = ind.bbUpper.filter(v => v != null).pop();
  const lastBbL = ind.bbLower.filter(v => v != null).pop();
  const lastBbM = ind.bbMiddle.filter(v => v != null).pop();
  const lastK = ind.stochK.filter(v => v != null).pop();
  const lastD = ind.stochD.filter(v => v != null).pop();
  const lastSma5 = ind.sma5.filter(v => v != null).pop();
  const lastSma20 = ind.sma20.filter(v => v != null).pop();
  const lastSma60 = ind.sma60.filter(v => v != null).pop();
  const lastSma120 = ind.sma120.filter(v => v != null).pop();
  const price = d.currentPrice;

  // 헤더
  document.getElementById('stockName').textContent = d.name;
  document.getElementById('stockSymbol').textContent = d.symbol;
  document.getElementById('stockExchange').textContent = d.exchange || '';
  document.getElementById('stockPrice').textContent = fmt(price, price > 100 ? 0 : 2) + ' ' + (d.currency === 'KRW' ? '원' : d.currency);
  const chgEl = document.getElementById('stockChange');
  chgEl.textContent = (d.change >= 0 ? '+' : '') + fmt(d.change, price > 100 ? 0 : 2) + ' (' + (d.change >= 0 ? '+' : '') + d.changePct.toFixed(2) + '%)';
  chgEl.className = 'text-lg font-semibold ' + (d.change >= 0 ? 'up' : 'down');
  document.getElementById('w52High').textContent = fmt(d.week52High) + ' (' + d.fromHigh.toFixed(1) + '%)';
  document.getElementById('w52Low').textContent = fmt(d.week52Low) + ' (+' + d.fromLow.toFixed(1) + '%)';
  document.getElementById('stockVolume').textContent = fmt(d.volume);

  // 신호 박스
  const s = d.signal;
  const signalBox = document.getElementById('signalBox');
  signalBox.className = 'p-5 rounded-xl min-w-52 ';
  if (s.signal.includes('강력 매수')) signalBox.classList.add('signal-strong-buy');
  else if (s.signal.includes('매수')) signalBox.classList.add('signal-buy');
  else if (s.signal.includes('강력 매도')) signalBox.classList.add('signal-strong-sell');
  else if (s.signal.includes('매도')) signalBox.classList.add('signal-sell');
  else signalBox.classList.add('signal-neutral');

  document.getElementById('signalText').textContent = s.signal;
  document.getElementById('signalScore').textContent = '점수: ' + s.score + '/7';
  document.getElementById('signalReasons').innerHTML = s.reasons.map(r =>
    '<div class="text-xs text-gray-300 py-0.5">' + r + '</div>'
  ).join('');

  // RSI 카드
  const rsiV = lastRsi ? lastRsi.toFixed(1) : '-';
  document.getElementById('rsiVal').textContent = rsiV;
  document.getElementById('rsiVal').className = 'text-2xl font-bold ' + (lastRsi < 30 ? 'up' : lastRsi > 70 ? 'down' : 'text-white');
  document.getElementById('rsiStatus').textContent = lastRsi < 30 ? '🔴 과매도' : lastRsi > 70 ? '🔵 과매수' : '⚪ 중립';
  document.getElementById('rsiBar').style.width = (lastRsi || 50) + '%';

  // MACD 카드
  document.getElementById('macdVal').textContent = lastMacd ? lastMacd.toFixed(2) : '-';
  document.getElementById('macdVal').className = 'text-2xl font-bold ' + (lastMacd > lastSig ? 'up' : 'down');
  document.getElementById('macdStatus').textContent = lastMacd > lastSig ? '📈 강세' : '📉 약세';

  // BB 카드
  if (lastBbU && lastBbL) {
    const bbPct = ((price - lastBbL) / (lastBbU - lastBbL) * 100).toFixed(1);
    document.getElementById('bbVal').textContent = bbPct + '%';
    document.getElementById('bbStatus').textContent = price > lastBbU ? '🔴 상단 돌파' : price < lastBbL ? '🟢 하단 이탈' : '밴드 폭: ' + (lastBbU - lastBbL).toFixed(0);
  }

  // 스토캐스틱
  document.getElementById('stochVal').textContent = lastK ? lastK.toFixed(1) : '-';
  document.getElementById('stochStatus').textContent = 'D: ' + (lastD ? lastD.toFixed(1) : '-') + (lastK > 80 ? ' ⚠️ 과매수' : lastK < 20 ? ' ✅ 과매도' : '');

  // 이동평균
  [['sma5', lastSma5], ['sma20', lastSma20], ['sma60', lastSma60], ['sma120', lastSma120]].forEach(([id, v]) => {
    document.getElementById(id).textContent = fmt(v, price > 100 ? 0 : 2);
    if (v) {
      const diff = ((price - v) / v * 100).toFixed(2);
      document.getElementById(id + 'diff').textContent = (diff >= 0 ? '▲' : '▼') + ' ' + Math.abs(diff) + '%';
      document.getElementById(id + 'diff').className = 'text-xs mt-1 ' + (diff >= 0 ? 'up' : 'down');
    }
  });

  // 가격 테이블 (최근 20일)
  const recent = d.dates.slice(-20).map((date, i0) => {
    const i = d.dates.length - 20 + i0;
    const ohlcv = d.ohlcv[i];
    const rsiV = ind.rsi[i];
    const prev = d.ohlcv[i - 1];
    const chg = prev ? ((ohlcv.close - prev.close) / prev.close * 100) : 0;
    return { date, ...ohlcv, rsi: rsiV, chg };
  }).reverse();

  document.getElementById('priceTable').innerHTML = recent.map(r =>
    '<tr class="border-b border-gray-800 hover:bg-gray-900 transition-colors">' +
      '<td class="py-2 pr-4 text-gray-400 text-xs">' + r.date + '</td>' +
      '<td class="py-2 px-4 text-right text-gray-300">' + fmt(r.open) + '</td>' +
      '<td class="py-2 px-4 text-right up">' + fmt(r.high) + '</td>' +
      '<td class="py-2 px-4 text-right down">' + fmt(r.low) + '</td>' +
      '<td class="py-2 px-4 text-right font-semibold text-white">' + fmt(r.close) + '</td>' +
      '<td class="py-2 px-4 text-right text-gray-400">' + (r.volume ? (r.volume / 1000).toFixed(0) + 'K' : '-') + '</td>' +
      '<td class="py-2 px-4 text-right ' + (r.chg >= 0 ? 'up' : 'down') + '">' + (r.chg >= 0 ? '+' : '') + r.chg.toFixed(2) + '%</td>' +
      '<td class="py-2 pl-4 text-right">' +
        (r.rsi ? '<span class="px-2 py-0.5 rounded text-xs ' + (r.rsi < 30 ? 'badge-buy' : r.rsi > 70 ? 'badge-sell' : 'badge-neutral') + '">' + r.rsi.toFixed(1) + '</span>' : '-') +
      '</td>' +
    '</tr>'
  ).join('');

  // 차트 렌더링
  switchTab(currentTab, true);
}

function switchTab(tab, force = false) {
  if (tab === currentTab && !force && mainChart) return;
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  renderChart(tab);
}

function renderChart(tab) {
  if (!currentData) return;
  if (mainChart) { mainChart.destroy(); mainChart = null; }
  const ctx = document.getElementById('mainChart').getContext('2d');
  const d = currentData;
  const ind = d.indicators;
  const N = Math.min(d.dates.length, 252); // 최근 1년
  const labels = d.dates.slice(-N);

  const gridColor = 'rgba(255,255,255,0.05)';
  const baseOptions = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#a0a3b1', font: { size: 11 }, boxWidth: 20 } },
      tooltip: {
        backgroundColor: '#1e2235', borderColor: '#3a3d4e', borderWidth: 1,
        titleColor: '#e0e0e0', bodyColor: '#a0a3b1',
      }
    },
    scales: {
      x: {
        ticks: { color: '#6b6f8a', font: { size: 10 }, maxTicksLimit: 12 },
        grid: { color: gridColor }
      },
      y: {
        ticks: { color: '#6b6f8a', font: { size: 11 } },
        grid: { color: gridColor }
      }
    }
  };

  if (tab === 'price') {
    const closes = d.ohlcv.slice(-N).map(x => x.close);
    mainChart = new Chart(ctx, {
      type: 'line', data: {
        labels,
        datasets: [
          { label: '종가', data: closes, borderColor: '#6366f1', borderWidth: 2, pointRadius: 0, tension: 0.1, fill: false, order: 1 },
          { label: 'SMA 5', data: ind.sma5.slice(-N), borderColor: '#fbbf24', borderWidth: 1, pointRadius: 0, tension: 0.1 },
          { label: 'SMA 20', data: ind.sma20.slice(-N), borderColor: '#34d399', borderWidth: 1, pointRadius: 0, tension: 0.1 },
          { label: 'SMA 60', data: ind.sma60.slice(-N), borderColor: '#f87171', borderWidth: 1, pointRadius: 0, tension: 0.1 },
          { label: 'SMA 120', data: ind.sma120.slice(-N), borderColor: '#a78bfa', borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
        ]
      }, options: { ...baseOptions }
    });
  } else if (tab === 'rsi') {
    mainChart = new Chart(ctx, {
      type: 'line', data: {
        labels,
        datasets: [
          { label: 'RSI (14)', data: ind.rsi.slice(-N), borderColor: '#6366f1', borderWidth: 2, pointRadius: 0, tension: 0.1 },
        ]
      }, options: {
        ...baseOptions,
        plugins: { ...baseOptions.plugins, annotation: {} },
        scales: {
          ...baseOptions.scales,
          y: { ...baseOptions.scales.y, min: 0, max: 100,
            ticks: { color: '#6b6f8a', font: { size: 11 },
              callback: v => v === 30 ? '과매도 30' : v === 70 ? '과매수 70' : v }
          }
        }
      }
    });
    // RSI 기준선 (30, 70) 수동 표시
    const meta = mainChart.getDatasetMeta(0);
    mainChart.options.plugins.tooltip.callbacks = {
      afterLabel: (c) => {
        const v = c.parsed.y;
        if (v > 70) return '⚠️ 과매수 구간';
        if (v < 30) return '✅ 과매도 구간';
        return '';
      }
    };
  } else if (tab === 'macd') {
    mainChart = new Chart(ctx, {
      type: 'bar', data: {
        labels,
        datasets: [
          { type: 'bar', label: 'MACD 히스토그램', data: ind.macdHistogram.slice(-N),
            backgroundColor: ind.macdHistogram.slice(-N).map(v => v >= 0 ? 'rgba(99,255,132,0.5)' : 'rgba(255,99,99,0.5)'),
            borderColor: ind.macdHistogram.slice(-N).map(v => v >= 0 ? '#63ff84' : '#ff6363'),
            borderWidth: 1, order: 2 },
          { type: 'line', label: 'MACD', data: ind.macd.slice(-N), borderColor: '#6366f1', borderWidth: 2, pointRadius: 0, order: 1 },
          { type: 'line', label: '시그널', data: ind.macdSignal.slice(-N), borderColor: '#f97316', borderWidth: 1.5, pointRadius: 0, order: 0 },
        ]
      }, options: { ...baseOptions }
    });
  } else if (tab === 'bb') {
    const closes = d.ohlcv.slice(-N).map(x => x.close);
    mainChart = new Chart(ctx, {
      type: 'line', data: {
        labels,
        datasets: [
          { label: '상단 밴드', data: ind.bbUpper.slice(-N), borderColor: '#f87171', borderWidth: 1, pointRadius: 0, borderDash: [4,4], fill: false },
          { label: '중간 (SMA20)', data: ind.bbMiddle.slice(-N), borderColor: '#a78bfa', borderWidth: 1.5, pointRadius: 0, fill: false },
          { label: '하단 밴드', data: ind.bbLower.slice(-N), borderColor: '#34d399', borderWidth: 1, pointRadius: 0, borderDash: [4,4], fill: false },
          { label: '종가', data: closes, borderColor: '#fbbf24', borderWidth: 2, pointRadius: 0, fill: false },
        ]
      }, options: { ...baseOptions }
    });
  } else if (tab === 'stoch') {
    mainChart = new Chart(ctx, {
      type: 'line', data: {
        labels,
        datasets: [
          { label: 'Stoch K', data: ind.stochK.slice(-N), borderColor: '#6366f1', borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Stoch D', data: ind.stochD.slice(-N), borderColor: '#f97316', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        ]
      }, options: {
        ...baseOptions,
        scales: { ...baseOptions.scales, y: { ...baseOptions.scales.y, min: 0, max: 100 } }
      }
    });
  } else if (tab === 'volume') {
    const volumes = d.ohlcv.slice(-N).map(x => x.volume);
    const closes = d.ohlcv.slice(-N).map(x => x.close);
    mainChart = new Chart(ctx, {
      type: 'bar', data: {
        labels,
        datasets: [
          { label: '거래량', data: volumes,
            backgroundColor: d.ohlcv.slice(-N).map((x,i,arr) => i > 0 && x.close >= arr[i-1].close ? 'rgba(255,71,87,0.6)' : 'rgba(30,144,255,0.6)'),
            yAxisID: 'y' },
          { type: 'line', label: '종가', data: closes, borderColor: '#fbbf24', borderWidth: 1.5, pointRadius: 0, yAxisID: 'y1' }
        ]
      }, options: {
        ...baseOptions,
        scales: {
          ...baseOptions.scales,
          y: { ...baseOptions.scales.y, position: 'left' },
          y1: { position: 'right', ticks: { color: '#6b6f8a', font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  }
}
</script>
</body>
</html>`)
})

export default app
/**
 * 주식 종목 스크리닝 & 추천 엔진
 *
 * ─ 단기 투자: 1개월 ~ 6개월
 *   핵심 지표: 기술적 지표(RSI·MACD·볼린저), 거래량 급증, 모멘텀, 52주 위치
 *
 * ─ 장기 투자: 1년 ~ 5년+
 *   핵심 지표: 재무건전성(PER·PBR·ROE), 모멘텀 지속성, 섹터 안정성, 이동평균 정배열
 */

// ─── 분석 대상 종목 풀 ────────────────────────────────────────────────────────
// 국내(KOSPI/KOSDAQ) + 미국(S&P500 주요 종목) + ETF 포함
export const STOCK_UNIVERSE = {
  korea_large: [
    { symbol: '005930.KS', name: '삼성전자',     sector: '반도체', market: 'KOSPI' },
    { symbol: '000660.KS', name: 'SK하이닉스',   sector: '반도체', market: 'KOSPI' },
    { symbol: '035420.KS', name: 'NAVER',        sector: 'IT',    market: 'KOSPI' },
    { symbol: '035720.KS', name: '카카오',        sector: 'IT',    market: 'KOSPI' },
    { symbol: '005380.KS', name: '현대차',        sector: '자동차', market: 'KOSPI' },
    { symbol: '000270.KS', name: '기아',          sector: '자동차', market: 'KOSPI' },
    { symbol: '051910.KS', name: 'LG화학',        sector: '화학',  market: 'KOSPI' },
    { symbol: '006400.KS', name: '삼성SDI',       sector: '배터리', market: 'KOSPI' },
    { symbol: '207940.KS', name: '삼성바이오로직스', sector: '바이오', market: 'KOSPI' },
    { symbol: '068270.KS', name: '셀트리온',       sector: '바이오', market: 'KOSPI' },
    { symbol: '105560.KS', name: 'KB금융',         sector: '금융',  market: 'KOSPI' },
    { symbol: '055550.KS', name: '신한지주',        sector: '금융',  market: 'KOSPI' },
    { symbol: '032830.KS', name: '삼성생명',        sector: '보험',  market: 'KOSPI' },
    { symbol: '012330.KS', name: '현대모비스',       sector: '자동차부품', market: 'KOSPI' },
    { symbol: '028260.KS', name: '삼성물산',        sector: '건설',  market: 'KOSPI' },
    { symbol: '096770.KS', name: 'SK이노베이션',    sector: '에너지', market: 'KOSPI' },
    { symbol: '034730.KS', name: 'SK',             sector: '지주',  market: 'KOSPI' },
    { symbol: '017670.KS', name: 'SK텔레콤',       sector: '통신',  market: 'KOSPI' },
    { symbol: '030200.KS', name: 'KT',             sector: '통신',  market: 'KOSPI' },
    { symbol: '003550.KS', name: 'LG',             sector: '지주',  market: 'KOSPI' },
  ],
  korea_growth: [
    { symbol: '247540.KS', name: '에코프로비엠',   sector: '배터리', market: 'KOSPI' },
    { symbol: '086520.KS', name: '에코프로',        sector: '배터리', market: 'KOSPI' },
    { symbol: '373220.KS', name: 'LG에너지솔루션', sector: '배터리', market: 'KOSPI' },
    { symbol: '259960.KS', name: '크래프톤',        sector: '게임',  market: 'KOSPI' },
    { symbol: '036570.KS', name: 'NCsoft',          sector: '게임',  market: 'KOSPI' },
    { symbol: '251270.KS', name: '넷마블',          sector: '게임',  market: 'KOSPI' },
    { symbol: '011200.KS', name: 'HMM',             sector: '해운',  market: 'KOSPI' },
    { symbol: '009150.KS', name: '삼성전기',        sector: '전자부품', market: 'KOSPI' },
    { symbol: '066570.KS', name: 'LG전자',          sector: '전자',  market: 'KOSPI' },
    { symbol: '000100.KS', name: '유한양행',         sector: '제약',  market: 'KOSPI' },
  ],
  us_large: [
    { symbol: 'AAPL',  name: 'Apple',       sector: 'Tech',      market: 'NASDAQ' },
    { symbol: 'MSFT',  name: 'Microsoft',   sector: 'Tech',      market: 'NASDAQ' },
    { symbol: 'NVDA',  name: 'NVIDIA',      sector: 'Semicon',   market: 'NASDAQ' },
    { symbol: 'GOOGL', name: 'Alphabet',    sector: 'Tech',      market: 'NASDAQ' },
    { symbol: 'AMZN',  name: 'Amazon',      sector: 'E-Commerce', market: 'NASDAQ' },
    { symbol: 'META',  name: 'Meta',        sector: 'Social',    market: 'NASDAQ' },
    { symbol: 'TSLA',  name: 'Tesla',       sector: 'EV',        market: 'NASDAQ' },
    { symbol: 'AMD',   name: 'AMD',         sector: 'Semicon',   market: 'NASDAQ' },
    { symbol: 'INTC',  name: 'Intel',       sector: 'Semicon',   market: 'NASDAQ' },
    { symbol: 'JPM',   name: 'JPMorgan',    sector: 'Finance',   market: 'NYSE'   },
    { symbol: 'JNJ',   name: 'J&J',         sector: 'Healthcare', market: 'NYSE'  },
    { symbol: 'V',     name: 'Visa',        sector: 'Finance',   market: 'NYSE'   },
    { symbol: 'WMT',   name: 'Walmart',     sector: 'Retail',    market: 'NYSE'   },
    { symbol: 'XOM',   name: 'ExxonMobil',  sector: 'Energy',    market: 'NYSE'   },
    { symbol: 'PLTR',  name: 'Palantir',    sector: 'AI/Data',   market: 'NYSE'   },
  ],
}

// 전체 종목 풀 (flat)
export const ALL_STOCKS = [
  ...STOCK_UNIVERSE.korea_large,
  ...STOCK_UNIVERSE.korea_growth,
  ...STOCK_UNIVERSE.us_large,
]

// ─── 기술적 지표 계산 ─────────────────────────────────────────────────────────
function sma(data: number[], period: number): number[] {
  return data.map((_, i) => {
    if (i < period - 1) return NaN
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
  })
}

function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const result: number[] = []
  data.forEach((v, i) => {
    if (i === 0) { result.push(v); return }
    result.push(v * k + result[i - 1] * (1 - k))
  })
  return result
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
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

function macdCross(closes: number[]): { macd: number; signal: number; histogram: number; isBullish: boolean } {
  const e12 = ema(closes, 12); const e26 = ema(closes, 26)
  const macdLine = e12.map((v, i) => v - e26[i])
  const sigLine = ema(macdLine, 9)
  const last = closes.length - 1
  return {
    macd: macdLine[last],
    signal: sigLine[last],
    histogram: macdLine[last] - sigLine[last],
    isBullish: macdLine[last - 1] < sigLine[last - 1] && macdLine[last] > sigLine[last],
  }
}

function bollingerPosition(closes: number[], period = 20): { pct: number; width: number } {
  if (closes.length < period) return { pct: 0.5, width: 0 }
  const slice = closes.slice(-period)
  const mean = slice.reduce((a, b) => a + b, 0) / period
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period)
  const upper = mean + 2 * std; const lower = mean - 2 * std
  const last = closes[closes.length - 1]
  return {
    pct: upper === lower ? 0.5 : (last - lower) / (upper - lower),
    width: std / mean,  // 밴드 폭 (변동성 지표)
  }
}

function volumeMomentum(volumes: number[]): { ratio: number; isSpike: boolean } {
  if (volumes.length < 20) return { ratio: 1, isSpike: false }
  const recent = volumes[volumes.length - 1]
  const avg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20
  const ratio = avg20 > 0 ? recent / avg20 : 1
  return { ratio, isSpike: ratio > 2.0 }
}

function pricePosition52w(closes: number[]): { fromHigh: number; fromLow: number; position: number } {
  const year = closes.slice(-252)
  const high = Math.max(...year); const low = Math.min(...year)
  const last = closes[closes.length - 1]
  return {
    fromHigh: ((last - high) / high) * 100,
    fromLow: ((last - low) / low) * 100,
    position: high === low ? 0.5 : (last - low) / (high - low),  // 0~1
  }
}

function movingAverageAlignment(closes: number[]): {
  isGoldenOrder: boolean   // 5 > 20 > 60 > 120 (정배열)
  isDeathOrder: boolean    // 5 < 20 < 60 < 120 (역배열)
  aboveSma20: boolean
  aboveSma60: boolean
  aboveSma120: boolean
  slope20: number          // SMA20 기울기 (%)
} {
  const s5   = sma(closes, 5).filter(v => !isNaN(v))
  const s20  = sma(closes, 20).filter(v => !isNaN(v))
  const s60  = sma(closes, 60).filter(v => !isNaN(v))
  const s120 = sma(closes, 120).filter(v => !isNaN(v))
  const last = closes[closes.length - 1]
  const lS5 = s5[s5.length - 1] || last
  const lS20 = s20[s20.length - 1] || last
  const lS60 = s60[s60.length - 1] || last
  const lS120 = s120[s120.length - 1] || last
  // SMA20 기울기: 최근 5봉 대비 변화율
  const prevS20 = s20[s20.length - 6] || lS20
  const slope20 = prevS20 > 0 ? ((lS20 - prevS20) / prevS20) * 100 : 0
  return {
    isGoldenOrder: lS5 > lS20 && lS20 > lS60 && lS60 > lS120,
    isDeathOrder:  lS5 < lS20 && lS20 < lS60 && lS60 < lS120,
    aboveSma20:  last > lS20,
    aboveSma60:  last > lS60,
    aboveSma120: last > lS120,
    slope20,
  }
}

function momentum(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0
  const past = closes[closes.length - 1 - period]
  const now  = closes[closes.length - 1]
  return past > 0 ? ((now - past) / past) * 100 : 0
}

// ─── 재무 지표 파싱 (Yahoo Finance fundamentals-timeseries) ──────────────────
export interface FinancialData {
  per: number | null        // Price/Earnings (trailingPeRatio)
  pbr: number | null        // Price/Book (calculated or trailingPriceToBook)
  psr: number | null        // Price/Sales
  roe: number | null        // Return on Equity (NetIncome / Equity)
  roa: number | null        // Return on Assets (NetIncome / Assets)
  debtRatio: number | null  // 부채비율 D/E %
  revenueGrowth: number | null  // 매출 성장률 YoY %
  earningsGrowth: number | null // 순이익 성장률 YoY %
  operatingMargin: number | null
  currentRatio: number | null   // 유동비율
  marketCap: number | null
  dividendYield: number | null
}

async function fetchFinancials(symbol: string): Promise<FinancialData> {
  const empty: FinancialData = {
    per: null, pbr: null, psr: null, roe: null, roa: null,
    debtRatio: null, revenueGrowth: null, earningsGrowth: null,
    operatingMargin: null, currentRatio: null, marketCap: null, dividendYield: null,
  }
  try {
    // Yahoo Finance fundamentals-timeseries (crumb 불필요, 공개 접근)
    const period1 = Math.floor(Date.now() / 1000) - 3 * 365 * 24 * 3600  // 3년 전
    const period2 = Math.floor(Date.now() / 1000)
    const types = [
      'annualTotalRevenue', 'annualNetIncome', 'annualOperatingIncome',
      'annualGrossProfit', 'annualTotalDebt', 'annualTotalAssets',
      'annualStockholdersEquity', 'annualCurrentAssets', 'annualCurrentLiabilities',
      'trailingPeRatio', 'trailingMarketCap',
    ].join(',')
    const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${symbol}?type=${types}&period1=${period1}&period2=${period2}`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return empty
    const raw: any = await res.json()
    const ts: any[] = raw?.timeseries?.result || []

    // 타입별 최신값 + 이전값 수집
    const data: Record<string, [number | null, number | null]> = {}
    for (const r of ts) {
      const types: string[] = r?.meta?.type || []
      for (const t of types) {
        const vals: any[] = r[t] || []
        const curr = vals.length > 0 ? (vals[vals.length - 1]?.reportedValue?.raw ?? null) : null
        const prev = vals.length > 1 ? (vals[vals.length - 2]?.reportedValue?.raw ?? null) : null
        data[t] = [curr, prev]
      }
    }

    const get = (k: string): number | null => data[k]?.[0] ?? null
    const getPrev = (k: string): number | null => data[k]?.[1] ?? null

    const rev     = get('annualTotalRevenue')
    const revPrev = getPrev('annualTotalRevenue')
    const netInc  = get('annualNetIncome')
    const netPrev = getPrev('annualNetIncome')
    const opInc   = get('annualOperatingIncome')
    const equity  = get('annualStockholdersEquity')
    const assets  = get('annualTotalAssets')
    const debt    = get('annualTotalDebt')
    const currA   = get('annualCurrentAssets')
    const currL   = get('annualCurrentLiabilities')

    return {
      per:             get('trailingPeRatio'),
      pbr:             null,  // 별도 계산 불가 (시가 필요)
      psr:             null,
      roe:             (netInc && equity && equity !== 0) ? (netInc / equity) * 100 : null,
      roa:             (netInc && assets && assets !== 0) ? (netInc / assets) * 100 : null,
      debtRatio:       (debt && equity && equity !== 0) ? (debt / equity) * 100 : null,
      revenueGrowth:   (rev && revPrev && revPrev !== 0) ? ((rev - revPrev) / revPrev) * 100 : null,
      earningsGrowth:  (netInc && netPrev && netPrev !== 0) ? ((netInc - netPrev) / netPrev) * 100 : null,
      operatingMargin: (opInc && rev && rev !== 0) ? (opInc / rev) * 100 : null,
      currentRatio:    (currA && currL && currL !== 0) ? currA / currL : null,
      marketCap:       get('trailingMarketCap'),
      dividendYield:   null,
    }
  } catch { return empty }
}

// ─── 단기 투자 점수 (0~100) ───────────────────────────────────────────────────
export interface ShortTermScore {
  total: number
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
  details: {
    rsiScore: number       // 20점
    macdScore: number      // 20점
    volumeScore: number    // 20점
    momentumScore: number  // 20점
    bbScore: number        // 10점
    positionScore: number  // 10점
  }
  reasons: string[]
  risks: string[]
}

export function calcShortTermScore(
  closes: number[],
  volumes: number[],
): ShortTermScore {
  const reasons: string[] = []
  const risks: string[]   = []
  let total = 0

  // 1. RSI 분석 (20점)
  const rsiVal = rsi(closes)
  let rsiScore = 0
  if (rsiVal < 25) { rsiScore = 20; reasons.push(`RSI ${rsiVal.toFixed(1)} - 극심한 과매도 (강한 반등 기대)`) }
  else if (rsiVal < 35) { rsiScore = 17; reasons.push(`RSI ${rsiVal.toFixed(1)} - 과매도 구간 (매수 기회)`) }
  else if (rsiVal < 45) { rsiScore = 13; reasons.push(`RSI ${rsiVal.toFixed(1)} - 약세 중립`) }
  else if (rsiVal < 55) { rsiScore = 10; }
  else if (rsiVal < 65) { rsiScore = 8;  }
  else if (rsiVal < 75) { rsiScore = 4;  risks.push(`RSI ${rsiVal.toFixed(1)} - 과매수 접근`) }
  else { rsiScore = 0; risks.push(`RSI ${rsiVal.toFixed(1)} - 과매수 구간 (조정 위험)`) }

  // 2. MACD 분석 (20점)
  const macdData = macdCross(closes)
  let macdScore = 0
  if (macdData.isBullish) {
    macdScore = 20; reasons.push('MACD 골든크로스 발생 (강한 매수 신호)')
  } else if (macdData.histogram > 0 && macdData.macd > 0) {
    macdScore = 15; reasons.push('MACD 양전환 + 0선 위 (상승 추세)')
  } else if (macdData.histogram > 0) {
    macdScore = 10; reasons.push('MACD 히스토그램 상승 중')
  } else if (macdData.histogram < 0 && macdData.macd < 0) {
    macdScore = 2; risks.push('MACD 0선 아래 + 음수 (하락 추세)')
  } else {
    macdScore = 5
  }

  // 3. 거래량 모멘텀 (20점)
  const vol = volumeMomentum(volumes)
  let volumeScore = 0
  if (vol.isSpike && macdData.histogram > 0) {
    volumeScore = 20; reasons.push(`거래량 ${vol.ratio.toFixed(1)}배 급증 + 상승 (강한 매수세 유입)`)
  } else if (vol.isSpike) {
    volumeScore = 12; reasons.push(`거래량 ${vol.ratio.toFixed(1)}배 급증 (세력 개입 가능성)`)
  } else if (vol.ratio > 1.3) {
    volumeScore = 8; reasons.push(`거래량 평균 대비 ${vol.ratio.toFixed(1)}배 증가`)
  } else if (vol.ratio < 0.5) {
    volumeScore = 3; risks.push('거래량 급감 (관심도 저하)')
  } else {
    volumeScore = 6
  }

  // 4. 단기 모멘텀 (20점): 5일·20일 수익률
  const mom5  = momentum(closes, 5)
  const mom20 = momentum(closes, 20)
  let momentumScore = 0
  if (mom5 > 3 && mom20 > 5) {
    momentumScore = 20; reasons.push(`5일 +${mom5.toFixed(1)}%, 20일 +${mom20.toFixed(1)}% (강한 상승 모멘텀)`)
  } else if (mom5 > 0 && mom20 > 0) {
    momentumScore = 14; reasons.push(`5일 +${mom5.toFixed(1)}%, 20일 +${mom20.toFixed(1)}% (상승 추세)`)
  } else if (mom5 > 0) {
    momentumScore = 9
  } else if (mom20 < -10) {
    momentumScore = 2; risks.push(`20일 ${mom20.toFixed(1)}% (강한 하락 추세)`)
  } else {
    momentumScore = 4
  }

  // 5. 볼린저밴드 위치 (10점)
  const bb = bollingerPosition(closes)
  let bbScore = 0
  if (bb.pct < 0.1) {
    bbScore = 10; reasons.push('볼린저밴드 하단 이탈 (강한 반등 가능성)')
  } else if (bb.pct < 0.25) {
    bbScore = 8; reasons.push('볼린저밴드 하단 근접 (반등 시도 구간)')
  } else if (bb.pct > 0.9) {
    bbScore = 1; risks.push('볼린저밴드 상단 돌파 (단기 과열)')
  } else if (bb.pct > 0.7) {
    bbScore = 4
  } else {
    bbScore = 6
  }

  // 6. 이동평균 정배열 (10점)
  const maAlign = movingAverageAlignment(closes)
  let positionScore = 0
  if (maAlign.isGoldenOrder) {
    positionScore = 10; reasons.push('이동평균 완전 정배열 (5>20>60>120 강한 상승 구조)')
  } else if (maAlign.aboveSma20 && maAlign.aboveSma60) {
    positionScore = 8; reasons.push('주가 SMA20·SMA60 위 (중기 상승 추세)')
  } else if (maAlign.aboveSma20) {
    positionScore = 5
  } else if (maAlign.isDeathOrder) {
    positionScore = 0; risks.push('이동평균 역배열 (하락 추세 지속)')
  } else {
    positionScore = 3
  }

  total = rsiScore + macdScore + volumeScore + momentumScore + bbScore + positionScore

  const grade: ShortTermScore['grade'] =
    total >= 80 ? 'S' : total >= 65 ? 'A' : total >= 50 ? 'B' : total >= 35 ? 'C' : 'D'

  return { total, grade, details: { rsiScore, macdScore, volumeScore, momentumScore, bbScore, positionScore }, reasons, risks }
}

// ─── 장기 투자 점수 (0~100) ───────────────────────────────────────────────────
export interface LongTermScore {
  total: number
  grade: 'S' | 'A' | 'B' | 'C' | 'D'
  details: {
    financialScore: number   // 40점 (재무 건전성)
    growthScore: number      // 25점 (성장성)
    stabilityScore: number   // 20점 (안정성·모멘텀)
    valuationScore: number   // 15점 (밸류에이션)
  }
  reasons: string[]
  risks: string[]
}

export function calcLongTermScore(
  closes: number[],
  volumes: number[],
  fin: FinancialData,
): LongTermScore {
  const reasons: string[] = []
  const risks: string[]   = []

  // 1. 재무 건전성 (40점)
  let financialScore = 0

  // ROE (15점)
  if (fin.roe !== null) {
    if (fin.roe > 20)      { financialScore += 15; reasons.push(`ROE ${fin.roe.toFixed(1)}% - 우수한 자기자본이익률`) }
    else if (fin.roe > 15) { financialScore += 12; reasons.push(`ROE ${fin.roe.toFixed(1)}% - 양호한 수익성`) }
    else if (fin.roe > 10) { financialScore += 8  }
    else if (fin.roe > 5)  { financialScore += 4  }
    else if (fin.roe < 0)  { risks.push(`ROE ${fin.roe.toFixed(1)}% - 적자 상태`) }
  } else { financialScore += 5 } // 데이터 없으면 중간값

  // 부채비율 (10점)
  if (fin.debtRatio !== null) {
    if (fin.debtRatio < 50)       { financialScore += 10; reasons.push(`부채비율 ${fin.debtRatio.toFixed(0)}% - 매우 안전`) }
    else if (fin.debtRatio < 100) { financialScore += 7;  reasons.push(`부채비율 ${fin.debtRatio.toFixed(0)}% - 안정적`) }
    else if (fin.debtRatio < 200) { financialScore += 4  }
    else { risks.push(`부채비율 ${fin.debtRatio.toFixed(0)}% - 과도한 부채`) }
  } else { financialScore += 4 }

  // 영업이익률 (10점)
  if (fin.operatingMargin !== null) {
    if (fin.operatingMargin > 25)      { financialScore += 10; reasons.push(`영업이익률 ${fin.operatingMargin.toFixed(1)}% - 독보적 수익성`) }
    else if (fin.operatingMargin > 15) { financialScore += 8;  reasons.push(`영업이익률 ${fin.operatingMargin.toFixed(1)}% - 우수`) }
    else if (fin.operatingMargin > 8)  { financialScore += 5  }
    else if (fin.operatingMargin < 0)  { risks.push('영업손실 발생') }
    else { financialScore += 2 }
  } else { financialScore += 4 }

  // 유동비율 (5점)
  if (fin.currentRatio !== null) {
    if (fin.currentRatio > 2)    { financialScore += 5; reasons.push(`유동비율 ${fin.currentRatio.toFixed(1)} - 단기 지급능력 우수`) }
    else if (fin.currentRatio > 1.5) { financialScore += 3 }
    else if (fin.currentRatio < 1)   { risks.push(`유동비율 ${fin.currentRatio.toFixed(1)} - 단기 유동성 위험`) }
    else { financialScore += 2 }
  } else { financialScore += 2 }

  // 2. 성장성 (25점)
  let growthScore = 0

  // 매출 성장률 (12점)
  if (fin.revenueGrowth !== null) {
    if (fin.revenueGrowth > 30)      { growthScore += 12; reasons.push(`매출 성장률 +${fin.revenueGrowth.toFixed(1)}% (고성장)`) }
    else if (fin.revenueGrowth > 15) { growthScore += 10; reasons.push(`매출 성장률 +${fin.revenueGrowth.toFixed(1)}% (성장 중)`) }
    else if (fin.revenueGrowth > 5)  { growthScore += 7  }
    else if (fin.revenueGrowth > 0)  { growthScore += 4  }
    else { risks.push(`매출 성장률 ${fin.revenueGrowth.toFixed(1)}% (매출 감소)`) }
  } else { growthScore += 5 }

  // 이익 성장률 (13점)
  if (fin.earningsGrowth !== null) {
    if (fin.earningsGrowth > 40)      { growthScore += 13; reasons.push(`이익 성장률 +${fin.earningsGrowth.toFixed(1)}% (폭발적 성장)`) }
    else if (fin.earningsGrowth > 20) { growthScore += 10; reasons.push(`이익 성장률 +${fin.earningsGrowth.toFixed(1)}% (강한 성장)`) }
    else if (fin.earningsGrowth > 10) { growthScore += 7  }
    else if (fin.earningsGrowth > 0)  { growthScore += 4  }
    else { risks.push(`이익 성장률 ${fin.earningsGrowth.toFixed(1)}% (이익 감소)`) }
  } else { growthScore += 5 }

  // 3. 안정성 & 장기 모멘텀 (20점)
  let stabilityScore = 0
  const maAlign = movingAverageAlignment(closes)
  const mom60  = momentum(closes, 60)   // 3개월
  const mom120 = momentum(closes, 120)  // 6개월

  // 이동평균 정배열 (10점)
  if (maAlign.isGoldenOrder) {
    stabilityScore += 10; reasons.push('장기 이동평균 완전 정배열 (지속적 상승 구조)')
  } else if (maAlign.aboveSma60 && maAlign.aboveSma120) {
    stabilityScore += 7; reasons.push('장기 이동평균 위 (장기 상승 추세 유지)')
  } else if (maAlign.aboveSma120) {
    stabilityScore += 5
  } else if (maAlign.isDeathOrder) {
    risks.push('장기 이동평균 역배열 (장기 하락 추세)')
  }

  // 장기 모멘텀 (10점)
  if (mom60 > 15 && mom120 > 20) {
    stabilityScore += 10; reasons.push(`3개월 +${mom60.toFixed(1)}%, 6개월 +${mom120.toFixed(1)}% (강한 장기 모멘텀)`)
  } else if (mom60 > 5 && mom120 > 10) {
    stabilityScore += 7; reasons.push(`3개월 +${mom60.toFixed(1)}%, 6개월 +${mom120.toFixed(1)}% (중기 상승세)`)
  } else if (mom120 > 0) {
    stabilityScore += 4
  } else if (mom120 < -20) {
    risks.push(`6개월 ${mom120.toFixed(1)}% (장기 하락세)`)
  } else {
    stabilityScore += 2
  }

  // 4. 밸류에이션 (15점)
  let valuationScore = 0

  // PER (8점)
  if (fin.per !== null) {
    if (fin.per > 0 && fin.per < 10)       { valuationScore += 8; reasons.push(`PER ${fin.per.toFixed(1)} - 저평가 (매수 기회)`) }
    else if (fin.per < 20)                  { valuationScore += 6; reasons.push(`PER ${fin.per.toFixed(1)} - 적정 밸류에이션`) }
    else if (fin.per < 35)                  { valuationScore += 3 }
    else if (fin.per > 100)                 { risks.push(`PER ${fin.per.toFixed(1)} - 고평가 위험`) }
    else                                    { valuationScore += 1 }
  } else { valuationScore += 3 }

  // PBR (7점)
  if (fin.pbr !== null) {
    if (fin.pbr > 0 && fin.pbr < 1)        { valuationScore += 7; reasons.push(`PBR ${fin.pbr.toFixed(2)} - 자산 대비 저평가`) }
    else if (fin.pbr < 2)                   { valuationScore += 5; reasons.push(`PBR ${fin.pbr.toFixed(2)} - 적정 수준`) }
    else if (fin.pbr < 4)                   { valuationScore += 3 }
    else { risks.push(`PBR ${fin.pbr.toFixed(2)} - 자산 대비 고평가`) }
  } else { valuationScore += 3 }

  const total = financialScore + growthScore + stabilityScore + valuationScore

  const grade: LongTermScore['grade'] =
    total >= 80 ? 'S' : total >= 65 ? 'A' : total >= 50 ? 'B' : total >= 35 ? 'C' : 'D'

  return {
    total,
    grade,
    details: { financialScore, growthScore, stabilityScore, valuationScore },
    reasons,
    risks,
  }
}

// ─── 야후 파이낸스 1년 데이터 조회 ───────────────────────────────────────────
export async function fetchStockData(symbol: string): Promise<{
  closes: number[]
  volumes: number[]
  currentPrice: number
  name: string
  currency: string
  marketCap: number | null
} | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    const raw: any = await res.json()
    const result = raw?.chart?.result?.[0]
    if (!result) return null
    const ohlcv = result.indicators?.quote?.[0] || {}
    const closes: number[]  = (ohlcv.close  || []).filter((v: any) => v != null)
    const volumes: number[] = (ohlcv.volume || []).filter((v: any) => v != null)
    if (closes.length < 30) return null
    return {
      closes,
      volumes,
      currentPrice: closes[closes.length - 1],
      name: result.meta?.shortName || result.meta?.longName || symbol,
      currency: result.meta?.currency || 'KRW',
      marketCap: result.meta?.marketCap || null,
    }
  } catch { return null }
}

// ─── 단일 종목 전체 분석 ──────────────────────────────────────────────────────
export interface StockAnalysis {
  symbol: string
  name: string
  sector: string
  market: string
  currentPrice: number
  currency: string
  marketCap: number | null
  shortTerm: ShortTermScore
  longTerm: LongTermScore
  financials: FinancialData
  momentum: { d5: number; d20: number; d60: number; d120: number }
  position52w: { fromHigh: number; fromLow: number; position: number }
  volume: { ratio: number; isSpike: boolean }
}

export async function analyzeStock(
  stockInfo: { symbol: string; name: string; sector: string; market: string }
): Promise<StockAnalysis | null> {
  const [priceData, fin] = await Promise.all([
    fetchStockData(stockInfo.symbol),
    fetchFinancials(stockInfo.symbol),
  ])
  if (!priceData) return null
  const { closes, volumes } = priceData
  const shortTerm = calcShortTermScore(closes, volumes)
  const longTerm  = calcLongTermScore(closes, volumes, fin)
  return {
    symbol:       stockInfo.symbol,
    name:         priceData.name || stockInfo.name,
    sector:       stockInfo.sector,
    market:       stockInfo.market,
    currentPrice: priceData.currentPrice,
    currency:     priceData.currency,
    marketCap:    priceData.marketCap,
    shortTerm,
    longTerm,
    financials:   fin,
    momentum: {
      d5:   momentum(closes, 5),
      d20:  momentum(closes, 20),
      d60:  momentum(closes, 60),
      d120: momentum(closes, 120),
    },
    position52w: pricePosition52w(closes),
    volume:      volumeMomentum(volumes),
  }
}

// ─── 배치 스크리닝 (병렬 처리, 최대 concurrency 제한) ────────────────────────
export async function screenStocks(
  stocks: typeof ALL_STOCKS,
  concurrency = 5
): Promise<StockAnalysis[]> {
  const results: StockAnalysis[] = []
  for (let i = 0; i < stocks.length; i += concurrency) {
    const batch = stocks.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(s => analyzeStock(s)))
    batchResults.forEach(r => { if (r) results.push(r) })
  }
  return results
}

/**
 * 백테스팅 엔진
 * Yahoo Finance 데이터를 기반으로 전략 시뮬레이션
 */

export interface BacktestParams {
  strategy: 'rsi' | 'macd' | 'bb' | 'combined'
  rsiOversold?: number
  rsiOverbought?: number
  macdFast?: number
  macdSlow?: number
  macdSignal?: number
  bbPeriod?: number
  bbStd?: number
  initialCapital?: number
  feeRate?: number         // 수수료율 (기본 0.015%)
  stopLossPct?: number     // 손절 %
  takeProfitPct?: number   // 익절 %
}

export interface BacktestTrade {
  date: string
  side: 'buy' | 'sell'
  price: number
  quantity: number
  amount: number
  pnl?: number
  pnlPct?: number
  reason: string
  capital: number
}

export interface BacktestResult {
  symbol: string
  strategy: string
  startDate: string
  endDate: string
  initialCapital: number
  finalCapital: number
  totalReturnPct: number
  maxDrawdownPct: number
  winRate: number
  totalTrades: number
  buyAndHoldReturn: number
  sharpeRatio: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  trades: BacktestTrade[]
  equityCurve: { date: string; value: number }[]
}

// ─── 지표 계산 헬퍼 ──────────────────────────────────────────────────────────

function calcSMA(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period
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
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss))
  }
  return result
}

function calcMACD(closes: number[], fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast)
  const emaSlow = calcEMA(closes, slow)
  const macdLine = emaFast.map((v, i) => v - emaSlow[i])
  const signalLine = calcEMA(macdLine, signal)
  const histogram = macdLine.map((v, i) => v - signalLine[i])
  return { macdLine, signalLine, histogram }
}

function calcBB(closes: number[], period = 20, std = 2) {
  const sma = calcSMA(closes, period)
  return closes.map((_, i) => {
    if (i < period - 1) return { upper: null, middle: null, lower: null }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = sma[i]!
    const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period
    const sd = Math.sqrt(variance)
    return { upper: mean + std * sd, middle: mean, lower: mean - std * sd }
  })
}

// ─── 백테스팅 메인 함수 ──────────────────────────────────────────────────────

export function runBacktest(
  symbol: string,
  dates: string[],
  ohlcv: { open: number; high: number; low: number; close: number; volume: number }[],
  params: BacktestParams
): BacktestResult {
  const {
    strategy,
    rsiOversold = 30,
    rsiOverbought = 70,
    initialCapital = 10_000_000,
    feeRate = 0.00015,
    stopLossPct = 5,
    takeProfitPct = 10,
  } = params

  const closes = ohlcv.map(x => x.close)
  const N = closes.length

  // 지표 계산
  const rsi = calcRSI(closes)
  const macd = calcMACD(closes, params.macdFast || 12, params.macdSlow || 26, params.macdSignal || 9)
  const bb = calcBB(closes, params.bbPeriod || 20, params.bbStd || 2)

  let capital = initialCapital
  let position = 0           // 보유 주식 수
  let entryPrice = 0         // 진입 가격
  let entryDate = ''

  const trades: BacktestTrade[] = []
  const equityCurve: { date: string; value: number }[] = []
  let maxEquity = initialCapital
  let maxDrawdown = 0

  for (let i = 1; i < N; i++) {
    const price = closes[i]
    const date = dates[i]
    const currentEquity = capital + position * price
    if (currentEquity > maxEquity) maxEquity = currentEquity
    const drawdown = (maxEquity - currentEquity) / maxEquity * 100
    if (drawdown > maxDrawdown) maxDrawdown = drawdown

    equityCurve.push({ date, value: Math.round(currentEquity) })

    // ─── 포지션 보유 중: 손절/익절 체크 ────────────────────────────────────
    if (position > 0) {
      const pnlPct = (price - entryPrice) / entryPrice * 100

      if (pnlPct <= -stopLossPct) {
        // 손절
        const fee = position * price * feeRate
        const proceeds = position * price - fee
        const pnl = proceeds - position * entryPrice
        capital += proceeds
        trades.push({
          date, side: 'sell', price, quantity: position,
          amount: Math.round(position * price),
          pnl: Math.round(pnl), pnlPct: parseFloat(pnlPct.toFixed(2)),
          reason: `🛑 손절 (${pnlPct.toFixed(1)}%)`,
          capital: Math.round(capital),
        })
        position = 0; entryPrice = 0
        continue
      }

      if (pnlPct >= takeProfitPct) {
        // 익절
        const fee = position * price * feeRate
        const proceeds = position * price - fee
        const pnl = proceeds - position * entryPrice
        capital += proceeds
        trades.push({
          date, side: 'sell', price, quantity: position,
          amount: Math.round(position * price),
          pnl: Math.round(pnl), pnlPct: parseFloat(pnlPct.toFixed(2)),
          reason: `🎯 익절 (${pnlPct.toFixed(1)}%)`,
          capital: Math.round(capital),
        })
        position = 0; entryPrice = 0
        continue
      }
    }

    // ─── 신호 판단 ───────────────────────────────────────────────────────────
    const r = rsi[i]
    const prevR = rsi[i - 1]
    const mLine = macd.macdLine[i]
    const mSig = macd.signalLine[i]
    const prevMLine = macd.macdLine[i - 1]
    const prevMSig = macd.signalLine[i - 1]
    const bbBand = bb[i]

    let buySignal = false
    let sellSignal = false
    let buyReason = ''
    let sellReason = ''

    if (strategy === 'rsi') {
      if (r !== null && prevR !== null && prevR < rsiOversold && r >= rsiOversold) {
        buySignal = true; buyReason = `RSI 반등 (${r.toFixed(1)})`
      }
      if (r !== null && prevR !== null && prevR > rsiOverbought && r <= rsiOverbought) {
        sellSignal = true; sellReason = `RSI 과매수 (${r.toFixed(1)})`
      }
    } else if (strategy === 'macd') {
      if (prevMLine < prevMSig && mLine > mSig) {
        buySignal = true; buyReason = 'MACD 골든크로스'
      }
      if (prevMLine > prevMSig && mLine < mSig) {
        sellSignal = true; sellReason = 'MACD 데드크로스'
      }
    } else if (strategy === 'bb') {
      const prevBb = bb[i - 1]
      if (bbBand.lower && prevBb.lower) {
        if (ohlcv[i - 1].close < prevBb.lower && price >= bbBand.lower) {
          buySignal = true; buyReason = '볼린저 하단 돌파 후 복귀'
        }
        if (ohlcv[i - 1].close > (prevBb.upper || Infinity) && price <= (bbBand.upper || Infinity)) {
          sellSignal = true; sellReason = '볼린저 상단 이탈 후 복귀'
        }
      }
    } else if (strategy === 'combined') {
      // 복합 전략: RSI + MACD + BB 조합
      let score = 0
      const reasons: string[] = []
      if (r !== null && r < rsiOversold) { score += 2; reasons.push(`RSI 과매도(${r.toFixed(0)})`) }
      if (r !== null && r > rsiOverbought) { score -= 2; reasons.push(`RSI 과매수(${r.toFixed(0)})`) }
      if (prevMLine < prevMSig && mLine > mSig) { score += 3; reasons.push('MACD 골든크로스') }
      if (prevMLine > prevMSig && mLine < mSig) { score -= 3; reasons.push('MACD 데드크로스') }
      if (bbBand.lower && price < bbBand.lower) { score += 2; reasons.push('BB 하단 이탈') }
      if (bbBand.upper && price > bbBand.upper) { score -= 2; reasons.push('BB 상단 돌파') }

      if (score >= 3) { buySignal = true; buyReason = reasons.join(', ') }
      if (score <= -3) { sellSignal = true; sellReason = reasons.join(', ') }
    }

    // ─── 매수 실행 ───────────────────────────────────────────────────────────
    if (buySignal && position === 0 && capital > price) {
      const investAmount = capital * 0.95  // 95% 투입
      const qty = Math.floor(investAmount / price)
      if (qty > 0) {
        const fee = qty * price * feeRate
        const cost = qty * price + fee
        capital -= cost
        position = qty
        entryPrice = price
        entryDate = date
        trades.push({
          date, side: 'buy', price, quantity: qty,
          amount: Math.round(qty * price),
          reason: buyReason,
          capital: Math.round(capital),
        })
      }
    }

    // ─── 매도 실행 ───────────────────────────────────────────────────────────
    if (sellSignal && position > 0) {
      const fee = position * price * feeRate
      const proceeds = position * price - fee
      const pnl = proceeds - position * entryPrice
      const pnlPct = (price - entryPrice) / entryPrice * 100
      capital += proceeds
      trades.push({
        date, side: 'sell', price, quantity: position,
        amount: Math.round(position * price),
        pnl: Math.round(pnl), pnlPct: parseFloat(pnlPct.toFixed(2)),
        reason: sellReason,
        capital: Math.round(capital),
      })
      position = 0; entryPrice = 0
    }
  }

  // 잔여 포지션 청산
  if (position > 0) {
    const lastPrice = closes[N - 1]
    const fee = position * lastPrice * feeRate
    const proceeds = position * lastPrice - fee
    const pnl = proceeds - position * entryPrice
    const pnlPct = (lastPrice - entryPrice) / entryPrice * 100
    capital += proceeds
    trades.push({
      date: dates[N - 1], side: 'sell', price: lastPrice, quantity: position,
      amount: Math.round(position * lastPrice),
      pnl: Math.round(pnl), pnlPct: parseFloat(pnlPct.toFixed(2)),
      reason: '백테스트 종료 청산',
      capital: Math.round(capital),
    })
  }

  // ─── 통계 계산 ───────────────────────────────────────────────────────────
  const finalCapital = capital
  const totalReturnPct = (finalCapital - initialCapital) / initialCapital * 100

  const sellTrades = trades.filter(t => t.side === 'sell' && t.pnl != null)
  const wins = sellTrades.filter(t => (t.pnl || 0) > 0)
  const losses = sellTrades.filter(t => (t.pnl || 0) < 0)
  const winRate = sellTrades.length > 0 ? wins.length / sellTrades.length * 100 : 0
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + (t.pnlPct || 0), 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + (t.pnlPct || 0), 0) / losses.length : 0
  const totalWinPnl = wins.reduce((a, t) => a + (t.pnl || 0), 0)
  const totalLossPnl = Math.abs(losses.reduce((a, t) => a + (t.pnl || 0), 0))
  const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 999 : 0

  // 샤프 비율 계산 (간소화)
  const dailyReturns = equityCurve.map((e, i) =>
    i > 0 ? (e.value - equityCurve[i - 1].value) / equityCurve[i - 1].value : 0
  ).slice(1)
  const avgReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length
  const stdReturn = Math.sqrt(dailyReturns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / dailyReturns.length)
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0

  // 바이앤홀드 수익률
  const buyAndHoldReturn = (closes[N - 1] - closes[0]) / closes[0] * 100

  return {
    symbol,
    strategy,
    startDate: dates[0],
    endDate: dates[N - 1],
    initialCapital,
    finalCapital: Math.round(finalCapital),
    totalReturnPct: parseFloat(totalReturnPct.toFixed(2)),
    maxDrawdownPct: parseFloat(maxDrawdown.toFixed(2)),
    winRate: parseFloat(winRate.toFixed(2)),
    totalTrades: trades.length,
    buyAndHoldReturn: parseFloat(buyAndHoldReturn.toFixed(2)),
    sharpeRatio: parseFloat(sharpeRatio.toFixed(3)),
    profitFactor: parseFloat(profitFactor.toFixed(3)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    trades,
    equityCurve,
  }
}
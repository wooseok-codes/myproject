import { Hono } from 'hono'
import {
  ALL_STOCKS, STOCK_UNIVERSE,
  analyzeStock, screenStocks,
  type StockAnalysis,
} from '../lib/screener'

// ─── 시장 필터 헬퍼 ───────────────────────────────────────────────────────────
function filterPool(market: string) {
  switch (market) {
    case 'korea':     return [...STOCK_UNIVERSE.korea_large, ...STOCK_UNIVERSE.korea_growth]
    case 'kosdaq':    return STOCK_UNIVERSE.korea_kosdaq
    case 'korea_all': return [...STOCK_UNIVERSE.korea_large, ...STOCK_UNIVERSE.korea_growth, ...STOCK_UNIVERSE.korea_kosdaq]
    case 'us':        return STOCK_UNIVERSE.us_large
    default:          return ALL_STOCKS
  }
}

type Bindings = { DB: D1Database }
const recommend = new Hono<{ Bindings: Bindings }>()

// ─── 헬퍼: 등급 색상 ──────────────────────────────────────────────────────────
function gradeColor(grade: string) {
  return { S: '#f59e0b', A: '#10b981', B: '#6366f1', C: '#f97316', D: '#ef4444' }[grade] || '#6b7280'
}

// ─── 추천 결과 DB 저장 ────────────────────────────────────────────────────────
async function saveRecommendation(db: D1Database, results: StockAnalysis[], type: string) {
  try {
    await db.prepare(`
      INSERT INTO recommend_history (type, results_json, created_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `).bind(type, JSON.stringify(results.slice(0, 10))).run()
  } catch { /* 테이블 없으면 무시 */ }
}

// ─── GET /api/recommend/short ─────────────────────────────────────────────────
// 단기 투자 종목 추천 (1개월~6개월)
recommend.get('/short', async (c) => {
  const market = c.req.query('market') || 'all'  // all | korea | us
  const limit  = Math.min(parseInt(c.req.query('limit') || '10'), 20)

  const pool = filterPool(market)

  try {
    const allResults = await screenStocks(pool, 5)

    // 단기 점수 기준 정렬 + D등급 제외
    const ranked = allResults
      .filter(r => r.shortTerm.grade !== 'D')
      .sort((a, b) => b.shortTerm.total - a.shortTerm.total)
      .slice(0, limit)

    // DB 저장
    await saveRecommendation(c.env.DB, ranked, 'short')

    return c.json({
      type: 'short',
      label: '단기 투자 추천 (1개월~6개월)',
      description: '기술적 지표(RSI·MACD·볼린저밴드) + 거래량 모멘텀 + 단기 가격 모멘텀 종합 분석',
      scanned: allResults.length,
      count: ranked.length,
      updatedAt: new Date().toISOString(),
      stocks: ranked.map(r => ({
        rank: ranked.indexOf(r) + 1,
        symbol: r.symbol,
        name: r.name,
        sector: r.sector,
        market: r.market,
        currentPrice: r.currentPrice,
        currency: r.currency,
        score: r.shortTerm.total,
        grade: r.shortTerm.grade,
        gradeColor: gradeColor(r.shortTerm.grade),
        details: r.shortTerm.details,
        reasons: r.shortTerm.reasons,
        risks: r.shortTerm.risks,
        momentum: r.momentum,
        position52w: r.position52w,
        volume: r.volume,
      })),
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── GET /api/recommend/long ──────────────────────────────────────────────────
// 장기 투자 종목 추천 (1년~5년+)
recommend.get('/long', async (c) => {
  const market = c.req.query('market') || 'all'
  const limit  = Math.min(parseInt(c.req.query('limit') || '10'), 20)

  const pool = filterPool(market)

  try {
    const allResults = await screenStocks(pool, 5)

    // 장기 점수 기준 정렬 + D등급 제외
    const ranked = allResults
      .filter(r => r.longTerm.grade !== 'D')
      .sort((a, b) => b.longTerm.total - a.longTerm.total)
      .slice(0, limit)

    await saveRecommendation(c.env.DB, ranked, 'long')

    return c.json({
      type: 'long',
      label: '장기 투자 추천 (1년~5년+)',
      description: '재무건전성(ROE·부채비율·이익률) + 성장성(매출·이익 성장) + 장기 모멘텀 + 밸류에이션(PER·PBR) 종합 분석',
      scanned: allResults.length,
      count: ranked.length,
      updatedAt: new Date().toISOString(),
      stocks: ranked.map(r => ({
        rank: ranked.indexOf(r) + 1,
        symbol: r.symbol,
        name: r.name,
        sector: r.sector,
        market: r.market,
        currentPrice: r.currentPrice,
        currency: r.currency,
        score: r.longTerm.total,
        grade: r.longTerm.grade,
        gradeColor: gradeColor(r.longTerm.grade),
        details: r.longTerm.details,
        reasons: r.longTerm.reasons,
        risks: r.longTerm.risks,
        financials: r.financials,
        momentum: r.momentum,
        position52w: r.position52w,
      })),
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── GET /api/recommend/single/:symbol ───────────────────────────────────────
// 특정 종목 단기+장기 동시 분석
recommend.get('/single/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  const stockInfo = ALL_STOCKS.find(s => s.symbol === symbol) || {
    symbol, name: symbol, sector: '기타', market: '기타'
  }
  try {
    const result = await analyzeStock(stockInfo)
    if (!result) return c.json({ error: '데이터를 가져올 수 없습니다' }, 404)
    return c.json({ stock: result })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

// ─── GET /api/recommend/history ───────────────────────────────────────────────
// 추천 기록 조회
recommend.get('/history', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, type, created_at,
        json_extract(results_json, '$[0].symbol') as top1_symbol,
        json_extract(results_json, '$[0].name')   as top1_name,
        json_extract(results_json, '$[0].score')  as top1_score
       FROM recommend_history ORDER BY created_at DESC LIMIT 20`
    ).all()
    return c.json({ history: results })
  } catch { return c.json({ history: [] }) }
})

// ─── POST /api/recommend/universe ────────────────────────────────────────────
// 커스텀 종목 리스트로 스크리닝
recommend.post('/universe', async (c) => {
  const body = await c.req.json() as any
  const symbols: string[] = body.symbols || []
  if (!symbols.length) return c.json({ error: '종목 코드를 입력하세요' }, 400)

  const stockList = symbols.slice(0, 30).map(sym => ({
    symbol: sym.toUpperCase(),
    name: sym,
    sector: '기타',
    market: '기타',
    ...( ALL_STOCKS.find(s => s.symbol === sym.toUpperCase()) || {} )
  }))

  try {
    const results = await screenStocks(stockList, 5)
    return c.json({
      scanned: results.length,
      stocks: results.map(r => ({
        symbol: r.symbol,
        name: r.name,
        shortScore: r.shortTerm.total,
        shortGrade: r.shortTerm.grade,
        longScore: r.longTerm.total,
        longGrade: r.longTerm.grade,
        shortReasons: r.shortTerm.reasons,
        longReasons:  r.longTerm.reasons,
      })).sort((a, b) => (b.shortScore + b.longScore) - (a.shortScore + a.longScore))
    })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

export default recommend

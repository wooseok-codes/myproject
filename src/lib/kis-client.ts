/**
 * 한국투자증권 API 클라이언트
 * 실계좌: https://openapi.koreainvestment.com:9443
 * 모의계좌: https://openapivts.koreainvestment.com:29443
 */

export interface KISConfig {
  appKey: string
  appSecret: string
  accountNo: string   // 계좌번호 (예: 50012345-01)
  mode: 'real' | 'mock'
}

export interface KISToken {
  access_token: string
  expires_in: number
  token_type: string
}

export interface StockQuote {
  symbol: string
  currentPrice: number
  change: number
  changePct: number
  volume: number
  high: number
  low: number
  open: number
}

export interface OrderResult {
  orderId: string
  symbol: string
  side: 'buy' | 'sell'
  quantity: number
  price: number
  status: string
}

const BASE_URL_REAL = 'https://openapi.koreainvestment.com:9443'
const BASE_URL_MOCK = 'https://openapivts.koreainvestment.com:29443'

export class KISClient {
  private config: KISConfig
  private baseUrl: string
  private accessToken: string | null = null
  private tokenExpiry: number = 0

  constructor(config: KISConfig) {
    this.config = config
    this.baseUrl = config.mode === 'real' ? BASE_URL_REAL : BASE_URL_MOCK
  }

  // ─── 토큰 발급 ─────────────────────────────────────────────────────────────
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken
    }

    const res = await fetch(`${this.baseUrl}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.config.appKey,
        appsecret: this.config.appSecret,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`KIS 토큰 발급 실패: ${res.status} - ${err}`)
    }

    const data: KISToken = await res.json() as KISToken
    this.accessToken = data.access_token
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
    return this.accessToken
  }

  private async getHeaders(trId: string): Promise<Record<string, string>> {
    const token = await this.getAccessToken()
    return {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${token}`,
      'appkey': this.config.appKey,
      'appsecret': this.config.appSecret,
      'tr_id': trId,
      'custtype': 'P',
    }
  }

  // ─── 현재가 조회 ───────────────────────────────────────────────────────────
  async getQuote(symbol: string): Promise<StockQuote> {
    // 한국 주식 6자리 코드 (KS 제거)
    const code = symbol.replace(/\.(KS|KQ)$/, '')
    const trId = 'FHKST01010100'
    const headers = await this.getHeaders(trId)

    const url = `${this.baseUrl}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`
    const res = await fetch(url, { headers })

    if (!res.ok) throw new Error(`현재가 조회 실패: ${res.status}`)
    const data: any = await res.json()

    if (data.rt_cd !== '0') throw new Error(`현재가 조회 오류: ${data.msg1}`)

    const o = data.output
    return {
      symbol,
      currentPrice: parseInt(o.stck_prpr),
      change: parseInt(o.prdy_vrss),
      changePct: parseFloat(o.prdy_ctrt),
      volume: parseInt(o.acml_vol),
      high: parseInt(o.stck_hgpr),
      low: parseInt(o.stck_lwpr),
      open: parseInt(o.stck_oprc),
    }
  }

  // ─── 잔고 조회 ─────────────────────────────────────────────────────────────
  async getBalance(): Promise<any> {
    const trId = this.config.mode === 'real' ? 'TTTC8434R' : 'VTTC8434R'
    const headers = await this.getHeaders(trId)

    const [acctNo, acctPrdtCd] = this.config.accountNo.split('-')
    const url = `${this.baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${acctNo}&ACNT_PRDT_CD=${acctPrdtCd || '01'}&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=01&CTX_AREA_FK100=&CTX_AREA_NK100=`
    const res = await fetch(url, { headers })

    if (!res.ok) throw new Error(`잔고 조회 실패: ${res.status}`)
    const data: any = await res.json()
    if (data.rt_cd !== '0') throw new Error(`잔고 조회 오류: ${data.msg1}`)

    return {
      cashBalance: parseInt(data.output2?.[0]?.dnca_tot_amt || '0'),
      totalEval: parseInt(data.output2?.[0]?.tot_evlu_amt || '0'),
      totalPnl: parseInt(data.output2?.[0]?.evlu_pfls_smtl_amt || '0'),
      holdings: (data.output1 || []).map((h: any) => ({
        symbol: h.pdno,
        name: h.prdt_name,
        quantity: parseInt(h.hldg_qty),
        avgPrice: parseInt(h.pchs_avg_pric),
        currentPrice: parseInt(h.prpr),
        evalAmount: parseInt(h.evlu_amt),
        pnl: parseInt(h.evlu_pfls_amt),
        pnlPct: parseFloat(h.evlu_pfls_rt),
      })),
    }
  }

  // ─── 주식 매수 ─────────────────────────────────────────────────────────────
  async buyOrder(symbol: string, quantity: number, price: number = 0): Promise<OrderResult> {
    const code = symbol.replace(/\.(KS|KQ)$/, '')
    // 실계좌: TTTC0802U, 모의계좌: VTTC0802U
    const trId = this.config.mode === 'real' ? 'TTTC0802U' : 'VTTC0802U'
    const headers = await this.getHeaders(trId)

    const [acctNo, acctPrdtCd] = this.config.accountNo.split('-')
    const body = {
      CANO: acctNo,
      ACNT_PRDT_CD: acctPrdtCd || '01',
      PDNO: code,
      ORD_DVSN: price === 0 ? '01' : '00',  // 01: 시장가, 00: 지정가
      ORD_QTY: String(quantity),
      ORD_UNPR: price === 0 ? '0' : String(price),
    }

    const res = await fetch(`${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) throw new Error(`매수 주문 실패: ${res.status}`)
    const data: any = await res.json()
    if (data.rt_cd !== '0') throw new Error(`매수 주문 오류: ${data.msg1}`)

    return {
      orderId: data.output?.odno || '',
      symbol,
      side: 'buy',
      quantity,
      price,
      status: 'filled',
    }
  }

  // ─── 주식 매도 ─────────────────────────────────────────────────────────────
  async sellOrder(symbol: string, quantity: number, price: number = 0): Promise<OrderResult> {
    const code = symbol.replace(/\.(KS|KQ)$/, '')
    // 실계좌: TTTC0801U, 모의계좌: VTTC0801U
    const trId = this.config.mode === 'real' ? 'TTTC0801U' : 'VTTC0801U'
    const headers = await this.getHeaders(trId)

    const [acctNo, acctPrdtCd] = this.config.accountNo.split('-')
    const body = {
      CANO: acctNo,
      ACNT_PRDT_CD: acctPrdtCd || '01',
      PDNO: code,
      ORD_DVSN: price === 0 ? '01' : '00',
      ORD_QTY: String(quantity),
      ORD_UNPR: price === 0 ? '0' : String(price),
    }

    const res = await fetch(`${this.baseUrl}/uapi/domestic-stock/v1/trading/order-cash`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) throw new Error(`매도 주문 실패: ${res.status}`)
    const data: any = await res.json()
    if (data.rt_cd !== '0') throw new Error(`매도 주문 오류: ${data.msg1}`)

    return {
      orderId: data.output?.odno || '',
      symbol,
      side: 'sell',
      quantity,
      price,
      status: 'filled',
    }
  }

  // ─── 주문 취소 ─────────────────────────────────────────────────────────────
  async cancelOrder(orderId: string, symbol: string, quantity: number): Promise<boolean> {
    const code = symbol.replace(/\.(KS|KQ)$/, '')
    const trId = this.config.mode === 'real' ? 'TTTC0803U' : 'VTTC0803U'
    const headers = await this.getHeaders(trId)

    const [acctNo, acctPrdtCd] = this.config.accountNo.split('-')
    const body = {
      CANO: acctNo,
      ACNT_PRDT_CD: acctPrdtCd || '01',
      KRX_FWDG_ORD_ORGNO: '',
      ORGN_ODNO: orderId,
      ORD_DVSN: '00',
      RVSE_CNCL_DVSN_CD: '02',  // 02: 취소
      ORD_QTY: String(quantity),
      ORD_UNPR: '0',
      QTY_ALL_ORD_YN: 'Y',
    }

    const res = await fetch(`${this.baseUrl}/uapi/domestic-stock/v1/trading/order-rvsecncl`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) return false
    const data: any = await res.json()
    return data.rt_cd === '0'
  }
}
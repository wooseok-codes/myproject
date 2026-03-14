/**
 * Slack 알림 클라이언트
 */

export interface SlackMessage {
  text?: string
  blocks?: any[]
  attachments?: any[]
}

export class SlackNotifier {
  private webhookUrl: string

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl
  }

  async send(message: SlackMessage): Promise<boolean> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      })
      return res.ok
    } catch {
      return false
    }
  }

  // ─── 주문 체결 알림 ────────────────────────────────────────────────────────
  async notifyOrder(params: {
    side: 'buy' | 'sell'
    symbol: string
    name: string
    price: number
    quantity: number
    amount: number
    mode: 'real' | 'mock'
    strategy: string
    reasons: string[]
    pnl?: number
    pnlPct?: number
  }): Promise<boolean> {
    const emoji = params.side === 'buy' ? '🟢' : '🔴'
    const sideKr = params.side === 'buy' ? '매수' : '매도'
    const modeKr = params.mode === 'real' ? '실계좌' : '모의계좌'
    const pnlText = params.pnl != null
      ? `\n💰 손익: ${params.pnl >= 0 ? '+' : ''}${params.pnl.toLocaleString('ko-KR')}원 (${params.pnlPct?.toFixed(2)}%)`
      : ''

    return this.send({
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: `${emoji} ${sideKr} 체결 알림 [${modeKr}]`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*종목*\n${params.name} (${params.symbol})` },
            { type: 'mrkdwn', text: `*전략*\n${params.strategy}` },
            { type: 'mrkdwn', text: `*가격*\n${params.price.toLocaleString('ko-KR')}원` },
            { type: 'mrkdwn', text: `*수량*\n${params.quantity}주` },
            { type: 'mrkdwn', text: `*금액*\n${params.amount.toLocaleString('ko-KR')}원` },
            { type: 'mrkdwn', text: `*시각*\n${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*신호 근거*\n${params.reasons.join('\n')}${pnlText}`,
          },
        },
        { type: 'divider' },
      ],
    })
  }

  // ─── 봇 상태 알림 ──────────────────────────────────────────────────────────
  async notifyBotStatus(params: {
    name: string
    symbol: string
    status: 'started' | 'stopped' | 'error'
    message?: string
  }): Promise<boolean> {
    const emoji = { started: '🚀', stopped: '⛔', error: '⚠️' }[params.status]
    const statusKr = { started: '시작', stopped: '중지', error: '오류' }[params.status]

    return this.send({
      text: `${emoji} 봇 *${params.name}* (${params.symbol}) ${statusKr}${params.message ? `: ${params.message}` : ''}`,
    })
  }

  // ─── 일일 리포트 알림 ──────────────────────────────────────────────────────
  async notifyDailyReport(params: {
    date: string
    totalTrades: number
    buyCount: number
    sellCount: number
    totalPnl: number
    winRate: number
    topSymbols: string[]
  }): Promise<boolean> {
    return this.send({
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `📊 일일 트레이딩 리포트 - ${params.date}` },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*총 거래*\n${params.totalTrades}건` },
            { type: 'mrkdwn', text: `*매수/매도*\n${params.buyCount} / ${params.sellCount}` },
            { type: 'mrkdwn', text: `*총 손익*\n${params.totalPnl >= 0 ? '+' : ''}${params.totalPnl.toLocaleString('ko-KR')}원` },
            { type: 'mrkdwn', text: `*승률*\n${params.winRate.toFixed(1)}%` },
          ],
        },
      ],
    })
  }
}
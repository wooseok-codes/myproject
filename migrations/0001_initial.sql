-- 봇 설정 테이블
CREATE TABLE IF NOT EXISTS bot_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'mock',        -- 'real' | 'mock'
  strategy TEXT NOT NULL DEFAULT 'rsi',     -- 'rsi' | 'macd' | 'bb' | 'combined'
  enabled INTEGER NOT NULL DEFAULT 0,
  buy_amount INTEGER NOT NULL DEFAULT 100000,
  stop_loss_pct REAL NOT NULL DEFAULT 5.0,
  take_profit_pct REAL NOT NULL DEFAULT 10.0,
  rsi_oversold REAL NOT NULL DEFAULT 30,
  rsi_overbought REAL NOT NULL DEFAULT 70,
  slack_notify INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 거래 내역 테이블
CREATE TABLE IF NOT EXISTS trade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_config_id INTEGER,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,              -- 'buy' | 'sell'
  price REAL NOT NULL,
  quantity INTEGER NOT NULL,
  amount REAL NOT NULL,
  mode TEXT NOT NULL DEFAULT 'mock',
  strategy TEXT,
  signal_score INTEGER,
  order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'filled' | 'failed'
  pnl REAL,
  pnl_pct REAL,
  note TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_config_id) REFERENCES bot_configs(id)
);

-- 백테스팅 결과 테이블
CREATE TABLE IF NOT EXISTS backtest_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  initial_capital REAL NOT NULL,
  final_capital REAL NOT NULL,
  total_return_pct REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  win_rate REAL NOT NULL,
  total_trades INTEGER NOT NULL,
  sharpe_ratio REAL,
  params TEXT,                     -- JSON 파라미터
  trades TEXT,                     -- JSON 거래 배열
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- API 설정 테이블 (암호화 없이 저장 - 실제 운영시 Cloudflare Secrets 사용)
CREATE TABLE IF NOT EXISTS api_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,   -- 'kis_real' | 'kis_mock' | 'slack'
  app_key TEXT,
  app_secret TEXT,
  account_no TEXT,
  webhook_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trade_history_symbol ON trade_history(symbol);
CREATE INDEX IF NOT EXISTS idx_trade_history_created ON trade_history(created_at);
CREATE INDEX IF NOT EXISTS idx_backtest_symbol ON backtest_results(symbol);
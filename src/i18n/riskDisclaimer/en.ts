import type { RiskDisclaimerPageTranslations } from './types'

export const riskDisclaimerEn: RiskDisclaimerPageTranslations = {
  title: 'Risk disclaimer',
  intro:
    'Trading foreign exchange, CFDs, and other leveraged products involves substantial risk of loss. TScopier is a trade-copying tool — not a broker, investment adviser, or financial planner. Nothing on this page is financial advice. You are solely responsible for your trading decisions and any losses.',
  sections: [
    {
      title: 'General trading risk',
      paragraphs: [
        'You can lose some or all of your deposited capital. Leverage magnifies both gains and losses. Past performance of a signal provider, backtest, or your own history does not guarantee future results.',
        'Markets can gap, halt, or move violently during news events. TScopier does not guarantee that signals will be received, parsed, or executed at any particular price or time.',
      ],
    },
    {
      title: 'Signal provider risk',
      paragraphs: [
        'Only copy signal providers you trust and understand. Providers may have incentives that conflict with your interests. Marketing screenshots, win-rate claims, and curated results may not reflect what you will experience on your account, lot size, broker, or latency.',
        'Verify performance independently where possible. A provider that works for others may still be unsuitable for your risk tolerance, account size, or trading hours.',
      ],
    },
    {
      title: 'Repainting and channel deception',
      paragraphs: [
        'Some Telegram signal channels edit or delete messages after a trade goes wrong so the public feed looks flawless. A “successful” call may have been revised; a losing call may disappear entirely.',
        'Do not rely only on a channel’s visible history or third-party screenshots. Compare against your own Copier Logs, broker statements, and timestamped records. Repainting makes it easy for providers to appear more accurate than they really are.',
      ],
    },
    {
      title: 'Parsing and execution limitations',
      paragraphs: [
        'Signals are interpreted automatically from text. Typos in stop loss (SL) or take profit (TP) — wrong digits, missing decimals, ambiguous symbols, or mixed units — can produce invalid prices. TScopier may skip the signal, ignore invalid levels, or apply defaults from your configuration instead of the provider’s intent.',
        'Execution can differ from the provider’s entry: slippage, requotes, partial fills, minimum distance rules, and broker session disconnects all affect outcomes. Strict entry, range pending, and multi-leg styles add further complexity. Always review open positions at your broker.',
      ],
    },
    {
      title: 'Operational and configuration risks',
      paragraphs: [
        'News blackouts, channel filters, profit targets, maximum loss limits, subscription status, and per-channel settings can block or alter copying. Misconfigured lot sizing, symbol mappings, or unlinked channels are common reasons trades do not copy as expected.',
        'Automatic flattening when limits are hit closes channel-attributed trades on TScopier’s side but cannot undo market loss already incurred. Configuration changes take effect after save — unsaved drafts do not protect your account.',
      ],
    },
    {
      title: 'Stay involved while copying',
      paragraphs: [
        'Automated copying is not “set and forget.” Monitor open trades, equity, margin, and Copier Logs regularly. Intervene at your broker when conditions change or when you no longer agree with a provider’s exposure.',
        'If you cannot actively supervise your account, copying live signals may be inappropriate for you.',
      ],
    },
    {
      title: 'Improving your chances (not advice)',
      paragraphs: [
        'Start with a demo account or the smallest live size you can afford to lose. Vet channels over time; use backtests where available; enable maximum loss and profit targets; tune channel filters; diversify across providers rather than concentrating risk.',
        'Read skip reasons in Copier Logs when signals do not trade. Keep realistic expectations — consistent small edges with strict risk control are very different from “get rich quick” marketing.',
      ],
    },
  ],
  closing:
    'By using TScopier you acknowledge that trading is risky, that signal providers may be unreliable or misleading, and that you accept full responsibility for all trades placed on your linked accounts.',
}

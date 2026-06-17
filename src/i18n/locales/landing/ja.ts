import { testimonialsJa } from '../../testimonials/ja'
import type { LandingTranslations } from './types'

export const landingJa: LandingTranslations = {
  nav: {
    product: '製品',
    features: '機能',
    pricing: '料金',
    faq: 'FAQ',
    docs: 'ドキュメント',
    signIn: 'ログイン',
    getStarted: '無料で始める',
    dashboard: 'ダッシュボード',
    menuOpen: 'メニューを開く',
    menuClose: 'メニューを閉じる',
  },
  hero: {
    trustedBy: '156か国・30,000人以上のトレーダーが利用中',
    avatarAlts: ['TScopierトレーダー', 'TScopierトレーダー', 'TScopierトレーダー'],
    headline: 'Telegramシグナルをライブ取引へ、',
    headlineAccent: '100%自動化。',
    subheadline:
      'シグナル配信者の指示をMT4/MT5へ2分以内でコピー。複雑な設定・EA・VPSは不要です。',
    primaryCta: '無料で試す',
    secondaryCta: 'ログイン',
    imageAlt: '残高、当日損益、取引結果、口座成長チャートを表示したTScopierダッシュボード',
    previewUrl: 'app.tscopier.ai/dashboard',
    dashboard: {
      headlineStats: [
        {
          key: 'totalBalance',
          value: '$54,650.00',
          live: { from: 48120, cap: 54650, stepMin: 14, stepMax: 52 },
          sub: '5つの接続口座の合計',
          valueTone: 'neutral',
        },
        {
          key: 'todaysProfit',
          value: '+$542.50',
          sub: '昨日比 +$712',
          valueTone: 'good',
          showHint: true,
        },
        {
          key: 'tradesTakenToday',
          value: '12',
          sub: '8勝・4敗',
          valueTone: 'neutral',
        },
        {
          key: 'openPnl',
          value: '+$134.80',
          live: { from: 102.3, cap: 134.8, stepMin: 0.25, stepMax: 1.75, signed: true },
          sub: '2口座からの損益',
          valueTone: 'good',
        },
      ],
      overviewStats: [
        { key: 'activeSignalChannels', value: '4', showAdd: true },
        { key: 'openTrades', value: '16' },
        { key: 'tradingAccountsConnected', value: '3', showAdd: true },
        { key: 'tradesCopiedToday', value: '3' },
      ],
      channelWorkerLogs: [
        {
          message: 'Gold Signals Pro チャンネル・リスナー接続済み',
          time: '5月22日 09:36',
        },
        {
          message: 'Gold Signals Pro から BUY XAUUSD・TP 2件を解析',
          time: '5月22日 09:37',
        },
        {
          message: 'MT5・口座 #88291 へ注文を送信',
          time: '5月22日 09:37',
        },
      ],
      copierLogRows: [
        {
          status: 'executed',
          channel: 'Gold Signals Pro',
          symbol: 'XAUUSD',
          type: 'buy',
          side: 'buy',
          time: '5月22日 09:37',
        },
        {
          status: 'parsed',
          channel: 'FX Scalper VIP',
          symbol: 'EURUSD',
          type: 'sell',
          side: 'sell',
          time: '5月22日 09:35',
        },
        {
          status: 'executed',
          channel: 'Indices Daily',
          symbol: 'NAS100',
          type: 'buy',
          side: 'buy',
          time: '5月22日 09:31',
        },
      ],
    },
  },
  whyChoose: {
    eyebrow: '賢いコピーは、賢いツールから',
    title: 'TScopierのすべての機能は、コントロール・可視性・成果のために設計されています。',
    cards: [
      {
        label: '約定スピード',
        metric: '<150ms',
        metricVariant: 'teal',
        description: 'シグナル解析からブローカー送信まで、クラウド基盤で150ms未満の低遅延。',
        layout: 'tall',
        icon: 'zap',
      },
      {
        label: 'クラウド基盤',
        metric: '100%',
        metricVariant: 'teal',
        description: '100%クラウド型。ダウンロード不要、ターミナルへのEA不要、VPS不要。EAの可否に関わらずすべてのプロップファームで利用可能。',
        layout: 'short',
        icon: 'cloud',
      },
      {
        label: 'ブローカースケール',
        metric: '100',
        metricVariant: 'neutral',
        description: '1ユーザーあたり最大100件のMT5/MT4接続に対応。',
        layout: 'short',
        icon: 'link',
      },
      {
        label: '運用体制',
        metric: '24/7',
        metricVariant: 'teal',
        description: '24時間365日稼働。ローカルPCを監視し続ける必要はありません。',
        layout: 'short',
        icon: 'clock',
      },
      {
        label: 'コピーエンジン',
        metric: 'Advanced',
        metricVariant: 'teal',
        description: 'テンプレート、フィルター、バックテスト、チャンネル別ルールを1つのエンジンに集約。',
        layout: 'featured',
        icon: 'settings',
      },
      {
        label: '信頼性',
        metric: '99.99%',
        metricVariant: 'teal',
        description: '99.99%の稼働率で、相場が動く瞬間もコピーを止めません。',
        layout: 'short',
        icon: 'activity',
      },
      {
        label: 'リスク制御',
        metric: 'Layering',
        metricVariant: 'neutral',
        description: 'レンジ戦略や複数TPシグナルに対し、レイヤリングと不利ポジション優先決済に対応。',
        layout: 'tall',
        icon: 'layers',
      },
      {
        label: '取引モード',
        metric: 'Single & Range',
        metricVariant: 'neutral',
        description: 'Single/Rangeの両モードを、統一されたロットルールと管理指示で実行可能。',
        layout: 'short',
        icon: 'chart',
      },
      {
        label: '多言語',
        metric: 'シグナル',
        metricVariant: 'teal',
        description: '英語・スペイン語・ロシア語・ポーランド語など、各言語のチャンネルから売買・SL・TPを解析。',
        layout: 'tall',
        icon: 'messages',
      },
      {
        label: 'バックテスト',
        metric: 'Replay',
        metricVariant: 'teal',
        description: '実運用前にチャンネル履歴をあなたのルールで再生し、結果を確認できます。',
        layout: 'short',
        icon: 'history',
      },
    ],
  },
  features: {
    eyebrow: 'プラットフォーム機能',
    title: '本気のシグナルコピーのために設計',
    subtitle:
      'Telegram取引を自動化しながらコントロールを維持。アプリ内と同じフローで運用できます。',
    showcases: [
      {
        eyebrow: 'シグナルコピー',
        title: 'TelegramシグナルをMT4/MT5へ高精度コピー',
        description:
          '信頼するチャンネルをあなたのブローカー口座へ反映。TScopierはエントリー、TP、レンジレッグ、管理指示を解析し、ロットルール・複数分割・レイヤリングを各接続口座へ適用します。',
        visual: 'copier',
      },
      {
        eyebrow: '多言語シグナル',
        title: '複数言語のシグナルに対応',
        description:
          '英語・スペイン語・フランス語・ロシア語・ポーランド語・日本語など、さまざまな言語で配信されるチャンネルをコピー。TScopierは各言語の売買・SL・TP・管理フレーズを認識し、チャンネルごとの学習で配信者固有の表現にも対応します。',
        visual: 'multilingual',
      },
      {
        eyebrow: 'チャンネル制御',
        title: 'チャンネルごとのフィルターとキーワードルール',
        description:
          'クローズ、ブレークイーブン、SL/TP調整などの指示タイプをチャンネル単位で許可・遮断。必要なシグナルだけをブローカーへ送れます。',
        visual: 'filters',
      },
      {
        eyebrow: 'メッセージ編集',
        title: '編集済みメッセージにも追従してシグナル更新',
        description:
          '配信者がTelegramメッセージを編集してSL/TPを変更した場合でも、TScopierが差分を検知し、既存ポジションを更新。新規建て増しはせず、全レッグのSL/TPのみ同期します。',
        visual: 'signalEdit',
      },
      {
        eyebrow: 'バックテスト',
        title: '本番前にチャンネル履歴を再生',
        description:
          '過去シグナルをあなたの手動設定で再実行し、コピー結果を事前に検証。解析精度やロットロジックを資金リスクなしで確認できます。',
        visual: 'backtest',
      },
      {
        eyebrow: 'コピー履歴',
        title: 'すべての実行を透明化',
        description:
          'ワーカーが何を解析し、どう計画し、どこへ送信したかをミリ秒単位で確認。チャンネルの検証や約定確認をリアルタイムで行えます。',
        visual: 'logs',
      },
      {
        eyebrow: 'マーケットツール',
        title: 'ニュースと経済カレンダーを標準搭載',
        description:
          '高インパクトイベントと主要ニュースを同一ダッシュボードで監視。ニュース時間帯のコピー停止もルール化できます。',
        visual: 'news',
      },
    ],
    visuals: {
      copier: {
        telegramLabel: 'シグナルチャンネル',
        channelName: 'Gold Signals Pro',
        channelMeta: '新規シグナル 3件・たった今',
        hubLabel: 'TScopier',
        mt4Label: 'MT4口座',
        mt4Meta: 'コピー中・0.10ロットルール',
        mt5Label: 'MT5口座',
        mt5Meta: 'コピー中・複数TP分割',
        pillLayering: 'レンジレイヤリング',
        pillLots: 'ロット設定',
        pillChannels: 'ライブチャンネル',
      },
      filters: {
        allowLabel: '許可',
        ignoreLabel: '無視',
        rules: [
          {
            label: '全ポジションを決済',
            example: '例: "close", "exit trade", "flatten"',
            decision: 'allow',
          },
          {
            label: 'ブレークイーブン',
            example: '例: "move SL to entry", "BE now"',
            decision: 'allow',
          },
          {
            label: 'TP調整',
            example: '例: "change TP to 4600"',
            decision: 'allow',
          },
          {
            label: 'すべてのオープントレードを決済',
            example: '例: "close all", "flatten all"',
            decision: 'allow',
          },
          {
            label: '未約定注文をキャンセル',
            example: '例: "cancel limit", "delete pending"',
            decision: 'allow',
          },
        ],
      },
      multilingual: {
        languagesBadge: '10以上の言語',
        moreLanguages: 'ドイツ語・アラビア語・ポルトガル語・イタリア語ほか',
        parsedLabel: '解析済み',
        ribbonFlags: ['us', 'gb', 'es', 'fr', 'pl', 'ru', 'se', 'nl', 'jp'],
        signals: [
          {
            flagId: 'us',
            language: 'English',
            message: 'BUY XAUUSD now · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'es',
            language: 'Español',
            message: 'COMPRA XAUUSD ahora · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'fr',
            language: 'Français',
            message: 'ACHAT XAUUSD immédiat · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'ru',
            language: 'Русский',
            message: 'ПОКУПКА XAUUSD сейчас · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
          {
            flagId: 'ja',
            language: '日本語',
            message: 'XAUUSD 買い 成行 · SL 2640 · TP 2670',
            parsedAction: 'BUY XAUUSD',
            side: 'buy',
          },
        ],
      },
      signalEdit: {
        channelName: 'Gold Signals Pro',
        channelMeta: 'Telegram・メッセージ編集済み',
        editedLabel: '編集済み',
        messageBuy: 'BUY XAUUSD',
        beforeLabel: '変更前',
        beforeSl: 'SL 4190',
        beforeTp: 'TP1 4220',
        afterLabel: '変更後',
        afterSl: 'SL 4175',
        afterTp: 'TP1 4230 · TP2 4240',
        workerTitle: 'チャンネルワーカー',
        workerMessage: 'XAUUSDのオープン7レッグのSL/TPを更新（新規注文は未実行）',
        workerTime: 'たった今',
      },
      backtest: {
        resultsTitle: 'バックテスト結果',
        resultsSubtitle: 'XAUUSD · チャンネル',
        newRunLabel: '新規実行',
        totalPipsLabel: '総獲得pips',
        totalPips: '+544.0p',
        winRateLabel: '勝率',
        winRate: '67%',
        winLossLabel: '勝 / 負',
        winLoss: '16/8',
        signalsLabel: 'シグナル',
        signalsCount: '24',
        signalsListLabel: '24シグナル',
        signals: [
          {
            symbol: 'XAUUSD',
            side: 'sell',
            timestamp: '2026-05-18 09:37',
            outcome: '全TP達成',
            pips: '+62.0p',
            pipsTone: 'good',
            duration: '23分',
          },
          {
            symbol: 'EURUSD',
            side: 'buy',
            timestamp: '2026-05-17 14:22',
            outcome: 'SL到達',
            pips: '-18.0p',
            pipsTone: 'bad',
            duration: '1時間12分',
          },
          {
            symbol: 'NAS100',
            side: 'sell',
            timestamp: '2026-05-16 11:05',
            outcome: '部分利確',
            pips: '+24.5p',
            pipsTone: 'good',
            duration: '45分',
          },
        ],
      },
      logs: {
        rows: [
          { symbol: 'XAUUSD', type: 'close', time: '5月22日 19:50' },
          { symbol: 'XAUUSD', type: 'sell', time: '5月22日 19:50' },
          { symbol: 'XAUUSD', type: 'breakeven', time: '5月22日 19:50' },
          { symbol: 'XAUUSD', type: 'buy', time: '5月22日 19:49' },
          { symbol: 'XAUUSD', type: 'partial_profit', time: '5月22日 19:49' },
          { symbol: 'XAUUSD', type: 'modify', time: '5月22日 19:48' },
          { symbol: 'XAUUSD', type: 'partial_breakeven', time: '5月22日 19:48' },
        ],
      },
      news: {
        dayHeading: '5月21日（木）',
        events: [
          {
            time: '01:00',
            currency: 'JPY',
            name: 'インフレ率（前年比・4月）',
            impact: 'high',
            actual: '1.40%',
            forecast: '1.80%',
            previous: '2.00%',
            actualTone: 'bad',
          },
          {
            time: '01:30',
            currency: 'JPY',
            name: '日銀 政策金利発表',
            impact: 'high',
            actual: '0.50%',
            forecast: '0.50%',
            previous: '0.25%',
            actualTone: 'neutral',
          },
          {
            time: '08:30',
            currency: 'USD',
            name: '新規失業保険申請件数',
            impact: 'high',
            actual: '228K',
            forecast: '230K',
            previous: '224K',
            actualTone: 'good',
          },
          {
            time: '09:30',
            currency: 'GBP',
            name: 'S&Pグローバル製造業PMI（5月）',
            impact: 'high',
            actual: '51.2',
            forecast: '50.8',
            previous: '50.3',
            actualTone: 'good',
          },
        ],
        articles: [
          {
            headline: '金（XAUUSD）・銀・プラチナ見通し：トレーダーの警戒感で金は反落...',
            source: 'fxempire.com',
            relativeTime: '10時間前',
          },
          {
            headline: 'EUR/USD：ユーロ買いが1.10を上抜くにはドル安が必要',
            source: 'fxstreet.com',
            relativeTime: '12時間前',
          },
          {
            headline: 'USD/JPYは高値圏を維持、NFP前に金利差拡大',
            source: 'investing.com',
            relativeTime: '14時間前',
          },
        ],
      },
    },
  },
  steps: {
    eyebrow: '利用開始',
    title: '仕組み',
    subtitle: 'Telegramチャンネルからブローカー約定まで、アプリと同じ画面で3ステップ。',
    items: [
      {
        title: 'Telegramを接続',
        description:
          'Telegramアカウントを連携し、シグナルチャンネルを選択。コピー先となるMT4/MT5口座を紐づけます。',
        visual: 'telegram',
      },
      {
        title: 'ブローカー設定',
        description: 'ロットサイズ、TP分割、レンジルール、チャンネル別許可/無視フィルターを設定。',
        visual: 'configure',
      },
      {
        title: 'シグナルをコピー',
        description:
          'チャンネルワーカーが各メッセージを解析し、コピー実行はダッシュボードのログでリアルタイム確認できます。',
        visual: 'copy',
      },
    ],
    visuals: {
      telegram: {
        channels: [
          {
            name: 'Gold Signals Pro',
            username: 'goldsignalspro',
            active: true,
            brokers: ['MT5 · #88291'],
          },
          {
            name: 'FX Scalper VIP',
            username: 'fxscalpervip',
            active: true,
            brokers: ['MT4 · #44102'],
          },
        ],
      },
      configure: {
        accountName: 'IC Markets · MT5',
        login: 'Login #88291',
        lotSize: '0.10',
        rangeLabel: 'レンジレイヤリング',
        rangeValue: '50% · 3 pips',
        tpRows: [
          { label: 'TP1', percent: '50%' },
          { label: 'TP2', percent: '30%' },
          { label: 'TP3', percent: '20%' },
        ],
        filters: [
          { label: 'クローズシグナル', decision: 'allow' },
          { label: 'SL / TP 変更', decision: 'allow' },
          { label: 'ブレークイーブン移動', decision: 'allow' },
        ],
      },
      copy: {
        workerLogs: [
          {
            message: 'Gold Signals Pro から BUY XAUUSD・TP 2件を解析',
            time: '5月22日 09:37',
          },
          {
            message: '0.10ロットをMT5・口座 #88291 へ送信',
            time: '5月22日 09:37',
          },
        ],
        logRows: [
          { symbol: 'XAUUSD', type: 'buy', time: '09:37' },
          { symbol: 'XAUUSD', type: 'sell', time: '09:35' },
        ],
      },
    },
  },
  faq: {
    eyebrow: 'FAQ',
    title: 'よくある質問',
    subtitle: 'セットアップ、コピー実行、TScopierの違いをすぐに確認できます。',
    items: [
      {
        question: 'EAのインストールやVPS運用は必要ですか？',
        answer:
          '不要です。TScopierは完全クラウド型。ブラウザでログインし、TelegramとMT4/MT5を接続するだけで、コピー処理は当社インフラ上で稼働します。',
      },
      {
        question: 'EAを禁止しているプロップファームでも使えますか？',
        answer:
          'はい。TScopierは完全にクラウドで動作し、MT4/MT5ターミナルには何もインストールしません。EAの可否に関わらず、あらゆるプロップファーム口座へシグナルをコピーできます。',
      },
      {
        question: 'TScopierはどのプラットフォームに対応していますか？',
        answer:
          'Telegramシグナルチャンネルを接続し、MetaTrader 4 / MetaTrader 5へコピーできます。複数ブローカーを接続し、チャンネルごとに送信先口座を指定可能です。',
      },
      {
        question: 'コピー速度はどれくらいですか？',
        answer:
          '低遅延パイプラインにより、通常はシグナル解析からブローカー送信まで150ms未満。エントリー、修正、クローズを価格優位性のあるタイミングで届けます。',
      },
      {
        question: '口座はいくつ接続できますか？',
        answer:
          'プランに応じて、1ユーザーあたり最大100件のMT4/MT5接続が可能です。Telegramチャンネルごとに、1つ以上のブローカー口座へ接続できます。',
      },
      {
        question: 'TScopierは個人のTelegramメッセージを読みますか？',
        answer:
          '読みません。Telegram接続で許可されるのは、あなたが参加しているチャンネル・グループのシグナル受信のみです。個人チャットは対象外です。',
      },
      {
        question: '本番前にチャンネルをテストできますか？',
        answer:
          'はい。Backtestで過去シグナルを再生し、ロットルール、TP分割、レンジ設定、フィルター条件で検証してからライブコピーへ進めます。',
      },
      {
        question: 'レンジ取引、レイヤリング、管理シグナルに対応していますか？',
        answer:
          '対応しています。Single/Rangeエントリー、複数TP分割、レイヤリング、不利ポジション優先決済、ブレークイーブン、部分利確などをチャンネル別ルールで制御できます。',
      },
      {
        question: 'BasicとAdvancedの違いは？',
        answer:
          'Basicは1口座での基本コピー、バックテスト、主要フィルターを提供。Advancedは複数口座コピー、レンジレイヤリング、自動管理機能、無制限Telegramチャンネルまで対応します。',
      },
    ],
  },
  reviews: {
    title: 'トレーダーの声',
    trustpilotLabel: 'Trustpilot',
    items: testimonialsJa,
  },
  comparison: {
    eyebrow: '乗り換えが進む理由',
    title: 'TScopierで次のレベルへ',
    subtitle: '一般的なTelegram copierと、速度・可視性・拡張性を重視したクラウド基盤を比較。',
    otherLabel: '他社copier',
    tscopierLabel: 'TScopier',
    cta: '無料で開始',
    rows: [
      {
        aspect: 'セットアップ',
        other: '導入が難しく、稼働開始まで手厚いサポートが必要になりがち。',
        tscopier: 'ブラウザでガイド付きオンボーディング。多くのユーザーが約2分でコピー開始。',
      },
      {
        aspect: 'ダッシュボード',
        other: '情報過多で、重要指標が埋もれやすい。',
        tscopier: 'チャンネル、実行状況、口座健全性に集中した見やすいUI。',
      },
      {
        aspect: '設定性',
        other: '設定項目が多すぎて誤設定しやすい。',
        tscopier: 'スマートな初期設定に加え、必要時のみ深いチャンネル別制御。',
      },
      {
        aspect: 'インフラ',
        other: 'EA常時稼働のためVPSが必須。',
        tscopier: '100%クラウド。ダウンロード不要、EA不要、VPS不要。',
      },
      {
        aspect: 'プロップファーム',
        other:
          '多くのコピーアプリはターミナル上のEAに依存—自動売買を禁止するプロップファームでは使えません。',
        tscopier:
          '口座にEAを置かないクラウド実行—EAの可否に関わらずすべてのプロップファームで利用可能。',
      },
      {
        aspect: '実行速度',
        other: 'Telegram受信後の約定が遅い。',
        tscopier: '解析からブローカー送信まで150ms未満の高速パイプライン。',
      },
      {
        aspect: '口座上限',
        other: '3〜4口座程度に制限されることが多い。',
        tscopier: '1ユーザー最大100件のMT4/MT5接続。',
      },
      {
        aspect: '料金体系',
        other: '複雑な階層・追加課金・隠れ制限が発生しやすい。',
        tscopier: '主要機能込みのシンプルで分かりやすいプラン。',
      },
      {
        aspect: '取引管理',
        other: '修正・部分決済・クローズで手動対応が残る。',
        tscopier: 'エントリー、レイヤリング、SL/TP調整、管理シグナルまで自動化。',
      },
      {
        aspect: '統合性',
        other: '主要機能が別製品や上位課金に分かれがち。',
        tscopier: 'コピー、バックテスト、ログ、ニュース、カレンダーを1契約で提供。',
      },
      {
        aspect: '取引マージ',
        other:
          '"Gold buy now"で新規、次にSL/TP付き"Gold buy now"でも再度新規。重複建玉や手動修正が発生。',
        tscopier:
          '"Gold buy now"で建てたポジションに対し、次メッセージのSL/TPは既存建玉を更新。重複新規は行いません。',
      },
      {
        aspect: '編集メッセージ',
        other: 'Telegram編集メッセージを無視し、SL/TP更新漏れが起きやすい。',
        tscopier: '編集メッセージからの更新を反映し、オープンバスケット全体のSL/TPを同期。',
      },
      {
        aspect: 'バックテスト',
        other: 'ルールに基づく履歴再生が弱い、または未対応。',
        tscopier: '本番前に実際のコピー設定で過去シグナルを検証可能。',
      },
    ],
  },
  pricing: {
    title: 'プランを選択',
    subtitle: '今日からあなたの取引口座へシグナルコピーを始めましょう。',
  },
  planComparison: {
    eyebrow: 'プラン比較',
    title: '最適なプランを見つける',
    subtitle: '各プランの内容を横並びで比較できます。',
    basicColumn: 'Basic',
    advancedColumn: 'Advanced',
    customColumn: 'Custom',
    rows: [
      {
        feature: 'ブローカー口座',
        basic: '1',
        advanced: '5（最大100）',
        custom: 'Custom',
      },
      {
        feature: 'シグナルバックテスト',
        basic: '月5回',
        advanced: '無制限',
        custom: 'Custom',
      },
      {
        feature: 'Telegramチャンネル',
        basic: '5',
        advanced: '無制限',
        custom: 'Custom',
      },
      {
        feature: 'Take-profitレベル',
        basic: 'TP 3件',
        advanced: 'TP/SL 無制限',
        custom: 'Custom',
      },
      {
        feature: 'レンジ取引 & レイヤリング',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: '自動ブレークイーブン & 管理',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: 'チャンネルキーワード追従',
        basic: 'no',
        advanced: 'yes',
        custom: 'yes',
      },
      {
        feature: '優先サポート',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: '専用オンボーディング',
        basic: 'no',
        advanced: 'no',
        custom: 'yes',
      },
      {
        feature: '無料トライアル',
        basic: 'no',
        advanced: '10日間',
        custom: 'Custom',
      },
      {
        feature: '開始価格',
        basic: '$9.99 / 月',
        advanced: '$39.99 / 月',
        custom: 'お問い合わせ',
      },
    ],
  },
  pricingFaq: {
    eyebrow: '料金FAQ',
    title: '料金に関する質問',
    subtitle: '請求、トライアル、プラン変更についてわかりやすく説明します。',
    items: [
      {
        question: '無料トライアルはありますか？',
        answer:
          'Advancedには申込時に10日間の無料トライアルが含まれます。Basicは初日から$9.99/月（年払いは$95.90/年）で課金されます。ダッシュボードの閲覧は可能ですが、ライブコピーには有効なプランが必要です。',
      },
      {
        question: '月払いと年払いの違いは？',
        answer:
          '年払いは年間トータルで月払いより20%お得です。Basicは$9.99/月から実質$7.99/月（$95.90/年）、Advancedは$39.99/月から実質$31.99/月（$383.90/年）になります。Advancedの追加口座も年払い割引が適用されます。',
      },
      {
        question: 'Advancedの追加口座はどう機能しますか？',
        answer:
          'Advancedにはデモ/ライブ口座が5件含まれます。さらに最大95件を$10/口座/月（年払いは$96/口座/年）で追加可能。1ユーザーあたり最大100口座まで接続できます。',
      },
      {
        question: '後からプラン変更できますか？',
        answer:
          'はい。ダッシュボードのBillingからいつでもアップグレード/ダウングレードできます。変更は請求サイクルに従って反映され、Stripeが日割り計算を処理します。',
      },
      {
        question: '利用できる支払い方法は？',
        answer:
          'Stripe経由で主要なクレジットカード/デビットカードをご利用いただけます。請求書と支払い履歴はBillingページからダウンロード可能です。',
      },
      {
        question: 'Customはどんなときに選ぶべきですか？',
        answer:
          'Customは、プロップファーム、トレーディングチーム、大量運用者向けに、口座上限・請求・導入支援を業務に合わせて最適化したい場合に最適です。',
      },
      {
        question: 'いつでも解約できますか？',
        answer:
          'はい。BillingまたはStripeカスタマーポータルから解約できます。現在の請求期間終了までは利用可能で、Basic/Advancedに長期契約の縛りはありません。',
      },
    ],
  },
  pricingSocialProof: {
    banner: '本日 {count} 人のトレーダーが購入',
    purchaseToast: '{country} のトレーダーが {plan} サブスクリプションを購入しました。',
    timeAgoJustNow: 'たった今',
    timeAgoOneMinute: '1分前',
  },
  pricingSnippet: {
    basic: 'Basic — $9.99/月',
    advanced: 'Advanced — 10日間無料、その後 $39.99/月',
  },
  footer: {
    cta: {
      title: '手動作業なしでシグナルコピーを始めませんか？',
      subtitle: 'Telegramを接続し、MT4またはMT5を紐づけるだけ。数分でコピー運用を開始できます。',
      primary: '無料で試す',
      secondary: 'ログイン',
    },
    tagline: 'MetaTrader口座向けの超高速Telegramシグナルcopier。',
    columns: {
      product: '製品',
      resources: 'リソース',
      account: 'アカウント',
    },
    links: {
      overview: '概要',
      features: '機能',
      pricing: '料金',
      howItWorks: '仕組み',
      faq: 'FAQ',
      docs: 'ドキュメント',
      status: 'システムステータス',
      telegram: 'Telegramサポート',
      riskDisclaimer: 'リスク免責',
      termsOfService: '利用規約',
      privacyPolicy: 'プライバシーポリシー',
      cookiePolicy: 'Cookieポリシー',
      signIn: 'ログイン',
      signUp: 'アカウント作成',
      openApp: 'ダッシュボードを開く',
    },
    platforms: '対応プラットフォーム',
    copyright: '© {year} Tartarix Inc. All rights reserved.',
    disclaimer: '取引にはリスクがあります。TScopierはコピー支援ツールであり、投資助言ではありません。',
  },
}

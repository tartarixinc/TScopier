import type { LegalDocumentPageTranslations } from './types'
import { legalContactJa } from './contactJa'

export const cookiePolicyJa: LegalDocumentPageTranslations = {
  title: 'Cookieポリシー',
  lastUpdated: '最終更新日: 2026年6月8日',
  intro:
    '本Cookieポリシーは、Tartarix, Inc.（以下「当社」）が TSCopier のウェブサイトおよびアプリケーションにおいて、Cookieおよび類似技術をどのように利用するかを説明するものです。本ポリシーは当社のプライバシーポリシーと併せてお読みください。',
  sections: [
    {
      title: '1. Cookieとは',
      paragraphs: [
        'Cookieは、ユーザーがウェブサイトを訪問した際に端末に保存される小さなテキストファイルです。類似技術には local storage、session storage、ピクセル等があります。これらは、設定の記憶、ログイン状態の維持、本サービスの利用状況の把握に役立ちます。',
      ],
    },
    {
      title: '2. Cookieの利用方法',
      paragraphs: [
        '必須Cookie: 認証、セキュリティ、紹介帰属、コア機能（例: セッション状態、設定時のサブドメイン間認証状態）のために必要です。本サービス利用中は無効化できません。',
        '設定Cookie: 言語、Cookie同意状況、閉じたバナーなどの選択を記憶します。',
        '分析Cookie: ユーザーがCookieバナーで同意した場合、当社は Google Analytics および関連識別子を使用してトラフィックや機能利用を把握することがあります。分析イベントには、ページパス、紹介コード、仮名化IDが含まれる場合がありますが、ブローカーパスワードや取引指示は含まれません。',
      ],
    },
    {
      title: '3. 当社が設定するCookie',
      paragraphs: [
        '例として、認証プロバイダー由来の認証/セッションCookie、tsc_tracking_consent および tsc_tracking_seen_ts（Cookieバナーでの選択）、tsc_analytics_id（分析稼働時の仮名化分析ID）、tsc_ref および tsc_ref_ts（紹介帰属）、tsc_auth（有効時のサブドメイン間短期ログインヒント）があります。',
        'Cookie名および有効期間は、本サービス改善に伴って変更される場合があります。必須Cookieは通常、ログアウト時または所定のセキュリティ期間経過後に失効します。',
      ],
    },
    {
      title: '4. 第三者Cookie',
      paragraphs: [
        'Google（Analytics）、Stripe（checkout）、当社のホスティング事業者などの第三者は、関連機能の利用時に独自のCookieを設定することがあります。これらの利用は各事業者のポリシーに従います。',
      ],
    },
    {
      title: '5. ユーザーの選択',
      paragraphs: [
        '初回訪問時、Cookieバナーで非必須トラッキングを許可または拒否できます。ブラウザ設定でCookieをブロックまたは削除することも可能ですが、必須Cookieをブロックするとログインや主要機能が利用できない場合があります。',
        '対応地域で Google Analytics を無効化するには、Googleのブラウザアドオンまたはブラウザのプライバシー設定も利用できます。',
      ],
    },
    {
      title: '6. 更新',
      paragraphs: [
        '当社は本Cookieポリシーを随時更新する場合があります。ページ上部の「最終更新日」は最新版の日付を示します。',
      ],
    },
  ],
  closing:
    'Cookieに関するご質問は legal@tscopier.ai までご連絡いただくか、当社プライバシーポリシーをご確認ください。',
  contact: legalContactJa,
}

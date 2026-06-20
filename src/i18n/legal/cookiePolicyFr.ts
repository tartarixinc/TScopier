import type { LegalDocumentPageTranslations } from './types'
import { legalContactFr } from './contactFr'

export const cookiePolicyFr: LegalDocumentPageTranslations = {
  title: 'Politique relative aux cookies',
  lastUpdated: 'Dernière mise à jour : 8 juin 2026',
  intro:
    'La présente Politique relative aux cookies explique comment Tartarix, Inc. (« nous » ou « notre ») utilise les cookies et technologies similaires sur les sites web et applications TScopier. Elle doit être lue conjointement avec notre Politique de confidentialité.',
  sections: [
    {
      title: '1. Que sont les cookies ?',
      paragraphs: [
        'Les cookies sont de petits fichiers texte stockés sur votre appareil lorsque vous visitez un site web. Les technologies similaires incluent le stockage local, le stockage de session et les pixels. Ils aident les sites à mémoriser les préférences, à vous maintenir connecté et à comprendre comment le Service est utilisé.',
      ],
    },
    {
      title: '2. Comment nous utilisons les cookies',
      paragraphs: [
        'Cookies essentiels : requis pour l\'authentification, la sécurité, l\'attribution de parrainage et les fonctionnalités de base (p. ex., état de session, présence d\'authentification entre sous-domaines lorsque configuré). Ils ne peuvent pas être désactivés pendant l\'utilisation du Service.',
        'Cookies de préférences : mémorisent des choix tels que la langue, le statut du consentement aux cookies et les bannières fermées.',
        'Cookies d\'analytique : lorsque vous acceptez les cookies dans notre bannière, nous pouvons utiliser Google Analytics et des identifiants associés pour comprendre le trafic et l\'utilisation des fonctionnalités. Les événements d\'analytique peuvent inclure les chemins de page, les codes de parrainage et des identifiants pseudonymes — pas vos mots de passe courtier ni vos instructions de trading.',
      ],
    },
    {
      title: '3. Cookies que nous définissons',
      paragraphs: [
        'Exemples : cookies d\'authentification/de session de notre fournisseur d\'authentification ; tsc_tracking_consent et tsc_tracking_seen_ts (votre choix dans la bannière de cookies) ; tsc_analytics_id (identifiant d\'analytique pseudonyme lorsque l\'analytique est active) ; tsc_ref et tsc_ref_ts (attribution de parrainage) ; tsc_auth (indicateur de connexion à courte durée entre sous-domaines lorsque activé).',
        'Les noms et durées de vie peuvent évoluer à mesure que nous améliorons le Service. Les cookies essentiels expirent généralement lorsque vous vous déconnectez ou après une période de sécurité définie.',
      ],
    },
    {
      title: '4. Cookies tiers',
      paragraphs: [
        'Des tiers tels que Google (Analytics), Stripe (paiement) et nos hébergeurs peuvent définir leurs propres cookies lorsque vous interagissez avec leurs fonctionnalités. Leur utilisation est régie par leurs politiques.',
      ],
    },
    {
      title: '5. Vos choix',
      paragraphs: [
        'Lors de votre première visite, notre bannière de cookies vous permet d\'accepter ou de refuser le suivi non essentiel. Vous pouvez modifier les paramètres de votre navigateur pour bloquer ou supprimer les cookies ; bloquer les cookies essentiels peut empêcher la connexion ou le fonctionnement des fonctionnalités de base.',
        'Pour vous désinscrire de Google Analytics dans les régions prises en charge, vous pouvez également utiliser le module complémentaire de navigateur de Google ou les contrôles de confidentialité de votre navigateur.',
      ],
    },
    {
      title: '6. Mises à jour',
      paragraphs: [
        'Nous pouvons mettre à jour cette Politique relative aux cookies de temps à autre. La date de « Dernière mise à jour » en haut de page reflète la version la plus récente.',
      ],
    },
  ],
  closing:
    'Des questions sur les cookies ? Contactez legal@tscopier.ai ou consultez notre Politique de confidentialité.',
  contact: legalContactFr,
}

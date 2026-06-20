import type { LegalDocumentPageTranslations } from './types'
import { legalContactFr } from './contactFr'

export const privacyPolicyFr: LegalDocumentPageTranslations = {
  title: 'Politique de confidentialité',
  lastUpdated: 'Dernière mise à jour : 8 juin 2026',
  intro:
    'Tartarix, Inc. (« Tartarix », « nous » ou « notre ») respecte votre vie privée. La présente Politique de confidentialité explique comment nous collectons, utilisons, divulguons et protégeons les informations lorsque vous utilisez les sites web et applications TScopier (le « Service »).',
  sections: [
    {
      title: '1. Informations que nous collectons',
      paragraphs: [
        'Informations de compte : nom, adresse e-mail, hachage du mot de passe, préférences de langue et de profil, statut d\'abonnement et codes de parrainage.',
        'Configuration courtier et trading : libellés de courtier, identifiants de compte (les mots de passe ne sont pas stockés en clair), type de plateforme, sélections de canaux, paramètres du copieur et journaux d\'exécution nécessaires au fonctionnement du Service.',
        'Données de trading et de signaux : identifiants de canaux Telegram, contenu de signaux analysé, enregistrements de trades, motifs d\'omission et métriques de performance associées à votre compte.',
        'Informations de paiement : statut de facturation et identifiants client de notre processeur de paiement. Les données de carte sont traitées par le processeur, pas par nous.',
        'Données techniques : adresse IP, type de navigateur, informations sur l\'appareil, cookies, identifiants d\'analytique et événements d\'utilisation (voir notre Politique relative aux cookies).',
        'Communications : messages que vous envoyez aux adresses e-mail support, juridique ou litiges.',
      ],
    },
    {
      title: '2. Comment nous utilisons les informations',
      paragraphs: [
        'Fournir, maintenir et améliorer le Service ; authentifier les utilisateurs ; traiter les abonnements ; exécuter les flux de copy-trading configurés ; afficher les tableaux de bord et les journaux.',
        'Envoyer des e-mails transactionnels (vérification, facturation, avis de sécurité) et répondre aux demandes d\'assistance.',
        'Surveiller la fiabilité, prévenir la fraude et les abus, faire respecter nos Conditions et respecter les obligations légales.',
        'Analyser l\'utilisation agrégée pour améliorer les fonctionnalités du produit (sous réserve de vos choix en matière de cookies le cas échéant).',
      ],
    },
    {
      title: '3. Bases juridiques (utilisateurs EEE/Royaume-Uni)',
      paragraphs: [
        'Lorsque le RGPD ou des lois similaires s\'appliquent, nous traitons les données personnelles sur la base de : l\'exécution d\'un contrat (fourniture du Service), l\'intérêt légitime (sécurité, analytique, amélioration du produit), le consentement (cookies non essentiels/marketing lorsque requis) et l\'obligation légale.',
      ],
    },
    {
      title: '4. Comment nous partageons les informations',
      paragraphs: [
        'Prestataires de services : hébergement et base de données (p. ex., Supabase), traitement des paiements (p. ex., Stripe), envoi d\'e-mails, analytique (p. ex., Google Analytics avec consentement), API de connectivité courtier et outils d\'assistance client — uniquement dans la mesure nécessaire au fonctionnement du Service.',
        'Nous ne vendons pas vos informations personnelles. Nous pouvons divulguer des informations si la loi l\'exige, pour protéger les droits et la sécurité, ou dans le cadre d\'une fusion, acquisition ou cession d\'actifs avec les garanties appropriées.',
      ],
    },
    {
      title: '5. Transferts internationaux',
      paragraphs: [
        'Nous pouvons traiter et stocker des informations aux États-Unis et dans d\'autres pays où nous ou nos prestataires opérons. Nous utilisons des garanties appropriées pour les transferts transfrontaliers lorsque la loi l\'exige.',
      ],
    },
    {
      title: '6. Conservation',
      paragraphs: [
        'Nous conservons les informations tant que votre compte est actif et selon les besoins pour fournir le Service, résoudre les litiges, faire respecter les accords et respecter les exigences légales. Vous pouvez demander la suppression, sous réserve d\'exceptions (p. ex., dossiers de facturation que nous devons conserver).',
      ],
    },
    {
      title: '7. Sécurité',
      paragraphs: [
        'Nous utilisons des mesures administratives, techniques et organisationnelles conçues pour protéger les informations. Aucune méthode de transmission ou de stockage n\'est sécurisée à 100 % ; nous ne pouvons garantir une sécurité absolue.',
      ],
    },
    {
      title: '8. Vos droits et choix',
      paragraphs: [
        'Selon votre localisation, vous pouvez avoir le droit d\'accéder, de rectifier, de supprimer, de restreindre ou de porter vos données personnelles, et de vous opposer à certains traitements. Vous pouvez mettre à jour les paramètres de profil dans l\'application et gérer vos préférences en matière de cookies via notre bannière de cookies.',
        'Pour exercer vos droits en matière de confidentialité, contactez legal@tscopier.ai. Nous pouvons vérifier votre identité avant de répondre. Vous pouvez également déposer une plainte auprès de votre autorité locale de protection des données.',
      ],
    },
    {
      title: '9. Enfants',
      paragraphs: [
        'Le Service ne s\'adresse pas aux enfants de moins de 18 ans. Nous ne collectons pas sciemment d\'informations personnelles auprès d\'enfants. Contactez-nous si vous pensez qu\'un enfant a fourni des données et nous les supprimerons.',
      ],
    },
    {
      title: '10. Modifications',
      paragraphs: [
        'Nous pouvons mettre à jour cette Politique de confidentialité de temps à autre. Nous publierons la politique révisée avec une nouvelle date de « Dernière mise à jour » et, le cas échéant, fournirons un avis supplémentaire.',
      ],
    },
  ],
  closing:
    'Pour toute question ou demande relative à la confidentialité, contactez legal@tscopier.ai.',
  contact: legalContactFr,
}

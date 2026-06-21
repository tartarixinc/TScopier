import type { ContactSupportPageTranslations } from './types'

export const contactSupportFr: ContactSupportPageTranslations = {
  channelsTitle: 'Comment pouvons-nous vous aider ?',
  channelsSubtitle: 'Contactez l’équipe TScopier par e-mail, consultez la documentation ou démarrez un chat en direct.',
  email: {
    title: 'Support par e-mail',
    description: 'Questions compte, facturation ou copieur — réponse généralement sous un jour ouvré.',
    cta: 'Envoyer un e-mail',
  },
  docs: {
    title: 'Documentation',
    description: 'Guides pas à pas pour brokers, canaux Telegram, styles de trade et dépannage.',
    cta: 'Ouvrir la doc',
  },
  liveChat: {
    title: 'Chat en direct',
    description: 'Discutez avec nous en temps réel pour une aide rapide depuis le tableau de bord.',
    cta: 'Démarrer le chat',
  },
  faq: {
    title: 'Questions fréquentes',
    subtitle: 'Réponses rapides avant de nous contacter.',
    items: [
      {
        question: 'Comment connecter mon compte MetaTrader ?',
        answer:
          'Ouvrez Configuration, ajoutez un compte broker, saisissez vos identifiants MetaTrader et attendez le statut connecté. Enregistrez le style de trade, la taille de lot et la sélection de canal avant que la copie ne démarre.',
      },
      {
        question: 'Pourquoi mes signaux Telegram ne sont pas copiés ?',
        answer:
          'Vérifiez que le broker est connecté, le canal Telegram lié et actif, le canal sélectionné sur le broker en Configuration, votre abonnement actif et votre e-mail vérifié. Consultez les Copier Logs pour les raisons de skip.',
      },
      {
        question: 'Comment ajouter un canal de signaux Telegram ?',
        answer:
          'Allez dans Canaux, connectez Telegram si besoin, puis ajoutez le nom d’utilisateur ou le lien d’invitation. Activez le canal et assignez-le aux comptes broker concernés en Configuration.',
      },
      {
        question: 'À quoi sert le blackout news / calendrier économique ?',
        answer:
          'Si le trading news est désactivé, TScopier peut suspendre les nouvelles entrées et éventuellement fermer des trades autour des événements à fort impact. Consultez le Calendrier économique et configurez les règles dans Configuration.',
      },
      {
        question: 'Faut-il un abonnement payant pour copier ?',
        answer:
          'Un plan payant actif est requis pour l’exécution live du copieur Telegram. Consultez Facturation pour votre plan et le renouvellement.',
      },
      {
        question: 'Pourquoi vérifier mon e-mail ?',
        answer:
          'La vérification confirme votre connexion et permet l’envoi de reçus et d’alertes importantes. Utilisez le lien de renvoi ou contactez le support avec l’adresse utilisée à l’inscription.',
      },
      {
        question: 'Mon broker est déconnecté — que faire ?',
        answer:
          'Vérifiez que MetaTrader fonctionne côté broker, que les identifiants sont valides et que le compte n’est pas bloqué. Actualisez depuis Configuration et consultez les Copier Logs. En cas de blocage, écrivez au support avec le nom du broker et le login (jamais le mot de passe).',
      },
      {
        question: 'Puis-je copier le même canal sur plusieurs brokers ?',
        answer:
          'Oui. Liez chaque compte MetaTrader séparément en Configuration et sélectionnez le même canal Telegram sur chaque broker. Les paramètres de lot et de risque sont par compte.',
      },
    ],
  },
}

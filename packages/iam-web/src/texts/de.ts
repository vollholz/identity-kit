/**
 * Texte des Baukastens auf Deutsch (Quelle und Standard): Du-Form, Schweizer Rechtschreibung (ss statt ß), Begriffe nach
 * Spezifikation 11.2 (Organisation, Rolle, Recht, Scope, Zugriffsregel). Wortlaut wie in vollholz/assets, damit Apps nach
 * der Umstellung gleich aussehen. Platzhalter `{name}`; Mehrzahl mit `…_one`/`…_other`.
 */
export const de = {
  'iam.error.0': 'Keine Verbindung zum Server',
  'iam.error.400': 'Die Anfrage ist ungültig.',
  'iam.error.401': 'Du bist nicht (mehr) angemeldet.',
  'iam.error.403': 'Dafür fehlt dir das Recht.',
  'iam.error.404': 'Nicht gefunden – gelöscht, für dich nicht sichtbar oder in einer anderen Organisation.',
  'iam.error.409': 'Konflikt mit dem aktuellen Stand.',
  'iam.error.412': 'Inzwischen von jemand anderem geändert.',
  'iam.error.422': 'Die Eingabe ist ungültig.',
  'iam.error.429': 'Zu viele Anfragen – bitte kurz warten.',
  'iam.error.500': 'Interner Fehler auf dem Server.',
  'iam.error.502': 'Der Server ist nicht erreichbar.',
  'iam.error.503': 'Der Dienst ist vorübergehend nicht verfügbar.',
  'iam.error.status': 'Fehler {status}',
  'iam.error.network': 'Bitte Netzwerk prüfen und erneut versuchen.',
  'iam.error.unexpected': 'Unerwarteter Fehler',
  'iam.time.now': 'gerade eben',
  'iam.common.cancel': 'Abbrechen',
  'iam.common.close': 'Schliessen',
  'iam.common.closeEsc': 'Schliessen (Esc)',
  'iam.state.loading': 'Wird geladen …',
  'iam.state.retry': 'Erneut versuchen',
  'iam.state.reference': 'Referenz {id}',
  'iam.state.notFound.title': 'Nicht gefunden',
  'iam.state.notFound.text': 'Gelöscht, für dich nicht sichtbar oder in einer anderen Organisation.',
  'iam.state.notFound.org': 'Du arbeitest in «{org}».',
  'iam.state.home': 'Zur Übersicht',
  'iam.picker.title': 'Auswählen',
  'iam.picker.list': 'Auswahl',
  'iam.picker.search': 'Suchen …',
  'iam.picker.loading': 'Wird geladen …',
  'iam.picker.none': 'Keine Treffer',
  'iam.picker.failed': 'Laden fehlgeschlagen.',
  'iam.picker.clear': 'Leeren',
  'iam.picker.apply': 'Übernehmen',
  'iam.toast.close': 'Meldung schliessen',
} as const;

export type IamTextKey = keyof typeof de;

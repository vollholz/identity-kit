# @vollholz/iam-web

Frontend-Baustein (React). Spezifikation Kap. 11.

Inhalt: `IamProvider`, Sitzung und `/auth/me`, Organisation je Tab, `useAuthz()`, `useResourceCan()`, `MissingRight`,
Routen-Guard, Rechte-Übersicht, Rollenmatrix, «Meine Rollen und Rechte», Verwalten › Zugang (Mitglieder, Rollen,
Anmeldung, Maschinen-Clients), Zugriff, Organisationen. Kein eigenes Aussehen: CSS-Variablen `--iam-*` aus den
Design-Tokens der App, Texte `iam.*` (de/en) überschreibbar.

Herkunft: vollholz/assets `web/src/auth`, `web/src/shell/{UserMenu,MyRights}.tsx`, `web/src/ui/{MissingRight,
RightsOverview,RoleMatrix,AdminHead,MenuButton,org}.tsx`, `web/src/features/{admin,acl}`.

Stand: leer.

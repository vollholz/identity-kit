/**
 * Testseite: alle Grundkomponenten mit den Vorgaben des Pakets. `?app=1` setzt Variablen wie eine App (ohne Ebene) auf
 * :root, `?dlg=…` öffnet einen Dialog direkt (für axe und Screenshots).
 */
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/styles.css';
import {
  ApiError, Button, Confirm, Empty, ErrorBox, ErrorState, IamUiProvider, Loading, MenuButton, MenuItem, Modal, NotFound, Sheet,
  SkeletonRows, Table, useIamUi, usePicker,
} from '../../../src/index.ts';
import './page.css';

const params = new URLSearchParams(location.search);
if (params.get('app') === '1') {
  const s = document.createElement('style');
  s.textContent = ':root { --iam-accent: rgb(1, 2, 3); --iam-surface: rgb(250, 240, 230); }';
  document.head.append(s);
}

const MEMBERS = [
  { name: 'Anna Admin', email: 'anna@demo.example', status: 'aktiv', roles: 'Organisations-Admin', seen: 'vor 5 Minuten' },
  { name: 'Ben Beispiel mit einem sehr langen Namen', email: 'ben.beispiel-mit-langer-adresse@demo.example', status: 'eingeladen', roles: 'Leser:in, Bearbeiter:in', seen: 'nie' },
];

function Page() {
  const ui = useIamUi();
  const [dlg, setDlg] = useState(params.get('dlg'));
  const pickBtn = useRef<HTMLButtonElement>(null);
  const picker = usePicker();
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <main className="page">
      <h1>Bausteine</h1>
      <section aria-labelledby="h-btn">
        <h2 id="h-btn">Knöpfe</h2>
        <div className="row">
          <Button>Standard</Button>
          <Button variant="primary" icon="plus">Person einladen</Button>
          <Button variant="ghost">Abbrechen</Button>
          <Button variant="danger">Entfernen</Button>
          <Button variant="danger-solid" icon="trash">Löschen</Button>
          <Button size="sm">Klein</Button>
          <Button busy>Speichert …</Button>
          <Button href="#oben">Als Link</Button>
        </div>
      </section>
      <section aria-labelledby="h-dlg">
        <h2 id="h-dlg">Dialoge und Meldungen</h2>
        <div className="row">
          <Button onClick={() => setDlg('form')}>Dialog öffnen</Button>
          <Button onClick={() => setDlg('confirm')}>Rückfrage öffnen</Button>
          <Button onClick={() => setDlg('sheet')}>Blatt öffnen</Button>
          <Button onClick={() => ui.toast.show('Gespeichert')}>Meldung</Button>
          <Button onClick={() => ui.toast.error(new ApiError(409, {}), 'Nicht gespeichert')}>Fehlermeldung</Button>
          <MenuButton label="Aktionen" buttonLabel="Mehr zu Anna Admin" button="⋯" fixed>
            {close => <>
              <MenuItem icon="send" label="Einladung erneut senden" onPick={close} />
              <MenuItem icon="trash" label="Person entfernen …" danger why="Die letzte Person mit «Organisations-Admin» bleibt." onPick={close} />
            </>}
          </MenuButton>
          <button ref={pickBtn} type="button" className="iam-btn" aria-haspopup="dialog"
            onClick={() => picker.open({ anchor: pickBtn.current!, title: 'Rolle', multi: true, selected: picked, onPick: setPicked,
              items: [{ value: 'editor', label: 'Bearbeiter:in', sub: 'editor' }, { value: 'viewer', label: 'Leser:in', sub: 'viewer' }] })}>
            Rollen wählen ({picked.length})
          </button>
          {picker.node}
        </div>
      </section>
      <section aria-labelledby="h-tbl">
        <h2 id="h-tbl">Tabelle (gestapelt unter 760 px)</h2>
        <div className="iam-tblwrap">
          <Table stack aria-labelledby="h-tbl">
            <thead><tr><th>Person</th><th>Status</th><th>Rollen</th><th className="iam-st-hide">Zuletzt aktiv</th><th><span className="iam-sr">Aktionen</span></th></tr></thead>
            <tbody>
              {MEMBERS.map(m => (
                <tr key={m.email}>
                  <td><b>{m.name}</b><div className="iam-muted iam-small">{m.email}</div></td>
                  <td><span className="iam-st-lbl">Status:</span><span className={`iam-pill ${m.status === 'aktiv' ? 'iam-st-ok' : 'iam-st-warn'}`}>{m.status}</span></td>
                  <td>{m.roles}</td>
                  <td className="iam-st-hide">{m.seen}</td>
                  <td><Button size="sm">Rollen</Button></td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </section>
      <section aria-labelledby="h-st">
        <h2 id="h-st">Zustände</h2>
        <Loading />
        <SkeletonRows rows={2} cols={3} />
        <Empty icon="users" title="Noch keine Mitglieder">Lade die erste Person ein.</Empty>
        <ErrorBox error={new ApiError(422, { title: 'Ungültige Eingabe', errors: [{ path: '/email', message: 'ist keine E-Mail-Adresse' }] })} onRetry={() => {}} />
        <ErrorState error={new ApiError(500, { title: 'Interner Fehler' }, 'req-1')} onRetry={() => {}} />
        <NotFound org="Demo AG" />
      </section>
      {dlg === 'form' ? (
        <Modal title="Person einladen" onClose={() => setDlg(null)} onSubmit={() => setDlg(null)}
          footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Abbrechen</Button><Button variant="primary" type="submit">Einladen</Button></>}>
          <label className="field">E-Mail<input type="email" name="email" /></label>
          <p className="iam-note">Die Einladung gilt für «Demo AG».</p>
        </Modal>
      ) : null}
      {dlg === 'confirm' ? (
        <Confirm title="Rolle löschen?" confirm="Rolle löschen" danger onConfirm={() => setDlg(null)} onClose={() => setDlg(null)}>
          <p>Drei Personen verlieren die Rolle «Prüfer:in».</p>
        </Confirm>
      ) : null}
      {dlg === 'sheet' ? <Sheet title="Details" onClose={() => setDlg(null)}><p>Inhalt des Blatts.</p></Sheet> : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><IamUiProvider><Page /></IamUiProvider></StrictMode>);

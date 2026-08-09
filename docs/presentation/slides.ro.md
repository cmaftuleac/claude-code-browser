# Schiță slide-uri — Claude Code Browser (RO)

10 slide-uri (0–9). Text puțin pe slide; restul îl narezi tu. Notele vizuale în _italic_. Slide-urile generate sunt în [`images/generated/`](images/generated/), capturile reale în [`images/`](images/).

Structura: **0** titlu · **1** intro · **2** problemă · **3–4–5** soluția · **6** arhitectură · **7** demo · **8** cifre · **9** încheiere.

---

### Slide 0 — Titlu + captură
**Claude Code Browser** — *Extensie Chrome care leagă pagina din browser de Claude Code*

- Numele + un descriptor factual + produsul în acțiune.

_Vizual: `slide-00-title.png` — logo starburst + captura reală a panoului lateral (sesiunea cu deploy în producție) într-un card simplu (fără cadru de telefon)._

---

### Slide 1 — Cine sunt
**Fineguide.AI**

- Platformă de business automatizare cu AI.
- Claude Code Browser e un proiect de weekend ieșit din munca de zi cu zi.

_Vizual: `slide-01-intro.png` — text în stânga; logo Fineguide (dreapta-sus) + cod QR către fineguide.ai (dreapta-jos), ambele compozitate real (scanabile)._

---

### Slide 2 — Problema
**Cum îi arăți unui AI exact ce element să modifice?**

- Codul i-l descrii ușor unui AI. Un **pixel de pe ecran**? Dureros.
- Bucla de azi: captură → „al treilea card" → lipești un selector → „nu, *celălalt*" → ghicit.

_Vizual: `slide-02-problem.png` — colaj haotic: captură cu săgeți roșii, selector CSS lipit, thread de chat frustrant._

---

### Slide 3 — Soluția (1/3): ideea
**Selectezi elementul direct în pagină**

- Click pe element. Claude îl vede *și* îți vede codul sursă.
- Elementul devine un „chip" în mesaj — referință de prim rang.

_Vizual: `slide-03-solution-idea.png` — stânga: text + ilustrație cursor → chip; dreapta: captură reală (panoul lateral inspectând un element din pagină) într-un card simplu._

---

### Slide 4 — Soluția (2/3): fluxul
**Cum funcționează, pas cu pas**

1. Click pe element → selector, XPath, cale DOM, fragment HTML
2. Trimis la Claude Code ca referință bogată
3. Claude citește **fișierele sursă reale** și le editează
4. Browserul se reîncarcă — modificarea e live

_Vizual: `slide-04-solution-flow.png` — stânga: 4 pași numerotați, fiecare cu o iconiță; dreapta: captură reală (un element selectat în pagină → chip) într-un card simplu._

---

### Slide 5 — Soluția (3/3): nu doar CSS
**De la o ajustare la o funcționalitate completă** — *scrie → commit → deploy → verifică*

- Același flux, sarcină mai mare: „adaugă dialogul de cookie-uri GDPR."
- Claude scrie, face commit, push, **deploy în producție**, apoi **verifică live**.

_Vizual: `slide-05-solution-beyond-css.png` — pipeline: cod → git commit → deploy → bifaj verde „verificat live"._

---

### Slide 6 — Arhitectura
**Arhitectura: patru componente**

- Extensie Chrome → Native Messaging → Host Node.js → Claude Code
- Extensia controlează browserul prin `chrome.debugger`; host-ul folosește Claude Agent SDK.
- Refolosește autentificarea ta Claude Code — fără cheie API, fără browser separat.

_Vizual: `slide-06-architecture.png` — diagrama celor patru cutii + captura „Setup Required" (puntea locală) într-un cadru de telefon._

---

### Slide 7 — Demo
**DEMO — exemple live**

- Aplicație pe localhost, selectezi un element, întrebi, Claude editează sursa reală.

_Vizual: `slide-07-demo.png` — slide-divizor „DEMO". Apoi treci pe ecran; vezi `demo-runbook.md`._

---

### Slide 8 — Cifre din Chrome Web Store
**Cifre din Chrome Web Store.**

- ~**1.000 utilizatori săptămânal**, **+782%** în 30 de zile, **5,0★**, **946 instalări**.

_Vizual: `slide-08-metrics.png` — curba de creștere + listarea din store, ambele capturi reale compozitate._

---

### Slide 9 — Încheiere + QR
**Instalează din Chrome Web Store**

- `npx claude-code-browser install`
- Scanează codul sau caută „Claude Code Browser".

_Vizual: `slide-09-end.png` — text în stânga; cod QR (dreapta) către listarea din Chrome Web Store, compozitat real (scanabil)._
</content>

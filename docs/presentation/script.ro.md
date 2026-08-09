# Scenariu prezentare — Claude Code Browser (RO)

~12–13 minute vorbit. Marcajele `[S#]` corespund slide-urilor din [`slides.ro.md`](slides.ro.md). `(pauză)` = pauză scurtă. Textul *italic* din paranteze drepte = indicații de scenă, nu se spune.

Ritm țintă ~130 de cuvinte/minut. Nu grăbi demo-ul; dacă trebuie să tai, taie din arhitectură, nu din demo.

| # | Secțiune | Timp |
|---|---|---|
| 0 | Titlu | 0:30 |
| 1 | Cine sunt | 1:00 |
| 2 | Problema | 1:30 |
| 3 | Soluția — ideea | 1:00 |
| 4 | Soluția — fluxul | 1:00 |
| 5 | Soluția — nu e doar CSS | 1:00 |
| 6 | Arhitectura | 2:00 |
| 7 | **Demo live** | 3:00 |
| 8 | Cifre | 1:00 |
| 9 | Încheiere | 0:30 |
| | **Total** | **~12:30** |

---

## 0 · Titlu — 0:30

**[S0 — titlu + captură]**

Bună tuturor. Astăzi vă arăt **Claude Code Browser** — o extensie de Chrome la care am lucrat un weekend și care, cumva, a ajuns pe Chrome Web Store. (pauză) Pe scurt: selectezi un element în pagină, iar Claude Code îi modifică direct codul.

---

## 1 · Cine sunt — 1:00

**[S1 — intro Corneliu + Fineguide]**

Pe scurt despre mine: vin de la **Fineguide.AI**, unde construim o platformă care transformă mesajele clienților în vânzări, cu AI — răspunsuri automate, calificare de lead-uri, integrare în CRM.

Lucrând zilnic cu agenți AI de cod, m-am tot lovit de o frustrare măruntă. Și dintr-un weekend de scărpinat acea frustrare a ieșit proiectul de azi. (pauză) _[arată QR-ul]_ Codul din dreapta duce la fineguide.ai, dacă vreți să vedeți ce facem.

---

## 2 · Problema — 1:30

**[S2 — problema]**

Iată frustrarea. Să descrii *cod* unui AI e ușor — îl copiezi, arăți o funcție. Dar să descrii un **pixel de pe ecran** e ciudat de greu.

Ne-am format toți un ritual. Faci o captură. Scrii „al treilea card, nu — cel din dreapta." Deschizi dev tools, copiezi un selector CSS, îl lipești. Agentul ghicește. Alege elementul greșit. Încerci din nou. (pauză)

E un joc de-a telefonul fără fir între ochii tăi și agent. Și fiecare rundă e o frecare. Pentru un instrument care ar trebui să te facă mai rapid, asta e partea care încă pare din 2015.

---

## 3 · Soluția (1/3): ideea — 1:00

**[S3 — ideea]**

Soluția e o singură idee: **dacă ai putea doar să arăți cu degetul?**

Dai click pe element. Atât. Agentul știe acum *exact* la ce te referi — și poate citi și codul tău sursă. În loc de „al treilea card", scrii „schimbă culoarea lui —" și apare un mic **chip** în mesaj care *este* acel buton. Elementul devine o referință de prim rang, chiar lângă cuvintele tale. (pauză) Fără capturi, fără selectori, fără descrieri.

---

## 4 · Soluția (2/3): fluxul — 1:00

**[S4 — fluxul]**

În practică sunt patru pași. Unu — dai click și extensia capturează elementul: selectorul CSS, XPath-ul, calea în DOM, fragmentul de HTML. Doi — totul ajunge la Claude Code ca referință bogată, nu ca o poză. Trei — Claude citește fișierele sursă *reale* de pe disc și face modificarea. Patru — browserul se reîncarcă, schimbarea e live. (pauză) Tot ciclul, fără să fi scris vreun nume de fișier sau vreun selector.

---

## 5 · Soluția (3/3): nu e doar CSS — 1:00

**[S5 — nu e doar CSS]**

Și „schimbă o culoare" subestimează lucrul. Același flux, sarcină mult mai mare. _[arată pipeline-ul]_ O sesiune reală: „adaugă dialogul de cookie-uri GDPR." Claude l-a scris, **a făcut commit, push, deploy în producție** — rebuild docker, reload nginx, purge la Cloudflare — și apoi **a deschis site-ul live și a verificat**. (pauză) Browserul nu e doar unde arăți. E unde verifici că treaba chiar a ajuns live.

---

## 6 · Arhitectura — 2:00

**[S6 — arhitectura]**

Deci cum ajunge o extensie Chrome să editeze fișiere de pe laptopul tău? Normal, nu poate — extensiile rulează în sandbox. Asta e partea interesantă de inginerie.

Sunt patru piese. _[urmărește diagrama]_ În stânga, **extensia Chrome** — React, Manifest V3, în panoul lateral; face interfața, selecția de elemente și controlează browserul prin `chrome.debugger`. Vorbește cu un mic **host Node.js** prin **Chrome Native Messaging** — singura portiță prin care o extensie poate vorbi cu un program local. Chrome pornește host-ul pentru tine, n-ai niciun server de întreținut. Iar host-ul folosește **Claude Agent SDK** ca să controleze **Claude Code** — același CLI pe care mulți îl aveți deja.

Și trei decizii au făcut totul simplu, toate de forma „refolosește, nu reconstrui": **fără cheie API** (se sprijină pe Claude Code-ul tău autentificat), **fără Playwright și fără un al doilea browser** (controlează tab-ul la care te uiți deja), și **n-am construit un AI** — creierul e Claude Code, eu doar i-am dat ochi și un deget cu care să arate.

---

## 7 · Demo live — 3:00

**[S7 — slide „DEMO", apoi treci pe ecran]**

_[Urmează `demo-runbook.md`. Narează fiecare acțiune.]_

Bun. Aplicație web obișnuită pe localhost. În dreapta, panoul lateral — extensia. Apăs butonul de selecție... și **dau click pe element**. (pauză) Vedeți? A devenit un chip. În spatele lui, agentul are selectorul, poziția, HTML-ul.

Scriu ca un om: „fă butonul ăsta albastru și puțin mai mare." Trimit. (pauză) Și priviți — nu face capturi și nu ghicește. **Citește fișierele mele sursă reale**, găsește componenta, o editează. ...Gata. Pagina se reîncarcă, butonul e albastru. N-am dat niciun nume de fișier, niciun selector. Am arătat și am întrebat.

---

## 8 · Cifre — 1:00

**[S8 — cifre din Chrome Web Store]**

Și nu-l folosesc doar eu. _[arată cifrele]_ Acum e cam o mie de utilizatori săptămânal, în creștere cu vreo 780% în ultima lună. Aproape o mie de instalări pe Chrome Web Store, rating de cinci stele. Tot ce vedeți aici sunt capturi reale din dashboard, nu cifre inventate.

---

## 9 · Încheiere — 0:30

**[S9 — încheiere + QR]**

Atât. Dacă lucrezi cu Claude Code și cu interfețe în browser, cred că o să-ți economisească timp real. (pauză)

Scanează codul din dreapta sau scrie `npx claude-code-browser install`. Sunt @cmaftuleac. (pauză) Mulțumesc — răspund cu drag la întrebări.

---

## Plan de tăieri (dacă depășești timpul)

1. Comprimă arhitectura (S6) doar la cele patru piese + „fără cheie API" — economisești ~45s.
2. Contopește fluxul (S4) în demo (S7) — economisești ~45s.
- **Niciodată** nu tăia: problema, momentul live „arată și repară" și cifrele.

## Întrebări probabile

- **„Îmi trimite codul pe un server?"** Nu — host-ul rulează local și refolosește sesiunea ta Claude Code. Controlul browserului e local, prin `chrome.debugger`.
- **„Cu ce diferă de Playwright MCP?"** Acela automatizează un browser separat. Acesta controlează tab-ul în care ești deja; cârligul e selecția de elemente.
- **„Funcționează în afara VS Code?"** Da — panoul lateral merge de sine stătător; `/browse` merge și din CLI-ul Claude Code.
- **„Cât costă?"** Folosește planul tău Claude Code existent — fără cheie sau abonament suplimentar.
</content>

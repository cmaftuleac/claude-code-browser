# Prezentare: Claude Code Browser — proiect de weekend

Materiale pentru o prezentare de **10–15 minute**, susținută **în limba română**. Folosește fișierele `.ro.md`; versiunile în engleză sunt păstrate ca referință (structura veche, 14 slide-uri).

## Structura curentă (10 slide-uri, 0–9)

| # | Slide | Despre |
|---|---|---|
| 0 | Titlu + captură | O frază + produsul în acțiune (panoul lateral cu deploy). |
| 1 | Cine sunt | Corneliu Maftuleac · Fineguide.AI — logo + QR către fineguide.ai. |
| 2 | Problema | E greu să-i spui unui AI *care* pixel. |
| 3 | Soluția 1/3 | Ideea: dă click, elementul devine referință. |
| 4 | Soluția 2/3 | Fluxul: arată → context → repară → reîncarcă. |
| 5 | Soluția 3/3 | Nu e doar CSS: scrie → commit → deploy → verifică. |
| 6 | Arhitectura | Patru piese + captura „Setup Required". |
| 7 | Demo | Divizor pentru demo-ul live. |
| 8 | Cifre | Chrome Web Store: ~1.000 utilizatori/săpt., +782%, 5,0★. |
| 9 | Încheiere + QR | CTA + QR către listarea din Chrome Web Store. |

## Fișiere

| Fișier | Ce este |
|---|---|
| [`slides.ro.md`](slides.ro.md) 🇷🇴 | **Schița slide-urilor** — de aici prezinți. |
| [`script.ro.md`](script.ro.md) 🇷🇴 | **Scenariul vorbit** cu marcaje de timp. |
| [`demo-runbook.md`](demo-runbook.md) | Pașii exacți pentru demo-ul live + plan de rezervă (video). |
| [`generate-slides-gemini.mjs`](generate-slides-gemini.mjs) | Generatorul de slide-uri — Google **Nano Banana 2** (`gemini-3.1-flash-image-preview`), compozitează capturile reale. |
| [`compose-overlays.sh`](compose-overlays.sh) | Suprapune codurile QR (scanabile) + logo-ul Fineguide cu ImageMagick. |
| [`images/`](images/) | Capturi reale ([`images/README.md`](images/README.md)) + slide-urile generate în [`images/generated/`](images/generated/). |
| [`assets/`](assets/) | Logo Fineguide (PNG) + cele două coduri QR. |
| `slides.md`, `script.md`, `generate-slides.mjs`, `slides-visual-spec.md` | Versiuni vechi (engleză / structura cu 14 slide-uri / generator OpenAI). Doar referință. |

## Regenerare

```bash
# toate slide-urile (text în română, capturi compozitate)
GOOGLE_API_KEY=AIza... node docs/presentation/generate-slides-gemini.mjs
# un singur slide
GOOGLE_API_KEY=AIza... node docs/presentation/generate-slides-gemini.mjs slide-08
# după generare, suprapune QR-urile + logo-ul:
bash docs/presentation/compose-overlays.sh
```

⚠️ **`compose-overlays.sh` nu e idempotent** — suprapune QR/logo *peste* fișierul existent. Rulează-l o singură dată, pe baze proaspăt generate. Dacă regenerezi un singur slide cu overlay (01 sau 09), regenerează ambele baze înainte de a-l rula din nou.

## De reținut înainte de prezentare

- **Capturile sunt reale** (502 utilizatori, +782,65%, 946 instalări, 5,0★, log-ul de deploy în producție) — compozitate neatinse pe slide-urile 0, 6, 8. Astea-s dovada.
- **Codurile QR sunt reale și scanabile** (PNG-uri compozitate cu ImageMagick, nu desenate de model): slide 1 → fineguide.ai, slide 9 → listarea din Chrome Web Store. Testează-le pe proiector înainte.
- **Diacriticele** (ă â î ș ț) sunt corecte în acest set — verifică-le după orice regenerare.
- Comanda `npx claude-code-browser install` a fost verificată corect pe slide-urile 5 și 9.

## Verifică / completează

- **Bio slide 1:** am pus „Fondator · Fineguide.AI" + tagline-ul de pe site. Ajustează dacă vrei alt titlu sau altă descriere.
- **URL QR store:** am folosit URL-ul canonic (`...mnibceaaapcppokpnnljohdlmojjgbkf`), fără `authuser=0` (parametru legat de contul tău). Schimbă în `compose-overlays.sh` dacă vrei exact link-ul tău.

> Cheile API (OpenAI mai devreme, Google acum) au fost date în chat doar pentru aceste rulări, citite din variabile de mediu, niciodată salvate în fișiere. **Rotește-le** — Google: https://aistudio.google.com/app/apikey · OpenAI: https://platform.openai.com/api-keys.

## Pitch-ul într-o frază

> O extensie Chrome care te lasă **să arăți spre orice element din pagină** și Claude Code îl repară — fără capturi, fără selectori copiați.
</content>

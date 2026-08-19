# Flöden — designregler (Eneo-profil)

Kontext för designarbete i claude.ai på `prototyp.html`. Följ dessa regler så
att ändringarna går att föra tillbaka till den riktiga koden utan friktion.

## Vad appen är
"Flöden" är en Eneo-app där en åtkomstkod-skyddad användare spelar in eller laddar
upp ljud/dokument, skickar det till ett publicerat **Eneo-flöde**, och får tillbaka
transkript, sammanfattning och ev. genererade filer (DOCX m.m.). Mobil-först,
fungerar även på desktop.

## Teknisk stack (det prototypen ska kunna mappas till)
- **Next.js 15** (App Router) + **React 19**, **TypeScript**.
- **Tailwind CSS 3** med komponentbiblioteket **`@sk-web-gui`**: `@sk-web-gui/core`
  (Tailwind-preset + tokens) och `@sk-web-gui/react` (komponenter). `GuiProvider`
  med ljust färgschema.
- Ikoner: **Lucide** (`lucide-react`).
- Prototypen använder Tailwind Play-CDN med samma tokens — den är en visuell spegel,
  inte produktionskod. Slutkoden använder riktiga `@sk-web-gui/react`-komponenter.

> **Viktigt:** Allt som designas måste gå att bygga med `@sk-web-gui/react` +
> Tailwind. Inför inte beroenden eller mönster som krockar med komponentbiblioteket.

## Färger (tokens = klassnamn i koden)
Profil: **vit/neutral ytor + Eneo-blå** som brand/CTA. Inga beige/varma toner.

| Token (Tailwind) | Hex | Användning |
|---|---|---|
| `bg` | `#FAFAFA` | Sidbakgrund |
| `bg-2` | `#F0F0F0` | Sekundär yta / neutralt chip |
| `paper` | `#FFFFFF` | Kort, paneler (`.paper-card`) |
| `ink` | `#1F1F25` | Primärtext |
| `ink-soft` | `#444450` | Sekundärtext |
| `ink-mute` | `#68686D` | Mute/metatext |
| `rule` | `#B7B7BA` | Tydligare kant/avdelare |
| `rule-soft` | `#E5E5E5` | Mjuk kant |
| `accent` | `#004595` | **Eneo-blå** – brand, CTA, länkar, accent-em |
| `accent-soft` | `#CFE0EC` | Ljusblå yta (t.ex. ikon-chip) |
| `ochre` | `#8C3B12` | SK warning – info-/varningsruta |

Övriga semantiska färger finns via preseten: success `#00592D`, error `#971A1A`,
info `#004C85`, focus-ring `#0C8CED`. Använd dessa för status snarare än egna hex.

Använd alltid token-klasser (`bg-accent`, `text-ink`, `border-rule-soft`, …), inte
godtyckliga hex i markup.

## Typografi
- **Rubriker (h1–h6): Raleway** (600–800). Profilens primärtypsnitt.
- **Brödtext: Inter** (400–600). Raleway är för displaytungt i små storlekar.
- **Etiketter/"eyebrow": Geist Mono**, uppercase, ökad letterspacing (`.eyebrow`,
  `.eyebrow-sm`). Används för små överrubriker, metadata, fältetiketter.
- Rubriker har tight tracking (`tracking-[-0.025em]`) och `leading` ~1.05–1.15.
- `.accent-em` = framhävt ord i rubrik (accentblå, ej kursiv).

## Layout & spacing
- **App-shell**: centrerad kolumn, max 430px (mobil) → 760 → 1024 → 1180px (desktop).
- Sidpadding `px-6 md:px-8`. Innehåll centreras med `mx-auto max-w-*`.
- **Radius**: standard `0.5rem`; kort/paneler `rounded-2xl` (1rem); chips `rounded-[10px]`;
  knappar/avatar ofta `rounded-full` resp. SK-knapparnas egen radie.
- Sektioner ska ha rejäl luft emellan (topp-padding `pt-8 md:pt-10` på rubriken).

## Komponenter
- **Knappar** → `@sk-web-gui/react` `Button` med `color="vattjom"` (bibliotekets
  namn på accentfärgen — inte en varumärkeshänvisning).
  - Primär CTA: `variant="primary"` (fylld blå). Sekundär: `variant="secondary"`
    (vit, blå kant). `size="lg"` för huvud-CTA. Spinner via `loading`/`loadingText`.
  - I prototypen: `.btn .btn-primary` / `.btn-secondary` approximerar dessa.
- **Formulär** → `FormControl` + `FormLabel` + `Input`/`Textarea` (`@sk-web-gui`).
  Etikett i eyebrow-stil. `required` ger asterisk via FormControl.
- **Kort** → `.paper-card` (vit, `rule-soft`-kant, rundat). Klickbara kort får
  hover `border-ink` och `active:scale`.
- **Tjänste-/flödesikon-chip**: 38×38, `rounded-[10px]`, **ljusblå bakgrund
  `bg-accent-soft` + mörkblå ikon `text-accent`** (poppar mot grått). `strokeWidth=2`.
- **Sektionsrubrik** (delad yta/space): `<h2>` i Raleway (20–24px, bold), med
  flödesantal som liten `eyebrow`-etikett till höger. Ev. beskrivning som
  `ink-soft`-paragraf under.
- **Info-/varningsruta**: `ochre`-ton, `border-ochre/40 bg-ochre/10`, Info-ikon.

## Ikonografi (Lucide)
- Tjänsteikon väljs efter flödets **första input-steg**:
  `audio` → `mic`, `document`/`file`/`image` → `file-text`. Annars dekorativ ikon.
- Använd genomgående Lucide, stroke 1.6–2.

## Innehåll & ton
- Språk: **svenska**, vänlig och konkret.
- Återkommande regel: appen får bara användas för **öppen och publik information** —
  inga personuppgifter eller känsliga uppgifter. Visas som info-ruta i startvyn.

## Gör / undvik
- ✅ Håll vit/neutral + Eneo-blå. ✅ Token-klasser. ✅ Raleway-rubriker / Inter-text.
  ✅ Tänk mobil-först. ✅ Tillräcklig kontrast och synliga fokus-ringar (WCAG 2.2 AA).
- ❌ Inga beige/varma bakgrunder eller röd-orange accent (gammal stil).
- ❌ Inga godtyckliga hex i markup när token finns. ❌ Inga UI-bibliotek utöver
  `@sk-web-gui` (t.ex. inte MUI/Chakra/Bootstrap). ❌ Raleway i liten brödtext.

## Skärmar i prototypen
1. **Login** – åtkomstkod.
2. **Startsida / flödeslista** – header, hero, sektion per delad yta (H2 + beskrivning)
   och flödeskort med tjänsteikoner.
3. **Förbered/Setup** – formulär, info-ruta, ladda upp/spela in, "Kör flöde".
4. **Resultat/Notes** – sammanfattning (markdown), genererade filer, footer-knappar.
5. **Inspelningsvy** – live-inspelning: stor timer, animerad ljudmätare (waveform),
   "Spelar in"-puls, paus/stopp-kontroller. Bespoke (ingen SK-komponent) – behåll
   den distinkta känslan; stopp-knappen i accentblå.
6. **Granskningsvy** – human-in-the-loop: pausat flöde, redigerbart innehåll i
   `.paper-card`, "Avvisa" + "Godkänn och fortsätt" (SK-knapp).

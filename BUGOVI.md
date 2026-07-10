# Provjera povezanosti sa otpremom — izvještaj o bugovima

> ## ✅ STATUS: SVI BUGOVI ISPRAVLJENI — 10.07.2026.
> - **#1** batchSpent → `syncSpent` na nivou cijelog sync runa; popravka potvrđena simulacijom ASIKS scenarija (dva reda, isti kupac, isti sync)
> - **#2** auto-brisanje sada zahtijeva da je SVAKO polje ≤ 0 (`FIELDS.every`), ne zbir
> - **#3** PP auto-detect blok premješten PRIJE `totalQty` provjere
> - **#4** deleteOtp provjerava postoji li dispozicija i upozorava ako ne postoji
> - **#5** novi `kupacMatch()` helper — podstring poklapanje samo za imena ≥5 znakova; primijenjen na sva 4 mjesta (ručni FIFO, sync FIFO, PP routing, PP auto-detect)
> - **#6** ručni FIFO dobio isti datumski filter kao sync (+ fallback na odabranu dispoziciju)
> - **#7** ručna otprema više ne prima budući datum
> - **#8** potvrda ručne otpreme sada jasno kaže da se količine FIFO raspoređuju
> - **#9** getBalanceAtDate broji samo otpreme postojećih dispozicija
> - **#10** identični dupli redovi dobiju `_r2`, `_r3`... ključ umjesto tihog preskakanja (`uniqueKey()`)
> - **#11** PP marker (odjel+klasa na otpremi) čuva badge/filter i nakon brisanja odjela
> - **#12** mrtvi kod `isRecentlyExhausted()` uklonjen

**Datum provjere:** 10.07.2026.
**Provjereno:** ručna otprema (submitOtprema → confirmOtprema), sync iz Google Sheets-a (syncSheet → doSync), FIFO raspodjela, getBalance/balStatus, brisanje/storniranje otprema, historija otprema, auto-brisanje i arhiviranje dispozicija, pretprodaja routing, Raspored (autoSuggest/raspDispInfo).

---

## ✅ Šta radi ispravno

- `getBalance()` — tačno sabira otpreme po `disp_id` (do današnjeg dana) i oduzima od originala; PP otpreme ne diraju regularne balanse i obratno
- Ručna otprema za **pretprodaju** — direktno na odabrani PP zapis, bez FIFO, ispravno
- FIFO raspodjela **unutar jednog reda** (jedna otprema preko više dispozicija) — ispravno, potvrđeno na produkcijskim podacima
- Zaštita od duplog sync-a preko `sheet_key` (uklj. split-ključeve `_dXXX`)
- PP routing preko ODJEL kolone; regularni kupci se ne guraju u PP (`if (!ppEntry) continue`)
- Storniranje otpreme vraća balans (dok dispozicija postoji)
- Nedjelja isključena kao default datum
- Raspored: autoSuggest (najstarija ≥20 m³) i raspDispInfo (FIFO za kupca) konzistentni s logikom otpreme

---

## 🔴 KRITIČNO

### BUG #1: Dupla FIFO raspodjela kad isti kupac ima više redova u istom sync-u
**Lokacija:** `doSync()`, ~linija 2323 — `const batchSpent = {}` je deklarisan **unutar** petlje `for (const row of rows)`.

Kad jedan sync obuhvati više redova (npr. dva dana odjednom, ili dva kamiona istog kupca isti dan), svaki red vidi **isto početno stanje** dispozicije — jer se lokalni `otpreme` niz ne ažurira dok traje petlja (batch se commituje tek poslije), a `batchSpent` se resetuje za svaki red. Rezultat: dva reda uzmu istu preostalu količinu iz iste dispozicije → dispozicija ode u minus za taj iznos, a višak se ne prelije na sljedeću dispoziciju.

**Dokaz iz produkcije (ASIKS):** otpreme `sh_1778493362129_003a` (07.05., tc=21,53) i `sh_1778493362130_n3aa` (08.05., tc=21,53) — kreirane u istom sync-u (timestampovi razmaknuti 1 ms), obje uzele **identičnih 21,53 m³** (= tačno cijeli preostali saldo) iz iste dispozicije `d1776146342572`, koja je time otišla −21,53 u minus. Ostaci (13,62 i 15,28) ispravno preliveni na sljedeću.

**Posljedica:** kad se preplaćena dispozicija kasnije obriše/arhivira (isReplaced), njen minus "nestane" → ukupno stanje kupca u aplikaciji postane veće od stvarnog.

**Ispravka:** premjestiti `const batchSpent = {}` **iznad** petlje `for (const row of rows)` (jedan objekat za cijeli sync run), tako da svaki sljedeći red vidi šta su prethodni redovi već zauzeli.

---

## 🟠 VISOK PRIORITET

### BUG #2: Auto-brisanje dispozicije može obrisati dispoziciju koja još ima robe u drugom sortimentu
**Lokacija:** `confirmOtprema()`, ~linije 1628–1634.

```js
const remainingTotal = FIELDS.reduce((s, f) => s + r2((preBal[f]||0) - (qtys[f]||0)), 0);
if (remainingTotal <= 0) await fbDelDisp(disp_id);
```

Zbir preko SVIH polja: ako je npr. `tc` u minusu −30 a `tl` ima +20, ukupno je −10 → dispozicija se **briše iako u `tl` ima još 20 m³**. Minus u jednom sortimentu "pojede" plus u drugom.

**Ispravka:** brisati samo ako je **svako pokriveno polje** ≤ 0:
```js
const allSpent = FIELDS.every(f => r2((preBal[f]||0) - (qtys[f]||0)) <= 0.005 || !(preBal[f] > 0 || qtys[f] > 0));
```
(ili jednostavno: `FIELDS.every(f => r2((preBal[f]||0) - (qtys[f]||0)) <= 0)`)

### BUG #3: Redovi sa isključivo PP-klasa kolonama se preskaču u sync-u
**Lokacija:** `doSync()`, ~linija 2295–2296.

```js
const totalQty = FIELDS.reduce((s,f) => s + qtyRow[f], 0);
if (totalQty === 0) continue;   // ← preskače i PP auto-detect blok ispod!
```

Ako red iz sheeta ima količine SAMO u pretprodajnim kolonama (F/L, I, II, III, ŠKART, I L…), a ODJEL nije prepoznat kao PP odjel, `totalQty` regularnih kolona je 0 → `continue` se izvrši **prije** "AUTO-PREPOZNAJ PP KOLONE" bloka (~linija 2365) → te otpreme se tiho gube.

**Ispravka:** pomjeriti PP auto-detect blok iznad `if (totalQty === 0) continue;` ili promijeniti uslov da preskoči samo regularni routing, ne cijeli red.

---

## 🟡 SREDNJI PRIORITET

### BUG #4: Storniranje ne može vratiti auto-obrisanu dispoziciju
**Lokacija:** `deleteOtp()` ~linija 2022; poruka *"Dispozicija će biti vraćena"*.

Kad se dispozicija auto-obriše (BUG #2 mehanizam ili isReplaced arhiviranje), otpreme ostaju sa `disp_id` koji više ne postoji. Storniranje takve otpreme NE vraća dispoziciju — poruka je netačna, a m³ se ne vraća nigdje. Preporuka: prije brisanja provjeri postoji li disp; ako ne postoji, upozori korisnika drugačijom porukom.

### BUG #5: Fuzzy matching kupaca po `includes()` može spojiti pogrešne kupce
**Lokacija:** `confirmOtprema()` ~linija 1590 i `doSync()` ~linije 2305–2308.

```js
dk === ku || dk.includes(ku) || ku.includes(dk)
```

Kupac "BOR" (postoji u bazi!) će se poklopiti sa bilo kojim kupcem čije ime **sadrži** "BOR" (npr. "BOROVI", "BORAC"...). Otprema kupca X može FIFO-m povući dispozicije kupca Y. Trenutno u bazi nema takvih parova, ali svaki novi kupac s podstringom postojećeg imena aktivira problem. Preporuka: koristiti samo tačno poklapanje, ili `includes` dozvoliti tek za imena duža od npr. 5 znakova.

### BUG #6: Nekonzistentnost datumskog filtera u FIFO
`doSync()` isključuje dispozicije novije od datuma otpreme (`.filter(d => !d.datum || d.datum <= datum)`, linija 2309), a `confirmOtprema()` (ručna otprema) **nema** taj filter — ručna otprema za prošli datum može povući dispoziciju koja tada još nije postojala. Uskladiti (dodati isti filter u confirmOtprema).

---

## 🟢 NIZAK PRIORITET / NAPOMENE

### #7: Ručna otprema dozvoljava budući datum
Sync brani budući datum ("Datum ne može biti u budućnosti"), a ručni unos ne. `getBalance` ignorira buduće otpreme do tog dana — pregled se "ne mrda" nakon unosa, što zbunjuje. Dodati istu validaciju u `submitOtprema`.

### #8: Korisnik u ručnoj otpremi bira konkretnu dispoziciju, a FIFO je ignorira
`submitOtprema` traži odabir dispozicije i upozorava na prekoračenje **za tu** dispoziciju, ali `confirmOtprema` (regularni put) preraspodijeli količine FIFO preko SVIH dispozicija kupca. Odabir dispozicije efektivno služi samo za prikaz raspoloživog. Kozmetički — ali UI obećava ponašanje koje se ne dešava.

### #9: "Stanje" u Historiji otprema je netačno kroz vrijeme
`getBalanceAtDate()` (~linija 1926): originale sabira samo iz **trenutnih** dispozicija, a potrošnju iz **svih** otprema (uključujući one čije su dispozicije obrisane/arhivirane) → "Stanje" na početku dana je potcijenjeno čim se bilo šta arhivira.

### #10: Identične duple stavke istog dana se tiho preskaču
Dedup ključ za regularne redove je `sheet_${datum}_${kupac}_${količine}` — dva stvarno različita kamiona s identičnim količinama do 0,01 m³ isti dan → drugi se preskoči kao "duplikat". Malo vjerovatno, ali moguće; razmisliti o dodavanju rednog broja reda u ključ.

### #11: Brisanje cijelog odjela ostavlja "viseće" PP otpreme
`deleteWholeOdjel()` briše PP zapise, ali otpreme koje pokazuju na njih ostaju s nepostojećim `disp_id` → gube PP badge i filter "Samo pretprodaja" ih više ne prikazuje. Balansi netaknuti (ispravno), samo higijena prikaza.

### #12: Mrtav kod
`isRecentlyExhausted()` (linija 1133) — definisana, nigdje se ne poziva.

---

## Preporučeni redoslijed ispravki

1. **BUG #1** (batchSpent van petlje) — jedna linija, sprječava buduće minuse
2. **BUG #2** (auto-brisanje po poljima umjesto zbira) — sprječava gubitak robe
3. **BUG #3** (PP auto-detect prije totalQty continue) — sprječava tihi gubitak PP otprema
4. Ostalo po prilici

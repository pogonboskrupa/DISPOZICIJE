# Pregled koda — bugovi i preporuke

> ## ✅ STATUS: SVIH 5 NALAZA RIJEŠENO — 16.07.2026.
> - **#1** `doSync()` sada poziva `transferDebtAndCleanup()` na kraju (uz kratku pauzu da realtime listener stigne osvježiti `otpreme` prije računanja salda)
> - **#2** `kupacMatch()` sada korišten dosljedno u `isReplaced()` i u odabiru ciljne dispozicije u `transferDebtAndCleanup()` (ranije strogo `===`, sad isti fuzzy match kao FIFO)
> - **#3** `getBalance`/`balStatus`/`isReplaced`/`isZeroedOut` dobili opcioni `cache` (Map) parametar — `renderPregled()` ga koristi (O(n²) → O(n+m) unutar jednog rendera); svi ostali pozivi bez cache parametra rade identično kao prije (bez rizika za `transferDebtAndCleanup`)
> - **#4** Globalni Firestore-transakcijski lock (`meta/cleanup` dokument + `runTransaction`) sprječava da dva uređaja istovremeno pokrenu dnevni cleanup
> - **#5** Dugme "↩ Vrati u aktivne" u tabu Potrošene dispozicije (`restoreDisp()`) — upozorava ako je dug već prenesen na drugu dispoziciju

**Datum:** 16.07.2026. · **Fajl:** index.html (3251 linija)
**Obuhvaćeno:** FIFO otprema (ručna + sync), balansi, prijenos duga, cleanup nuliranih/iscrpljenih, render pregleda, brisanje, tab Potrošene dispozicije.

---

## 🔴 VISOK PRIORITET

### #1 — Sinkronizacija ("Dodaj otpremu") NE pokreće cleanup
`doSync()` (linija ~2596) nakon upisa otprema **ne poziva** `transferDebtAndCleanup()` ni brisanje nuliranih. Posljedica: nakon sync-a (a to je **glavna dnevna akcija**), dispozicije koje su nulirane ili trebaju prijenos duga ostaju "visjeti" sve do:
- sljedećeg ručnog dodavanja/izmjene dispozicije, ili
- dnevnog auto-cleanup-a u 06:00 (a i to samo ako je app otvorena na nekom uređaju).

Za razliku, `confirmOtprema()` (ručna otprema) radi cleanup odmah inline. **Nekonzistentno.**

**Preporuka:** na kraju `doSync()` (nakon `batch.commit()`) dodati `await transferDebtAndCleanup();`.

### #2 — Nedosljedno poklapanje imena kupaca (fuzzy vs strogo)
- FIFO raspodjela: `kupacMatch()` (fuzzy — podstring za imena ≥5 znakova) — u `confirmOtprema` i `doSync`.
- `isReplaced()` i odabir cilja u `transferDebtAndCleanup()`: **strogo** `other.kupac === disp.kupac`.

Posljedica: kupac s malom varijacijom imena (npr. "SANI GLOBAL" vs "SANI GLOBAL DOO") može FIFO-m dobiti otpremu na obje dispozicije, ali kad jedna ode u minus, prijenos duga/zamjena je **neće prepoznati** → dispozicija zaglavi u minusu, ili se dug nikad ne prenese.

**Preporuka:** koristiti `kupacMatch()` i u `isReplaced()` i u odabiru `target` u `transferDebtAndCleanup()` (uskladiti sve četiri tačke).

---

## 🟠 SREDNJI PRIORITET

### #3 — Performanse: `renderPregled` je O(n² × m)
Za svaku dispoziciju poziva `balStatus()` + `isReplaced()`, a `isReplaced()` iznova skenira sve dispozicije i za svaku zove `getBalance()` (koja filtrira cijeli `otpreme` niz). Sa ~98 dispozicija i ~1200 otprema ≈ **milioni operacija po renderu**, a render se okida na **svaki** realtime snapshot (4 kolekcije). Na mobitelu → primjetan lag.

**Preporuka:** izračunati `spentByDisp` mapu jednom po renderu (jedan prolaz kroz `otpreme`) i `getBalance` da čita iz nje; ili memoizirati `getBalance`/`isReplaced` unutar jednog rendera.

### #4 — Race kod cleanup-a (više uređaja)
`transferDebtAndCleanup()` nema transakciju/lock. Dva uređaja koja ujutro (poslije 06:00) skoro istovremeno pokrenu `autoCleanupExhaustedDisps()` mogu **duplo upisati** 'adjustment' otpremu (dupli prijenos duga) prije nego brisanje propagira. `localStorage` guard je per-uređaj, ne štiti između uređaja.

**Preporuka:** globalni lock u Firestore-u — npr. `meta/cleanup` dokument s poljem `lastRunDate`; prije cleanup-a pročitati i preskočiti ako je već odrađeno danas (idealno kroz `runTransaction`).

### #5 — Storniranje ne može vratiti arhiviranu dispoziciju
`deleteOtp()` ispravno upozorava kad povezana dispozicija ne postoji, ali nema načina da se vrati. Ako je otprema greškom, a dispozicija je već arhivirana/obrisana, količina se trajno gubi.

**Preporuka:** dugme "↩ Vrati u aktivne" u tabu "Potrošene dispozicije" (kopira iz `arhiva_dispozicija` nazad u `dispozicije`, briše iz arhive).

---

## 🟢 NIZAK PRIORITET / higijena

### #6 — Nulirane ostaju vidljive kao "≈ Iscrpljeno" do cleanup-a
`renderPregled` skriva `isReplaced(d)` ali **ne** `isZeroedOut(d)`. Nulirana dispozicija se prikazuje kao "done" dok je cleanup ne obriše. Vezano za #1 — kad se #1 riješi, nestat će odmah nakon sync-a.

### #7 — `balStatus` koristi ZBIR preko svih sortimenata
Dispozicija s +10 u jednom i −10 u drugom sortimentu daje `rem=0` → chip "≈ Iscrpljeno", iako jedan sortiment ima robe a drugi je u minusu. Ćelije po sortimentu su tačno obojene, samo je zbirni chip zavaravajući. (Postojeći dizajn, rijedak slučaj.)

### #8 — Mala vjerovatnoća kolizije ID-a
`sh_${Date.now()}_${rand4}` — 4-znakovni random (~1.6M kombinacija). Kod batcha od stotina dokumenata u istoj milisekundi teoretski moguća kolizija → tihi overwrite. **Preporuka:** produžiti random na 8 znakova ili dodati globalni brojač.

### #9 — `arhiva` čišćenje (>10 dana) samo u dnevnom cleanup-u
Ako se app rijetko otvara, stari arhivski zapisi se gomilaju u bazi (ne prikazuju se jer render filtrira 10 dana, ali ostaju u Firestore-u). Bezopasno za prikaz, samo raste kolekcija.

---

## ✅ Što je provjereno i radi ispravno
- FIFO raspodjela unutar jednog sync runa (`syncSpent` fix) — nema duplog uzimanja.
- Prijenos duga na zamjensku dispoziciju + `localAdj` zaštita od duplog prijenosa u istom pozivu.
- `isZeroedOut` vs `isReplaced` razdvajanje (nulirano briše odmah, minus čeka pokriće) — potvrđeno.
- PP routing preko ODJEL kolone + auto-detekcija PP klasa prije `totalQty` provjere.
- `kupacMatch` sprječava "BOR" da se poklopi sa svim imenima koja ga sadrže.
- Dedup sync-a preko `sheet_key` + `uniqueKey` za stvarne duplikate.
- Datumski filter (nema budućih otprema/dispozicija).
- Tab poravnanje (7 tabova/panela/TAB_NAMES).

---

## Preporučeni redoslijed
1. **#1** — jedna linija, najveći uticaj (cleanup poslije sync-a)
2. **#2** — uskladiti `kupacMatch` svugdje (tačnost balansa)
3. **#3** — memoizacija (performanse na mobitelu)
4. **#4, #5** — po prilici

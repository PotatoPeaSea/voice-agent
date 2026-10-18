# Canon Selphy ribbon tear / media tangled in rollers — research notes

Researched 2026-10-04. Scenario reported by user: printing several photos with more than one
print job in progress/queued at the same time; one job finished while others were still
running; the ink ribbon and/or paper tore and got tangled in the printer's internal rollers.

## 1. Summary

**Partially documented.** Canon's official docs and the Canon Community forum confirm that
paper jams, "ink sheet"/ribbon looseness, and media (paper or dye-sub film) getting stuck on
the internal rollers are known, recurring failure modes on Selphy compact printers (CP1200/
CP1300/CP1500/CP910/CP780/ES1, etc.). What is **not** documented anywhere official is a specific
causal link between "printing multiple queued jobs at once" and ribbon tearing. The closest
official statement I found is that the CP1500 manual explicitly says the printer **cannot**
run two jobs at once — "Printing is not possible when the printer is already printing a job
from another device" — implying jobs are supposed to be serialized by the printer/driver, not
genuinely concurrent. I found no Canon source describing what happens if a second copy/job is
sent while the ribbon advances mid-sheet, and no community report that names "multiple queued
jobs" as the confirmed root cause of a ribbon tear. The user's hypothesis is plausible but
unconfirmed by any primary source — see Section 5.

## 2. Known failure modes — what's documented

From the official Canon CP1500 product manual troubleshooting page and Canon Community threads:

- **Paper jams** are a named, dedicated troubleshooting entry ("Paper jams"; also "Paper feed
  problems or frequent paper jams occur") in the official Selphy CP1500 manual.
  Guidance: "If paper protrudes from the front or back paper ejection slot, carefully pull it
  out." If that doesn't work, cycle power repeatedly until the paper ejects. Explicit warning:
  **"Do not attempt to remove jammed paper by force, which may damage the printer."** Contact
  support if the jam persists.
  Source: https://cam.start.canon/en/P001/manual/html/UG-07_Reference_0020.html
- **Ink sheet (ribbon) looseness** is called out as a cause of print failure/jam risk: the
  manual's remedy is "if the ink sheet is loose, turn the sprocket gently to tighten it" before
  use. Community/repair sources repeat this as standard preventive advice for CP1200/CP1300/
  CP1500/KP-108IN cassettes.
  Source: https://cam.start.canon/en/P001/manual/html/UG-07_Reference_0020.html (manual);
  similar guidance echoed in third-party ink/paper-set listings.
- **Ribbon ("color film") physically stuck on an internal roller** is a reported failure on the
  CP1300: a user described the display showing a paper-jam message, and on removing the ink
  cassette found ink-ribbon residue/film stuck at the roller. Canon Community's response was
  that this generally requires sending the unit in for service, not a user-serviceable fix.
  Source: https://community.usa.canon.com/t5/Desktop-Inkjet-Printers/CP1300-jam-ink-color-film-stuck-at-roller/m-p/344434
- **Ribbon tearing/shredding on install or during use** has been reported for other Selphy
  models (e.g., a CP1200 cassette where the ribbon reportedly shredded on installation) with a
  community/hobbyist repair writeup describing manually cutting and re-splicing the ribbon with
  tape — explicitly framed as a workaround, not an official fix.
  Source: https://saturdayxiii.github.io/2021/12/08/canon-selphy-ink-ribbon-repair/ (third-party,
  not Canon)
- **General roller contamination/wear** (ink residue, dust, worn rubber) is the most frequently
  cited root cause across Canon Community "paper jam"/"paper feed jamming" threads for CP1300,
  independent of how many jobs were queued — the fix in several threads was cleaning the three
  rubber feed rollers with isopropyl alcohol on a cotton swab.
  Source: https://community.usa.canon.com/t5/Mobile-Compact-Printers/CP1300-Paper-Feed-Jamming/td-p/321843

## 3. Official Canon guidance — pages and exact wording found

- **Official CP1500 manual, Troubleshooting chapter** —
  https://cam.start.canon/en/P001/manual/html/UG-07_Reference_0020.html
  Relevant headings present verbatim on this page: "Cannot print," "Paper does not fit in the
  cassette," "Paper feed problems or frequent paper jams occur," "Cannot print the correct
  quantity (unused paper left after ink runs out)," "Paper jams."
  Key exact quotes:
  - "If paper protrudes from the front or back paper ejection slot, carefully pull it out."
  - "Do not attempt to remove jammed paper by force, which may damage the printer."
  - "Replace the ink cassette and refill the paper cassette as needed."
  - "Printing is not possible when the printer is already printing a job from another device,
    or when the printer is connected to a camera."
  - No numbered/lettered error codes (e.g., "E05," "211," "212") appear in this manual page —
    the CP1500 troubleshooting chapter speaks only in plain-language symptoms, not error codes.
- **Official CP1500 manual, Loading the Ink Cassette** —
  https://cam.start.canon/en/P001/manual/html/UG-01_Preparations_0020.html (identified via
  search; not independently re-fetched in full, so treat the "tighten the sprocket if ink
  sheet is loose" instruction as manual-sourced per the troubleshooting page and corroborating
  secondary summaries, not a verbatim quote from this specific sub-page).
- **Canon USA Knowledge Base, "Fix a Paper Jam in a SELPHY ES1 Printer"** —
  https://support.usa.canon.com/kb/s/article/ART150805
  This is an older Selphy model (ES1, not CP1300/CP1500), but it is an official Canon KB article
  dedicated specifically to clearing paper jams. Per search-result summary (the live page
  requires JavaScript and could not be fully rendered via automated fetch, so this is reported
  as a search-engine summary of the official page, not a verified direct quote): steps include
  powering off and unplugging the printer, removing the cover below the paper-handling slot, and
  slowly removing the paper "to avoid tears" before reattaching the cover. This is the one place
  I found an official Canon source explicitly naming **tearing** as a risk to avoid during jam
  removal — but it is about removing a jam carefully, not about ribbon tearing being caused by
  concurrent jobs.
  Source: https://support.usa.canon.com/kb/s/article/ART150805
- **"211 / 212" error codes**: these specific numeric codes for "paper jam in cassette" on the
  CP1300 appear in a third-party troubleshooting site (whizz-tech.com), **not** in anything I
  could independently confirm on an official Canon page. Flagging this as unverified against a
  primary Canon source — treat 211/212 as a community/third-party-reported code, not confirmed
  Canon documentation.
  Source (unverified against Canon primary): https://whizz-tech.com/support/canon-selphy-211-212-paper-jam-in-cassette/
- I found **no official Canon error code or support page specifically named "ribbon error" or
  "ribbon tear"** for the CP1300/CP1500. Canon's own troubleshooting language stays at the
  level of "paper jams" and "ink sheet is loose," not a distinct ribbon-tear error state.

## 4. Community reports

- Canon Community forum (official Canon-hosted but user-generated) has multiple CP1300/CP1500
  threads about jams and ink/ribbon sticking to rollers:
  - "CP1300 jam - ink(color film) stuck at roller" — ribbon film physically stuck on a roller
    after a paper-jam message; Canon support directed the user toward a service request rather
    than a self-fix.
    https://community.usa.canon.com/t5/Desktop-Inkjet-Printers/CP1300-jam-ink-color-film-stuck-at-roller/m-p/344434
  - "CP1300 ink jammed, won't print. Trying everything." — described as both a paper and ink
    jam occurring after prints were left sitting in the printer; user eventually had to
    disassemble and reassemble the unit.
    https://community.usa.canon.com/t5/Mobile-Compact-Printers/CP1300-ink-jammed-won-t-print-Trying-everything/td-p/598773
  - "Solved: CP1300 Paper Feed Jamming" — root cause found was dirty/worn rubber feed rollers,
    fixed by cleaning with isopropyl alcohol; not related to queuing.
    https://community.usa.canon.com/t5/Mobile-Compact-Printers/CP1300-Paper-Feed-Jamming/td-p/321843
  - "Canon Selphy CP 1300 - paper jam after print" — a jam occurring right after a completed
    print; discussion did not establish multiple-job queuing as a cause.
    https://community.usa.canon.com/t5/Mobile-Compact-Printers/Canon-Selphy-CP-1300-paper-jam-after-print/m-p/471035
  - "SELPHY CP1300 Driver Issues, Error Messages, and Paper Jams" — general driver/error/jam
    complaints; no queuing-specific mechanism identified in the summary available to me.
    https://community.usa.canon.com/t5/Mobile-Compact-Printers/SELPHY-CP1300-Driver-Issues-Error-Messages-and-Paper-Jams/m-p/405937
  (Note: several of the above community pages returned HTTP 401 to the automated fetch tool —
  likely because the forum requires a session/login to render full thread content server-side.
  The summaries above come from search-engine result snippets, not a full verified fetch of the
  thread text. Treat them as directionally accurate but not word-for-word verified.)
- A hobbyist repair blog (not Canon, not a forum) describes a CP1200 ink ribbon shredding on
  installation and being manually spliced with tape as a repair — illustrates that the ribbon
  is a thin consumable film that can physically tear, but this was on install, not mid-multi-job
  printing.
  https://saturdayxiii.github.io/2021/12/08/canon-selphy-ink-ribbon-repair/
- **I found no Reddit, photography-forum, or YouTube-comment report that specifically names
  "multiple queued print jobs" or "printing several copies back-to-back" as the trigger for a
  ribbon tear.** Despite targeted searches for this exact combination, nothing surfaced tying
  the two together. This is a real gap, not an oversight — I'm flagging it per your instructions
  rather than inventing a mechanism.

## 5. Likely cause — labeled as inference

No source I found directly confirms that overlapping/queued jobs cause ribbon tears. Based on
how Selphy dye-sub printers generally work (documented in the official manual) plus the
community reports above, here is my best-supported **hypothesis, not a confirmed fact**:

- Selphy printers use a single CMY(+coat) ribbon per sheet; the ribbon advances in sync with the
  paper through a fixed mechanical sequence per print, and the manual explicitly states the
  printer is not supposed to run two jobs concurrently ("Printing is not possible when the
  printer is already printing a job from another device"). This suggests jobs are meant to be
  strictly serialized by firmware.
- If a second job's data/command reached the printer while it was still mid-cycle on a prior
  sheet (e.g., due to a driver/queue race condition, a flaky Wi-Fi/USB connection, or the
  printer being told to eject/reset while the ribbon was still partway through a thermal pass),
  it's mechanically plausible that the ribbon or paper could be pulled or advanced out of its
  expected position, catching on a feed roller and tearing — consistent with the independent
  community reports of ribbon film physically stuck on a roller after a jam message. But none
  of my sources demonstrate this chain of events happening because of queued/multiple jobs
  specifically; it is equally consistent with the far more commonly documented cause (dirty/worn
  rollers, loose ribbon, debris) that has nothing to do with job queuing.
- **Bottom line (inference):** the user's queuing scenario is a plausible contributing/trigger
  condition, but it is not established as *the* documented cause. Ordinary roller contamination
  or ribbon slack — both well documented — are at least as likely, and possibly more likely,
  explanations for the tear in isolation.

## 6. Recommended fix / recovery steps

Based on the official manual's jam-removal instructions and the recurring Canon Community
guidance:

1. **Power off and unplug the printer immediately.** Do not keep attempting to print or force
   the mechanism — the official manual explicitly warns "Do not attempt to remove jammed paper
   by force, which may damage the printer" (CP1500 manual).
2. **Open the ink cassette/paper cassette doors and remove both cassettes** so you can see into
   the feed path without the ribbon or paper under tension.
3. **Gently pull any protruding paper straight out** in the direction it was already traveling
   (toward the ejection slot if it's partway out); the manual's own instruction is "carefully
   pull it out," and the ES1 jam KB article specifically warns to go slowly "to avoid tears" —
   i.e., the official advice itself assumes slow/gentle motion prevents further tearing, implying
   yanking is what causes it.
4. **If paper or torn ribbon film is wrapped around an internal roller** (as in the Canon
   Community "ink (color film) stuck at roller" case) rather than just sitting in the output
   path, be cautious: that user's thread indicates Canon's own support response was to recommend
   sending the unit in for service rather than user disassembly, implying there isn't an
   official user-level procedure for unwinding film from internal rollers. Community members in
   other threads did go further themselves (partial disassembly, cotton swab + isopropyl alcohol
   on the three visible rubber feed rollers) and reported success, but that is a self-repair
   route Canon does not officially endorse — proceed at your own risk and expect it may void
   warranty if the unit is still under one.
5. **Cycle power** (turn off/on, or hold the power button ~10 seconds per community
   troubleshooting) after removing visible obstructions — several CP1300 threads report this
   clears a lingering "jam" status once the mechanical obstruction is actually gone.
6. **Ink cassette replacement: yes, replace it; do not try to reuse a torn cassette.** This is
   supported by multiple sources: Canon's own documentation states that reusing an *empty* ink
   cassette "may result in malfunction or damage to the printer," and search results on how the
   consumable is tracked indicate Selphy cassettes carry an embedded chip/counter so the printer
   tracks ribbon consumption — once a given ribbon segment is marked used (or the sequence is
   disrupted), reinserting it is reported to trigger an error and halt printing, even if ribbon
   material remains. Dye-sub ribbons are physically a single continuous film with the CMY(+coat)
   panels laid out in a fixed, pre-determined sequence for each sheet; a mid-ribbon tear
   misaligns that sequence for every subsequent sheet on the roll. Combined, this means a torn
   ribbon cassette should be treated as **not reusable/not repairable for reliable use** — plan
   to replace the whole ink/paper cassette set (Canon KP-108IN or the size-matched equivalent),
   even though at least one hobbyist blog describes manually splicing a torn ribbon with tape as
   a possible (unofficial, unsupported) workaround if you want to attempt a salvage rather than
   discard it outright.
   Sources: cassette-reuse warning — summarized from Canon product manual content located via
   https://cam.start.canon/en/P001/manual/html/UG-01_Preparations_0020.html and
   https://support.usa.canon.com/kb/s/article/ART180899 (the latter's full text could not be
   rendered by the automated fetch tool — JS-only page — so this is a search-summary citation,
   not a verified direct quote); ribbon-tracking-by-chip and tape-splice workaround — general
   search summary and https://saturdayxiii.github.io/2021/12/08/canon-selphy-ink-ribbon-repair/
   respectively. No single source combined all of these points, so this conclusion is a
   synthesis across sources rather than one direct citation — flagging that explicitly.
7. **Going forward, to reduce recurrence risk:** load a fresh/taut ribbon (the manual's own
   remedy for jam risk is "if the ink sheet is loose, turn the sprocket gently to tighten it"),
   keep the Selphy on a clean/flat surface away from obstructions, and avoid sending a new print
   job until the printer's display/status clearly shows it is idle and ready, rather than relying
   on the OS print queue to "stack" jobs — the official manual's statement that the printer
   rejects second jobs while busy suggests it expects jobs one at a time, even though I could not
   find an explicit Canon warning against queuing.

## Gaps / things I could not verify

- No official Canon source ties ribbon tearing directly to multiple queued/simultaneous jobs.
  This is the central gap relative to the user's framing and should not be treated as confirmed.
- Several Canon Community and support.usa.canon.com pages could not be fully rendered by the
  automated fetch tool (401 Unauthorized on community forum pages; JS-only loading shell on
  support.usa.canon.com KB pages). Where used, those sources are cited as search-engine-summary
  based, not as directly verified full-page fetches, and are flagged as such above.
- The "211/212" CP1300 error codes could not be confirmed against an official Canon page; treat
  as community/third-party-reported only.

## 7. Clearing torn ribbon film from the rollers

Researched 2026-10-04, specifically for the recovery/removal step itself (vs. the general causes
covered above). Findings below are labeled by source tier: **Official**, **Community**, or
**Unknown/no source found** — do not treat anything not explicitly tagged Official as Canon's
documented guidance.

### 7.1 Official Canon guidance on clearing jams — what it says and doesn't say

- **Official, but not Selphy-specific — generic Canon "do not touch" warning exists on other
  product lines.** Canon's inkjet/laser printer support pages (e.g.
  https://in.canon/en/support/8200530000 ) carry the explicit instruction: *"When opening the
  Rear Cover, do not touch the transport roller or other components inside the printer."* I could
  **not** confirm this exact sentence on a Selphy-specific page — the page I fetched it from is
  for a different (laser/inkjet) product line — so treat it as evidence of Canon's general house
  style/policy on roller contact, not a verified Selphy-specific quote. Apply the same caution
  (don't touch/rotate rollers by hand) to the Selphy as a prudent default even though I can't cite
  it on a CP1300/CP1500 page directly.
  Source: https://in.canon/en/support/8200530000
- **Official, Selphy-specific (CP1500 manual, already cited in Section 3 above) — re-confirmed
  verbatim on direct fetch:**
  - "If paper protrudes from the front or back paper ejection slot, carefully pull it out. If you
    cannot remove the paper by gently pulling it out, never force it out."
  - "Do not attempt to remove jammed paper by force, which may damage the printer."
  - Remedy for persistent jams is to cycle power repeatedly, then contact Canon support if it
    doesn't clear.
  - The manual's ink-sheet guidance is limited to the pre-print check ("Confirm that the ink sheet
    is not loose") — on direct fetch, I found **no Selphy-manual troubleshooting text at all for
    an already-torn or roller-wrapped ribbon**, and no instruction for powering off/unplugging
    specifically tied to ribbon (as opposed to paper) jams.
  Source: https://cam.start.canon/en/P001/manual/html/UG-07_Reference_0020.html
- **Official position on torn ribbon specifically: Canon does not publish a self-service removal
  procedure.** The only official Canon document I found that is actually about disassembling a
  Selphy to reach the internal mechanism — the CP1200 "Print Mechanism Replacement" repair
  guide — replaces the **entire print mechanism as a sealed unit** rather than describing how to
  reach in and clear ribbon film from an individual roller. It gives no steps for, and no warnings
  about, manually unwinding or cutting ribbon film from rollers, because that isn't the
  procedure it documents.
  Source: https://www.ifixit.com/Guide/Canon+Selphy+CP1200+Print+Mechanism+Replacement/120163
  **Conclusion: Canon's documented official position is full-unit service/repair, not a
  user-level "clear the torn ribbon from the roller" procedure.** I found no Canon manual, KB
  article, or support page that walks through manually removing torn ribbon film wound around an
  internal roller. This matches Section 2's finding that Canon Community support staff directed
  the CP1300 "film stuck at roller" poster toward service rather than a self-fix.

### 7.2 Community/forum reports of self-clearing torn ribbon

All items below are **community anecdote, not Canon-endorsed**, carried over/expanded from the
sources in Sections 2 and 4, plus new detail retrieved this pass:

- **CP1300, "ink (color film) stuck at roller"** (Canon Community) — original report of a
  paper-jam message that, on opening the cassette doors, turned out to be torn ribbon film
  physically wrapped on an internal roller rather than a paper jam. Canon's own response in that
  thread pointed toward sending the unit in for service rather than a documented self-repair step.
  Source: https://community.usa.canon.com/t5/Desktop-Inkjet-Printers/CP1300-jam-ink-color-film-stuck-at-roller/m-p/344434
  (Thread text not independently re-verifiable this pass — the Canon Community server returns
  HTTP 401 to automated fetch tools, same limitation noted in Section 4. Summary is carried from
  the prior research pass's search-snippet reading.)
- **CP1200/CP910-era hobbyist blog repair — the most detailed DIY procedure found, fetched and
  read directly this pass:**
  1. Power off and open the ink cassette; the torn ribbon pieces "rolled out from inside the
     printer easy enough."
  2. Pop open the ink cassette's plastic casing — the author did this with "a couple of pen
     pushes" against the casing's latch points (i.e., a thin flat tool like a pen tip or small
     screwdriver, not a tool Canon supplies or documents for this).
  3. Make a clean, straight cut across the torn ribbon, align the two ends, and splice them back
     together with tape (the author reused old tape already on the ribbon rather than applying
     fresh tape).
  4. Reassemble the cassette and reinsert it.
  **Outcome reported:** printing resumed, but the author noted the printer afterward "makes
  strange grinding noises only when it does the clear coat pass," i.e., a lingering mechanical
  symptom even though prints came out — explicitly flagged by the author as an open/unresolved
  issue, not a clean fix. No warnings about rollers specifically were given in this writeup; the
  splice happened inside the cassette, not by manipulating the printer's internal rollers by hand.
  Source: https://saturdayxiii.github.io/2021/12/08/canon-selphy-ink-ribbon-repair/
- **CP910, "two cartridges ruined" thread (Canon Community)** — per the prior pass's search
  summary (also 401-blocked on direct fetch this pass, so not independently re-verified): a
  reported workaround involved disassembling the cartridge and rolling a sheet or two of ribbon
  onto the take-up reel while carefully feeding the supply/take-up ribbon back under the metal
  roller, with an explicit caution to avoid losing the small springs on the ends of the ribbon
  spools during disassembly — implying the cartridge internals are spring-loaded and fiddly to
  reassemble correctly.
  Source: https://community.usa.canon.com/t5/Mobile-Compact-Printers/Cannon-Selphy-CP910-two-cartridges-ruined-help/td-p/397908
- **General pattern across justanswer.com "Expert Q&A" pages on CP1300/CP1200/CP910 roller
  cleaning and ink/jam fixes** (treat as low-confidence community-adjacent content — these are a
  paid Q&A site, not a forum of verified repair techs, and several pages returned HTTP 403/could
  not be fetched directly this pass, so this is a search-summary characterization, not a verified
  quote): recurring advice is to power off, remove the cassette, and clean the **paper feed
  rollers** (not the ribbon take-up mechanism) with a dry or isopropyl-alcohol-dampened lint-free
  cloth/cotton swab, and to avoid letting liquid drip into the mechanism. One such summary
  explicitly warned against prying the internal guides. None of these specifically describe
  unwinding torn ribbon film from a roller the ribbon itself is wrapped around (as opposed to dust
  on the paper rollers) — that specific repair is only documented in the hobbyist blog above.
  Sources (search-summary, not verified fetch): https://www.justanswer.com/printers/fd0ke-won-t-feed-cleaned-rollers-fingers-no.html ,
  https://whizz-tech.com/support/canon-selphy-211-212-paper-jam-in-cassette/
- **No Reddit or YouTube-specific report of clearing torn ribbon from rollers surfaced** in this
  pass's searches, despite targeted queries. This is consistent with Section 4's existing gap
  note — the DIY accounts that exist are concentrated on one hobbyist blog and a handful of
  Canon Community threads, not a broad base of video/forum how-tos.

### 7.3 Recommended recovery steps (synthesized, with source tier labeled per step)

1. **Power off and unplug the printer before touching anything inside it.** [Official — manual's
   jam guidance implies working on a de-energized printer; not an explicit "unplug" instruction
   for ribbon specifically, but consistent with the general-Canon roller warning in 7.1 and basic
   safety.]
2. **Open the ink cassette door and remove the cassette.** Look at whether the torn film is (a)
   loose debris that lifts out with the cassette, or (b) still wound around a fixed internal
   roller that stayed in the printer body when the cassette came out. This distinction matters:
   (a) is the "carefully pull it out" case the manual addresses for paper; (b) is the case Canon
   Community's own staff pointed toward service for. [Official for the jam-removal framing;
   Community for the roller-wrap distinction, Section 7.1/7.2.]
3. **Do not rotate, force, or pick at an internal transport/feed roller by hand.** No Selphy-
   specific Canon source documents this warning verbatim, but it mirrors Canon's documented
   general policy on other product lines ("do not touch the transport roller or other components
   inside the printer") and matches the manual's "never force it out" instruction for paper jams.
   [Official policy by analogy, not a verified Selphy-specific quote — flagged as such.]
4. **If loose torn film is sitting in the cassette bay or ejection path (not wrapped around a
   roller), gently remove it by hand**, pulling in the direction the film was already traveling,
   the same way the manual instructs for paper. [Official, by extension of the paper-jam
   instruction — Canon's ink-sheet guidance doesn't address this case directly.]
5. **If the torn film is wound around an internal roller and does not come free with the
   cassette, stop.** This is the point at which Canon's own documented response (CP1300 Community
   thread) was to recommend sending the unit in for service, and where Canon's only disassembly
   documentation found (the CP1200 print-mechanism guide) treats the mechanism as a sealed
   replace-the-whole-unit item rather than something to pick ribbon out of. Continuing past this
   point is self-repair that Canon does not document or endorse. [Official position: stop here
   and seek service. Everything past this point in this list is Community-only.]
6. **(Community-only, unendorsed) If you choose to proceed yourself anyway:** the only detailed
   account found is the hobbyist blog's cassette-splice method (Section 7.2) — open the ink
   cassette casing with a thin flat tool, cut the ribbon cleanly, align, and tape-splice it back
   together, then reinsert. This worked well enough to resume printing in that one case but left
   the reporter with an unresolved grinding noise on the clear-coat pass, i.e., a partial, not
   fully clean, fix. Treat this as evidence that recovery is *possible* in some cases, not that it
   reliably restores the printer to full working order. [Community, single-source, outcome
   explicitly imperfect even in the reporting itself.]
7. **Cycle power after any physical fix** to clear a lingering jam/error status once the
   obstruction is actually gone. [Community pattern, repeated across CP1300 threads per Section 4;
   no official Canon source ties this specifically to ribbon jams rather than paper jams.]

### 7.4 Ink cassette replacement and mid-print paper — no change from Section 6

Nothing found this pass changes Section 6's conclusions: **replace the ink cassette** after a
tear rather than reusing it (chip-tracked consumption plus fixed CMY(+coat) panel sequencing make
a mid-roll tear unreliable even if film remains), and paper mid-print at the moment of the tear
should be treated as unlikely to be salvageable for that same print job — no new source this pass
specifically addressed reusing partially-printed paper, so that remains an **unknown/unverified**
point, carried over from Section 6 rather than newly confirmed.

### 7.5 Signs the printer needs service rather than self-repair

- **Torn ribbon film wrapped around an internal roller that does not release when the cassette is
  removed** — this is the exact scenario Canon Community support treated as a service case
  (Section 7.2), and it's the point Section 7.3 step 5 flags as the stop/seek-service line.
- **Grinding, scraping, or unusual noise during the clear-coat pass after any self-repair** — the
  one detailed DIY account found reported exactly this symptom persisting after a splice repair,
  suggesting mechanical misalignment (not just a consumable issue) can outlast a ribbon-level fix.
  [Community, single source — treat as a cautionary signal, not a confirmed universal symptom of
  roller damage.]
- **Repeated jam/error status after visible obstructions are cleared and power has been cycled**
  — recurring in CP1300 Community threads (Section 4) as a sign the rollers themselves (dirt,
  wear) or a sensor, not just the ribbon, need attention — cleaning with isopropyl alcohol resolved
  this in some threads but not all.
- **No official Canon diagnostic checklist exists for "how do I know if my printer needs
  service" specific to ribbon tears.** Canon's own online service-estimate tooling was reported
  (search-summary, not independently verified) to quote roughly $109 to evaluate/repair a Selphy
  CP1300 jam — that figure is cited here as a data point on what "send it in" costs, not as an
  official published price, since I could not independently browse Canon's live service-quote
  tool to confirm it directly.

### 7.6 Summary table — official vs. community vs. unknown

| Question | Status |
|---|---|
| Official Canon procedure to clear a **paper** jam | **Official** — documented, quoted above and in Section 3 |
| Official Canon procedure to clear **torn ribbon film wrapped on a roller** | **Not documented** — Canon's documented response is service, not a self-clear procedure |
| "Do not touch the roller" warning on a Selphy-specific page | **Unverified for Selphy** — confirmed on other Canon product lines only |
| Community reports of people clearing ribbon from rollers themselves | **Community** — one detailed blog account (partial success, lingering noise); handful of forum threads pointing to service instead |
| Must the ink cassette be replaced after a tear | **Official-adjacent/synthesized** — yes, per Section 6 (chip tracking + fixed panel sequence); no single Canon source states this for the tear case explicitly |
| Is mid-print paper reusable after a tear | **Unknown** — no source found either way |
| Signs the printer needs service vs. self-repair | **Community-sourced heuristics only** — roller-wrapped film and post-repair grinding noise are the two concrete signals found; no official Canon diagnostic checklist exists |

import type { MatchPair } from "../game/game-mode";
import type { CompletedAnalysis } from "../processing/basketball-pipeline";
import { mergeParticipants } from "../session/participant-review";
export async function confirmMatch(analysis: CompletedAnalysis, thumbnails: Record<string, string>, signal?: AbortSignal): Promise<MatchPair | null> {
  if (signal?.aborted) return null;
  const dialog = document.createElement("dialog");
  dialog.style.cssText = "width:min(760px,92vw);max-height:90vh;padding:24px;border:1px solid #ddd;border-radius:16px;background:white;color:#20242a;font:16px system-ui;overflow:auto";
  dialog.className = "match-selection";
  const title = document.createElement("h2"); title.textContent = "Who was playing 1 on 1?";
  title.id = "match-selection-title"; dialog.setAttribute("aria-labelledby", title.id);
  const explanation = document.createElement("p"); explanation.textContent = "Choose the two competitors. Everyone’s tracking and events will be saved. Players left out of the match will not affect its score.";
  const cards = document.createElement("div"); cards.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px";
  const controls = document.createElement("div"); controls.style.cssText = "display:flex;gap:16px;flex-wrap:wrap;margin:20px 0";
  function select(label: string, parent: HTMLElement): HTMLSelectElement {
    const wrapper = document.createElement("label"); wrapper.textContent = `${label} `;
    const element = document.createElement("select"); element.style.cssText = "padding:8px;font:inherit;max-width:220px";
    wrapper.append(element); parent.append(wrapper); return element;
  }
  const a = select("Player A", controls), b = select("Player B", controls);
  const details = document.createElement("details"), summary = document.createElement("summary"); summary.textContent = "The same person has two participant IDs"; details.append(summary);
  const mergeText = document.createElement("p"); mergeText.textContent = "Only merge IDs you recognise as the same person. Their appearances must not overlap in time."; details.append(mergeText);
  const from = select("Merge", details), into = select("into", details);
  const mergeButton = document.createElement("button"); mergeButton.type = "button"; mergeButton.textContent = "Merge these IDs"; mergeButton.style.cssText = "padding:8px;margin:8px;font:inherit"; details.append(mergeButton);
  const notice = document.createElement("p"); notice.setAttribute("role", "status");
  const actions = document.createElement("div"); actions.style.cssText = "display:flex;justify-content:flex-end;gap:12px;margin-top:20px";
  const cancel = document.createElement("button"), save = document.createElement("button");
  cancel.textContent = "Discard session"; save.textContent = "Confirm players and save";
  for (const button of [cancel, save]) { button.type = "button"; button.style.cssText = "padding:12px 16px;font:inherit;border-radius:8px;cursor:pointer"; actions.append(button); }
  save.style.background = "#e44f16"; save.style.color = "white";
  dialog.append(title, explanation, cards, controls, details, notice, actions);
  let first = true;
  const refresh = () => {
    const ids = Object.keys(analysis.statistics.participants).map(Number).sort((x, y) => (analysis.statistics.participants[y].attempts - analysis.statistics.participants[x].attempts) || x - y);
    cards.replaceChildren();
    for (const id of ids) {
      const card = document.createElement("div"); card.style.cssText = "border:1px solid #ddd;border-radius:8px;padding:10px";
      if (thumbnails[id]) { const img = document.createElement("img"); img.src = thumbnails[id]; img.alt = `Participant ${id}`; img.width = 120; img.height = 160; img.style.objectFit = "contain"; card.append(img); }
      const name = document.createElement("strong"); name.textContent = `Participant ${id}`; name.style.display = "block";
      const stats = document.createElement("p"), counts = analysis.statistics.participants[id]; stats.textContent = `${counts.makes}/${counts.attempts} shots · ${counts.unresolved} unresolved`; card.append(name, stats); cards.append(card);
    }
    for (const selection of [a, b, from, into]) {
      const previous = selection.value; selection.replaceChildren(new Option("Not identified", ""));
      for (const id of ids) selection.add(new Option(`Participant ${id}`, String(id)));
      selection.value = ids.includes(Number(previous)) ? previous : "";
    }
    if (first) { a.value = ids[0] ? String(ids[0]) : ""; b.value = ids[1] ? String(ids[1]) : ""; first = false; }
    notice.textContent = `${analysis.statistics.unattributed.attempts} shot attempts have no identified player. These remain saved as unattributed.`;
    details.hidden = ids.length < 2;
  };
  mergeButton.onclick = () => {
    try { mergeParticipants(analysis, Number(from.value), Number(into.value)); if (!thumbnails[into.value] && thumbnails[from.value]) thumbnails[into.value] = thumbnails[from.value]; refresh(); }
    catch (error) { notice.textContent = error instanceof Error ? error.message : "Could not merge these participants"; }
  };
  refresh();
  const style = document.createElement("style"); style.textContent = MATCH_STYLE; dialog.append(style);
  document.body.append(dialog);
  return new Promise(resolve => {
    const complete = (pair: MatchPair | null) => { signal?.removeEventListener("abort", abort); dialog.close(); dialog.remove(); resolve(pair); };
    const abort = () => complete(null);
    cancel.onclick = abort; dialog.oncancel = event => { event.preventDefault(); abort(); };
    save.onclick = () => {
      const pair: MatchPair = [a.value ? Number(a.value) : null, b.value ? Number(b.value) : null];
      if (pair[0] !== null && pair[0] === pair[1]) { notice.textContent = "Choose a different participant for each player."; return; }
      complete(pair);
    };
    signal?.addEventListener("abort", abort, { once: true }); dialog.showModal();
  });
}

const MATCH_STYLE = `
.match-selection { width:min(760px,calc(100vw - 32px))!important; padding:30px!important; border:1px solid var(--border,#e7e8ea)!important; border-radius:30px!important; background:var(--surface,#fff)!important; color:var(--text,#101317)!important; font:inherit!important; box-shadow:0 24px 80px #10131730; }
.match-selection::backdrop { background:#10131770; backdrop-filter:blur(5px); }
.match-selection h2 { margin:0 0 12px; font-size:clamp(24px,4vw,32px); letter-spacing:-.035em; }
.match-selection p { color:var(--text-muted,#646b76); font-size:14px; line-height:1.6; }
.match-selection > div:first-of-type { gap:16px!important; margin-top:22px; }
.match-selection > div:first-of-type > div { background:var(--surface-warm,#fff7f0); border:1px solid var(--border,#e7e8ea)!important; border-radius:22px!important; padding:18px!important; text-align:center; }
.match-selection img { display:block; margin:0 auto 14px; border-radius:16px; background:var(--surface-muted,#f4f5f6); }
.match-selection strong { font-size:17px; }
.match-selection label { display:flex; flex:1; flex-direction:column; gap:8px; font-size:13px; font-weight:750; }
.match-selection select { width:100%; max-width:none!important; padding:12px 14px!important; border:1px solid var(--border,#e7e8ea); border-radius:14px; background:white; color:inherit; font-weight:600; }
.match-selection details { padding:16px; border-radius:16px; background:var(--surface-muted,#f4f5f6); }
.match-selection summary { cursor:pointer; font-size:14px; font-weight:650; }
.match-selection details label { margin-top:12px; }
.match-selection button { border:0; border-radius:999px!important; background:#eeebe8; color:var(--text,#101317); font-weight:800!important; padding:12px 20px!important; }
.match-selection > div:last-of-type button:last-child { background:var(--accent,#ff4f0a)!important; color:white!important; }
.match-selection button:hover { filter:brightness(.96); }
.match-selection :is(button,select,summary):focus-visible { outline:3px solid var(--accent,#ff4f0a); outline-offset:3px; }
@media(max-width:540px) { .match-selection { padding:22px!important; } .match-selection > div:last-of-type { flex-direction:column-reverse; } .match-selection button { width:100%; } }
`;

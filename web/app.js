// 語音記錄(網頁版):瀏覽器語音辨識 → 說完一句就換一行,記錄到記事紙。
// 可分次建立多份記錄(存在這台裝置的瀏覽器裡),也可以複製或下載成 .txt。
// __BUILD__ 會在 GitHub Actions 發布時換成這次的 commit 編號,讓瀏覽器每次發布都重新下載新檔案,不會吃到舊快取

const BUILD = "__BUILD__";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (new URLSearchParams(location.search).has("debug")) $("debugBox").hidden = false;

// 診斷紀錄:平常是隱藏的;網址後面加上 ?debug 才會在「設定」裡顯示,手機上沒有開發者工具時用來查問題
const T0 = Date.now();
const dbgLines = [];
function dbg(msg) {
  dbgLines.push(`${((Date.now() - T0) / 1000).toFixed(1)}s ${msg}`);
  if (dbgLines.length > 60) dbgLines.shift();
  $("debug").textContent = dbgLines.join("\n");
}

$("version").textContent = `版本:${BUILD.startsWith("__") ? "本機開發版" : BUILD}`;

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// 手機瀏覽器切到「電腦版網站」時,User-Agent 不再有 Android;主要輸入裝置是觸控(pointer: coarse)的也算手機
const isPhone = isIOS || /Android/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 0 && matchMedia("(pointer: coarse)").matches);
const KEY = { notes: "vi.notes.v1", cur: "vi.cur.v1", mode: "vi.mode.v1" };

const state = {
  notes: [],        // [{id, created, text}],依建立時間由舊到新
  curId: null,      // 目前顯示在記事紙上的那一份
  mode: "auto",     // "auto" 常開監聽 | "ptt" 按住說話(手機是點擊監聽)
  active: false,    // 常開監聽:已按「開始」,正在聆聽的連續流程
  epoch: 0,         // 每次停止就加一:舊的流程看到編號變了就自己結束,不會變成殭屍繼續跑
  rz: null,         // 常開監聽目前這一輪的辨識
  ptt: null,        // 按住說話進行中的 {rz, tap, startedAt, ...}
  prevEnded: null,  // 最近一次辨識結束的 Promise,新的辨識要等它
  lastEndAt: 0,     // 最近一次辨識結束的時間
  speakToken: 0,    // iPhone 朗讀:每次按「開始」或開始新的朗讀就加一,舊的朗讀看到編號變了就不念
  wake: null,
};

const pad = $("pad");

// ───────────── 畫面 ─────────────

function setStatus(text, kind = "idle") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}
const setHeard = (text) => ($("heard").textContent = text);

function showNotice(text) {
  $("notice").hidden = !text;
  $("notice").textContent = text || "";
}

function updateButtons() {
  const b = $("micBtn");
  if (state.mode === "ptt") {
    b.textContent = isPhone ? (state.ptt ? "停止" : "開始") : "按住說話";
    b.classList.toggle("on", !!state.ptt);
  } else {
    b.textContent = state.active ? "停止" : "開始";
    b.classList.toggle("on", state.active);
  }
}

function idleStatus() {
  if (state.mode === "ptt") setStatus(isPhone ? "按「開始」後說話" : "按住下方按鈕說話", "idle");
  else setStatus("尚未開始", "idle");
}

// ───────────── 記錄(多份)─────────────

const p2 = (n) => String(n).padStart(2, "0");
const titleOf = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const fileNameOf = (t) => `${titleOf(t).replace(" ", "_").replace(":", "")}.txt`;

function createNote() {
  const created = Date.now();
  return { id: String(created), created, text: "", draft: "", queue: [] };
}

const curNote = () => state.notes.find((n) => n.id === state.curId);

function saveNotes() {
  try {
    localStorage.setItem(KEY.notes, JSON.stringify(state.notes));
    localStorage.setItem(KEY.cur, state.curId);
  } catch {
    showNotice("無法儲存記錄(瀏覽器禁止儲存,或儲存空間已滿)。請先複製或下載目前的內容。");
  }
}

function loadNotes() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY.notes) || "[]");
    state.notes = list
      .filter((n) => n && typeof n.id === "string" && typeof n.created === "number" && typeof n.text === "string")
      .map((n) => ({
        id: n.id,
        created: n.created,
        text: n.text,
        draft: typeof n.draft === "string" ? n.draft : "",
        queue: Array.isArray(n.queue) ? n.queue.filter((s) => typeof s === "string") : [],
      }));
  } catch { /* 存檔壞了就當作沒有 */ }
  if (!state.notes.length) state.notes = [createNote()];
  const saved = localStorage.getItem(KEY.cur);
  state.curId = state.notes.some((n) => n.id === saved) ? saved : state.notes[state.notes.length - 1].id;
}

/** 選單:最新的在最上面,每項顯示時間和開頭幾個字,方便分辨。 */
function renderSelect() {
  const sel = $("noteSel");
  const opts = [...state.notes].reverse().map((n) => {
    const first = `${n.text}\n${n.draft}`.split("\n").find((l) => l.trim()) || "(空白)";
    return Object.assign(document.createElement("option"), {
      value: n.id,
      textContent: `${titleOf(n.created)}  ${first.length > 12 ? `${first.slice(0, 12)}…` : first}`,
    });
  });
  sel.replaceChildren(...opts);
  sel.value = state.curId;
}

/** 把目前這份記錄放到記事紙上。 */
function showCurrent() {
  pad.value = curNote().text;
  pad.scrollTop = pad.scrollHeight;
  renderDraft();
  saveNotes();
  renderSelect();
}

// 暫存欄:剛辨識到的那一句先放這裡,可以修改;按「增加」,或下一句進來時,才存進內文
const draft = $("draft");

function renderDraft() {
  draft.value = curNote().draft;
  updateDraftButtons();
  renderQueueHint();
}

function updateDraftButtons() {
  $("addBtn").disabled = !draft.value.trim();
  $("discardBtn").disabled = !draft.value.trim();
}

/** 排隊中的句子數量提示:你在暫存欄編輯時,新辨識到的句子先排隊,不會把你正在改的字換掉。 */
function renderQueueHint() {
  const n = curNote().queue.length;
  $("queueHint").hidden = !n;
  $("queueHint").textContent = n ? `還有 ${n} 句等你改完:按「增加」或點一下別處,就會進來` : "";
}

const isEditing = () => document.activeElement === draft && document.hasFocus(); // 切到別的程式時,不算正在編輯

/** 把這份記錄暫存欄的內容加到內文最後一行,並清空暫存欄。回傳加進去的那一行(沒有內容就是空字串)。 */
function commitDraft(note) {
  const line = note.draft.replace(/\s*\n\s*/g, " ").trim();
  note.draft = "";
  if (line) note.text = note.text && !note.text.endsWith("\n") ? `${note.text}\n${line}` : note.text + line;
  saveNotes();
  if (note.id === state.curId) {
    pad.value = note.text;
    pad.scrollTop = pad.scrollHeight;
    renderDraft();
  }
  renderSelect();
  return line;
}

/** 整句話只有「刪除」(辨識結果可能帶標點)才是語音指令;句子裡剛好有「刪除」兩個字不算。 */
const isDeleteCommand = (text) => /^[\s。,,.!!??、]*[刪删]除[\s。,,.!!??、]*$/.test(text);

/** 語音「刪除」:刪掉最近說的那一句 —— 有排隊中的就刪最後排的,否則清空暫存欄。內文已存的不動。 */
function deleteLatest(note) {
  if (note.queue.length) {
    const gone = note.queue.pop();
    saveNotes();
    if (note.id === state.curId) renderQueueHint();
    setHeard(`已刪除:${gone}`);
  } else if (note.draft.trim()) {
    const gone = note.draft.trim();
    note.draft = "";
    saveNotes();
    if (note.id === state.curId) renderDraft();
    renderSelect();
    setHeard(`已刪除:${gone}`);
  } else {
    setHeard("暫存欄是空的,沒有可以刪除的");
  }
}

/** 排隊的句子依序放進暫存欄:每放一句,前一句(沒按「增加」也一樣)先存進內文,最後一句留在暫存欄。 */
function drainQueue(note) {
  if (!note.queue.length) return;
  while (note.queue.length) {
    commitDraft(note);
    note.draft = note.queue.shift();
  }
  saveNotes();
  if (note.id === state.curId) renderDraft();
  renderSelect();
}

/** 這份記錄的暫存欄和排隊中的句子,全部存進內文(離開這份、複製、下載之前用)。 */
function flushNote(note) {
  drainQueue(note);
  commitDraft(note);
}

/** 辨識到的一句話,屬於「開始說話那一刻」的那份記錄(中途切換記錄也不會寫錯地方)。
 *  你正在暫存欄裡編輯時先排隊,等你按「增加」或離開欄位才進來;否則直接放進暫存欄。 */
function stageText(noteId, text) {
  const note = state.notes.find((n) => n.id === noteId);
  if (!note) return; // 那一份已經被刪除
  if (isDeleteCommand(text)) return deleteLatest(note);
  note.queue.push(text);
  saveNotes();
  if (note.id === state.curId && isEditing()) {
    renderQueueHint();
    setHeard(`已辨識(等你改完再放進暫存欄):${text}`);
    return;
  }
  drainQueue(note);
  setHeard(`已辨識:${text}`);
}

pad.addEventListener("input", () => { // 手動修改或鍵盤聽寫
  curNote().text = pad.value;
  saveNotes();
  renderSelect();
});

draft.addEventListener("input", () => { // 修改暫存欄
  curNote().draft = draft.value;
  updateDraftButtons();
  saveNotes();
});
draft.addEventListener("keydown", (e) => { // Enter = 增加(中文輸入法選字時的 Enter 不算)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    $("addBtn").click();
  }
});
// 按「增加」時不要讓暫存欄先失去焦點(失去焦點會讓排隊的句子先進來,蓋掉你剛改好的字)
$("addBtn").addEventListener("mousedown", (e) => e.preventDefault());
$("discardBtn").addEventListener("mousedown", (e) => e.preventDefault());
draft.addEventListener("blur", (e) => { // 離開暫存欄 = 改完了,排隊的句子進來
  if (e.relatedTarget === $("addBtn") || e.relatedTarget === $("discardBtn")) return;
  drainQueue(curNote());
});
$("addBtn").addEventListener("click", () => {
  const note = curNote();
  const added = commitDraft(note);
  draft.blur(); // 改完了:收起手機鍵盤,排隊的句子進來
  drainQueue(note);
  setHeard(added ? "已增加到內文" : "暫存欄是空的");
});
// 「刪除」:暫存欄的字整個丟掉(錯太多不想改),排隊中的句子接著進來
$("discardBtn").addEventListener("click", () => {
  const note = curNote();
  const gone = note.draft.trim();
  note.draft = "";
  saveNotes();
  renderDraft();
  renderSelect();
  draft.blur();
  drainQueue(note);
  setHeard(gone ? `已刪除:${gone}` : "暫存欄是空的");
});

$("noteSel").addEventListener("change", (e) => {
  const id = e.target.value; // 先記下選了哪一份:下面存內文時會重畫選單,選單的值會被蓋回舊的
  haltListening();
  flushNote(curNote()); // 離開這份之前,暫存欄和排隊的句子先存進內文
  state.curId = id;
  showCurrent();
  idleStatus();
});

$("newBtn").addEventListener("click", () => {
  if (!curNote().text.trim() && !curNote().draft.trim() && !curNote().queue.length) { setHeard("目前這份還是空白的,直接開始說話就可以"); return; }
  haltListening();
  flushNote(curNote());
  const note = createNote();
  state.notes.push(note);
  state.curId = note.id;
  showCurrent();
  idleStatus();
  setHeard("已新增一份記錄");
});

$("delBtn").addEventListener("click", () => {
  if (!confirm(`要刪除「${titleOf(curNote().created)}」這份記錄嗎?刪除後無法復原。`)) return;
  haltListening();
  state.notes = state.notes.filter((n) => n.id !== state.curId);
  if (!state.notes.length) state.notes.push(createNote());
  state.curId = state.notes[state.notes.length - 1].id;
  showCurrent();
  idleStatus();
  setHeard("已刪除");
});

$("clearBtn").addEventListener("click", () => {
  if (!curNote().text && !curNote().draft && !curNote().queue.length) return;
  if (!confirm("要清除這份記錄的全部內容嗎?清除後無法復原。")) return;
  curNote().text = "";
  curNote().draft = "";
  curNote().queue = [];
  showCurrent();
  setHeard("已清除");
});

$("copyBtn").addEventListener("click", async () => {
  flushNote(curNote()); // 暫存欄裡還沒按「增加」的那一句(和排隊中的句子)也一起複製
  const text = curNote().text;
  if (!text.trim()) { setHeard("目前沒有內容可以複製"); return; }
  try {
    await navigator.clipboard.writeText(text);
    setHeard("已複製到剪貼簿");
  } catch { // 沒有剪貼簿權限(例如非 HTTPS):選取全部文字,改用舊方法複製
    pad.focus();
    pad.setSelectionRange(0, pad.value.length);
    setHeard(document.execCommand?.("copy") ? "已複製到剪貼簿" : "無法自動複製,已選取全部文字,請長按後選「拷貝」");
  }
});

$("downloadBtn").addEventListener("click", () => {
  const note = curNote();
  flushNote(note); // 暫存欄裡還沒按「增加」的那一句(和排隊中的句子)也一起下載
  if (!note.text.trim()) { setHeard("目前沒有內容可以下載"); return; }
  const blob = new Blob([note.text.replace(/\n*$/, "\n")], { type: "text/plain;charset=utf-8" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: fileNameOf(note.created) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  setHeard(`已下載 ${a.download}`);
});

// ───────────── 語音辨識 ─────────────

function describeError(code, message = "") {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "沒有麥克風或語音辨識權限。請在瀏覽器網址列旁允許使用麥克風;iPhone 還要到 設定 > 一般 > 鍵盤 開啟「聽寫」。";
    case "audio-capture":
      return /muted/i.test(message)
        ? "麥克風被靜音或被其他功能佔用(例如 Siri、通話、聽寫、另一個正在錄音的網頁)。請先關閉那些功能,等幾秒再試;還是不行就重新整理網頁(或關掉分頁重開)。"
        : "找不到麥克風。";
    case "network": return "辨識服務連不上,請檢查網路後再試。";
    case "no-speech": return "沒有聽到說話聲,請靠近麥克風再試一次。";
    case "language-not-supported": return "這個瀏覽器不支援中文語音辨識。";
    default: return `辨識出錯(${code})。`;
  }
}

/**
 * 建立一次辨識。rz.done 會在結束時給出 {text, error, errorMessage, ms, cancelled, needTap}。
 * rz.noteId 是開始說話時所屬的記錄。rz.stop() 會讓已經聽到的內容照樣交出來(不會丟掉剛說的話)。
 */
function createRecognizer(continuous, onAudioStart) {
  // ?ios=reuse:iPhone 上整個網頁共用同一個辨識物件,不每次重新建立
  const r = isIOS && IOS_STRATEGY === "reuse" ? (sharedRec ??= new SR()) : new SR();
  r.lang = "zh-TW";
  if (isIOS) r.maxAlternatives = 3; // 和參考專案一致
  r.interimResults = true; // 結束時若沒有「最終」結果(iPhone 常見),就用最後一個暫時結果
  r.continuous = continuous;
  const rz = { rec: r, started: false, cancelled: false, noteId: state.curId };
  let results = [];
  let error = null;
  let errorMessage = "";
  const t0 = Date.now();
  let markEnded;
  let finish;
  rz.ended = new Promise((res) => { markEnded = res; });
  rz.done = new Promise((res) => { finish = res; });
  // 一次一句:取最後一段。持續收音(電腦按住說話)可能有好幾段,把各段接起來
  const textOf = () => {
    if (!results.length) return "";
    return (continuous ? results.map((x) => x[0].transcript).join("") : results[results.length - 1][0].transcript).trim();
  };
  r.onstart = () => dbg("辨識 start");
  r.onaudiostart = () => { dbg("辨識 audiostart(麥克風開始收音)"); onAudioStart?.(); };
  r.onspeechstart = () => dbg("辨識 speechstart(偵測到說話)");
  r.onsoundstart = () => dbg("辨識 soundstart(聽到聲音)");
  r.onspeechend = () => dbg("辨識 speechend");
  r.onaudioend = () => dbg("辨識 audioend(麥克風關閉)");
  r.onnomatch = () => dbg("辨識 nomatch");
  r.onresult = (e) => {
    results = [...e.results];
    const t = textOf();
    dbg(`辨識 result:${t}`);
    if (t) setHeard(`聽到:${t}`);
  };
  r.onerror = (e) => {
    error = e.error;
    errorMessage = e.message || "";
    dbg(`辨識 error:${e.error}${e.message ? `(${e.message})` : ""}`);
  };
  r.onend = () => {
    const ms = Date.now() - t0;
    dbg(`辨識 end(${ms} 毫秒,${textOf() ? "有結果" : "沒結果"})`);
    state.lastEndAt = Date.now();
    markEnded();
    finish({ text: textOf(), error, errorMessage, ms });
  };
  /** 先等上一次辨識完全結束(連續啟動太快,iPhone 會把新的一次直接靜音),再開始收音。 */
  rz.start = async () => {
    const prev = state.prevEnded;
    state.prevEnded = rz.ended;
    if (prev) await Promise.race([prev, sleep(1500)]);
    if (isIOS) await sleep(500);
    if (rz.cancelled) { // 等待期間已經被取消
      markEnded();
      finish({ text: "", ms: 0, cancelled: true });
      return;
    }
    rz.started = true;
    try { r.start(); } catch (err) {
      dbg(`start() 丟出例外:${err.name} ${err.message}`);
      markEnded();
      finish({ text: "", ms: 0, needTap: true });
    }
  };
  rz.stop = () => {
    if (!rz.started) { rz.cancelled = true; return; }
    try { r.stop(); } catch { /* 已結束 */ }
  };
  return rz;
}

// iPhone 收音的幾種處理方式,用網址參數 ?ios=… 切換,方便在手機上比較哪一種最穩:
//   (不加) = speak  和參考專案一樣:每次收音結束後把辨識到的句子念出來,下一次收音才不會被 iPhone 靜音
//   silent  每次收音前播一小段無聲音訊(試過,第二次之後常常沒反應)
//   beep    改播一聲很短的提示音(讓音訊系統真的切到播放再切回收音)
//   reuse   整個網頁共用同一個辨識物件
//   reload  每次收音結束後自動重新載入網頁(記錄都存在瀏覽器裡,不會遺失)
const IOS_STRATEGY = new URLSearchParams(location.search).get("ios") || "speak";
let sharedRec = null;
// iPhone 辨識完念什麼:預設把句子念出來;?say=ok 只念「好」(比較不吵,是否仍能讓下一次收音正常要實測)
const SAY = new URLSearchParams(location.search).get("say") || "full";
if (isIOS) dbg(`iOS 策略:${IOS_STRATEGY}`);

/** 產生一小段 wav:amp 為 0 就是無聲(只有檔頭和 0 值取樣),否則是 freq Hz 的短音。 */
const wavUrls = {};
function makeWavUrl(ms, freq = 0, amp = 0) {
  const rate = 16000;
  const n = Math.round((rate * ms) / 1000);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const fade = Math.min(1, i / 400, (n - i) / 400); // 頭尾淡入淡出,避免爆音
    v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * fade * 32767), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/**
 * iPhone 的 Safari 第二次收音時,常常「麥克風開了卻聽不到聲音」(音訊系統還停在上一次的收音狀態)。
 * 每次收音前,在點擊的當下先播一小段無聲音訊和無聲朗讀,讓它切回播放狀態,再開始收音。
 * 這個函式要在點擊的當下呼叫(iPhone 只允許使用者操作時開始播放)。回傳的 Promise 在播完(或逾時)後完成。
 */
function iosResetAudio() {
  state.speakToken++; // 作廢還在等著要念的上一句
  try {
    const u = new SpeechSynthesisUtterance("。");
    u.volume = 0;
    u.lang = "zh-TW";
    speechSynthesis?.speak(u); // 在點擊的當下送出無聲朗讀,解鎖之後的朗讀(iPhone 只允許使用者操作時開始)
    if (IOS_STRATEGY === "speak") speechSynthesis?.cancel(); // 和參考專案一樣:隨即取消,正在念的內容也一併停止
  } catch { /* 不支援就算了 */ }
  if (IOS_STRATEGY === "speak") return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const done = () => { clearTimeout(timer); resolve(); };
    timer = setTimeout(() => { dbg("iOS 重置音訊:逾時"); done(); }, 800);
    try {
      const beep = IOS_STRATEGY === "beep";
      wavUrls[beep] ??= beep ? makeWavUrl(150, 880, 0.3) : makeWavUrl(120);
      const a = new Audio(wavUrls[beep]);
      a.onended = done;
      a.onerror = done;
      a.play().then(() => dbg(`iOS 重置音訊:播放${beep ? "提示音" : "無聲音訊"}`), (e) => { dbg(`iOS 重置音訊失敗:${e.name}`); done(); });
    } catch (e) {
      dbg(`iOS 重置音訊例外:${e.message}`);
      done();
    }
  });
}

/**
 * iPhone:收音結束後,等音訊從「收音」切回「播放」(約 0.6 秒),再把句子念出來。
 * 每次收音之間有朗讀播放,下一次收音才不會被 iPhone 直接靜音(參考專案就是這樣運作)。
 */
async function iosSpeakBack(text) {
  if (!isIOS || IOS_STRATEGY !== "speak" || !window.speechSynthesis) return;
  const token = ++state.speakToken;
  const since = Date.now() - (state.lastEndAt || 0);
  if (since < 600) await sleep(600 - since);
  if (token !== state.speakToken || state.ptt) return; // 這段時間內又按了「開始」
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-TW";
  u.rate = 1.2;
  u.onstart = () => dbg(`iOS 朗讀:${text}`);
  u.onerror = (e) => dbg(`iOS 朗讀 error:${e.error || ""}`);
  speechSynthesis.speak(u);
}

async function keepAwake() {
  if (state.wake && !state.wake.released) return; // 已經鎖著了,不要再多鎖一個(舊的會沒人釋放)
  try { state.wake = await navigator.wakeLock?.request("screen"); } catch { /* 不支援就算了 */ }
}
function releaseWake() {
  state.wake?.release?.().catch(() => {});
  state.wake = null;
}

// ───────────── 常開監聽 ─────────────

async function session() {
  const sid = ++state.epoch; // 這一輪的編號;stopSession 會把 epoch 加一,舊的迴圈看到編號不同就自己結束
  const alive = () => state.active && sid === state.epoch;
  state.active = true;
  updateButtons();
  keepAwake();
  showNotice("");

  let fails = 0; // 連續「立刻結束、沒有聽到任何東西」的次數,避免默默空轉
  while (alive()) {
    if (!navigator.onLine) {
      setStatus("沒有網路,等待連線中…", "error");
      await sleep(1000);
      continue;
    }
    setStatus("聆聽中…", "listen");
    const rz = createRecognizer(false, () => { if (alive()) setStatus("聆聽中…請說話", "listen"); });
    state.rz = rz;
    rz.start();
    const r = await rz.done;
    if (state.rz === rz) state.rz = null;
    if (r.text) { // 就算剛按了「停止」,已經聽到的話也要記下來
      stageText(rz.noteId, r.text);
      fails = 0;
    }
    if (!alive()) break;
    if (r.text) continue;

    if (r.needTap) { showNotice("這個瀏覽器需要手動點一下才能開始聽,請再按一次「開始」。"); break; }
    if (r.error === "not-allowed" || r.error === "service-not-allowed") { showNotice(describeError(r.error)); break; }
    if (r.error === "audio-capture" && !/muted/i.test(r.errorMessage)) { showNotice(describeError(r.error)); break; }
    // 網路不通、麥克風被靜音、或立刻結束:等一下再試,連續 3 次就停下來提醒
    if (r.error === "network" || r.error === "audio-capture" || r.ms < 1500) {
      if (r.error === "network" && !navigator.onLine) continue; // 沒網路的情況上面會等
      if (++fails >= 3) {
        showNotice(r.error
          ? describeError(r.error, r.errorMessage)
          : "麥克風一直立刻結束、沒有收到聲音。請稍後再試;也可以點進記事紙,用鍵盤上的麥克風聽寫。");
        break;
      }
      await sleep(1500);
      continue;
    }
    fails = 0; // 久久沒人說話,辨識自己結束:正常,接著再聽
  }
  if (sid === state.epoch) stopSession(); // 如果已經被新的一輪取代,就不要動新一輪的狀態
}

function stopSession() {
  state.active = false;
  state.epoch++;
  state.rz?.stop();
  releaseWake();
  setStatus("已停止", "idle");
  updateButtons();
}

// ───────────── 按住說話(手機是點擊監聽)─────────────

const MIN_HOLD_MS = 350;

// 手機(iPhone、Android)一律用「點一下開始,說完停頓自動結束,再點一次可提早結束」:
// iPhone 的 Safari 用持續收音容易失敗(被靜音、沒偵測到說話),
// Android 的 Chrome 用持續收音會重複吐出累積的文字。電腦才用按住說話。
const tapMode = isPhone;

async function pttStart() {
  if (state.mode !== "ptt") return;
  if (state.ptt) { // 點一下模式進行中,再按一次 = 說完了
    if (state.ptt.tap) {
      if (state.ptt.rz.started) setStatus("辨識中…", "think");
      state.ptt.rz.stop(); // 還沒真的開始收音就再按一次:等於取消
    }
    return;
  }
  showNotice("");
  if (!SR) { showNotice("這個瀏覽器不支援語音辨識。請點進記事紙,用鍵盤上的麥克風聽寫或直接打字。"); return; }
  if (!navigator.onLine) { setStatus("沒有網路", "error"); return; }
  keepAwake();
  const audioReset = isIOS ? iosResetAudio() : null; // 要在點擊的當下呼叫,所以放在第一個 await 之前
  const press = { tap: tapMode, startedAt: Date.now(), tooShort: false, released: false };
  const rz = createRecognizer(!tapMode, () => {
    if (state.ptt === press) setStatus(tapMode ? "請說話…(說完停頓,或按「停止」)" : "請說話…(說完放開)", "listen");
  });
  press.rz = rz;
  state.ptt = press;
  updateButtons();
  setStatus("準備中…", "think");
  dbg(`pttStart(continuous=${!tapMode})`);
  if (audioReset) await audioReset;
  rz.start();
  const r = await rz.done;
  if (state.ptt === press) state.ptt = null;
  updateButtons();
  if (!state.active) releaseWake();
  if (press.tooShort) return; // 狀態已由 pttEnd 顯示
  const softEnd = !r.error || r.error === "aborted" || r.error === "no-speech"; // 權限、網路等真正的錯誤要留在畫面上讓人看到
  if (isIOS && IOS_STRATEGY === "reload" && softEnd && !r.cancelled && !press.halted) {
    // 試驗用:iPhone 每次收音結束都重新載入網頁,下一次收音就是「網頁剛開啟的第一次」
    if (r.text) stageText(rz.noteId, r.text);
    dbg("iOS 收音結束,重新載入網頁");
    setTimeout(() => { if (!isEditing()) location.reload(); }, 900);
    return;
  }
  if (r.text) { stageText(rz.noteId, r.text); idleStatus(); iosSpeakBack(SAY === "ok" ? "好" : r.text); return; }
  if (r.cancelled || press.halted) return idleStatus(); // 自己取消、或切換記錄/模式而中止:不算錯誤
  if (r.needTap) { showNotice("無法開始收音,請再按一次。"); return idleStatus(); }
  if (r.error && r.error !== "aborted") {
    showNotice(describeError(r.error, r.errorMessage));
    if (r.error === "no-speech") iosSpeakBack("沒聽到,請再說一次");
    return idleStatus();
  }
  showNotice(press.tap
    ? "沒有收到辨識結果,請再按「開始」說話。"
    : "沒有收到辨識結果。請按住後等畫面出現「請說話」再開口,並靠近麥克風、說大聲一點。");
  setStatus("沒聽到聲音,請再試一次", "error");
  iosSpeakBack("沒聽到,請再說一次");
}

function pttEnd() {
  if (tapMode) return; // 手機:點一下開始、再點一下結束,放開手指不算結束
  const press = state.ptt;
  if (!press || press.released) return;
  press.released = true;
  $("micBtn").classList.remove("on");
  const held = Date.now() - press.startedAt;
  dbg(`放開(按住 ${held} 毫秒)`);
  if (held < MIN_HOLD_MS) {
    press.tooShort = true;
    press.rz.stop();
    setStatus("按太短了,請按住說話", "error");
    return;
  }
  if (press.rz.started) setStatus("辨識中…", "think");
  press.rz.stop();
}

// ───────────── 事件 ─────────────

/** 停掉所有進行中的聆聽(切換記錄、切換模式時用)。已經聽到的話照樣會記下來。 */
function haltListening() {
  stopSession();
  const press = state.ptt;
  if (press) {
    state.ptt = null;
    press.halted = true;
    press.rz.stop();
  }
}

const mic = $("micBtn");
mic.addEventListener("click", () => {
  if (state.mode === "ptt") {
    if (isPhone) pttStart(); // 手機:click 才會被當成「使用者操作」,收音需要這個
    return;                  // 電腦用下面的 pointer 事件(按住說話)
  }
  if (state.active) stopSession();
  else session();
});

// 按住說話:按下開始、放開結束(用 pointer capture,手指滑出按鈕也會收到放開事件)
mic.addEventListener("pointerdown", (e) => {
  if (state.mode !== "ptt" || isPhone) return;
  e.preventDefault();
  try { mic.setPointerCapture(e.pointerId); } catch { /* 不支援就算了 */ }
  pttStart();
});
["pointerup", "pointercancel"].forEach((t) => mic.addEventListener(t, () => {
  if (state.mode !== "ptt" || isPhone) return;
  pttEnd();
}));
mic.addEventListener("contextmenu", (e) => state.mode === "ptt" && e.preventDefault());
// 電腦上也可以按住空白鍵說話(游標不在輸入框、按鈕、選單上時)
addEventListener("keydown", (e) => {
  if (state.mode === "ptt" && !isPhone && e.code === "Space" && !e.repeat && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) {
    e.preventDefault();
    pttStart();
  }
});
addEventListener("keyup", (e) => {
  if (state.mode === "ptt" && !isPhone && e.code === "Space") pttEnd();
});

// 聆聽模式切換:常開監聽 / 按住說話
function setMode(mode, { save = true } = {}) {
  haltListening();
  state.mode = mode;
  if (save) localStorage.setItem(KEY.mode, mode);
  document.querySelectorAll('input[name="mode"]').forEach((r) => { r.checked = r.value === mode; });
  mic.classList.toggle("ptt", mode === "ptt");
  showNotice("");
  updateButtons();
  idleStatus();
}
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", () => r.checked && setMode(r.value)));

document.addEventListener("visibilitychange", () => {
  if (state.active && document.visibilityState === "visible") keepAwake();
});

// ───────────── 啟動 ─────────────

if (!SR) showNotice("這個瀏覽器不支援語音辨識(建議用 Chrome、Edge 或 Safari)。仍可點進記事紙,用鍵盤上的麥克風聽寫或直接打字。");

dbg(`isPhone=${isPhone} isIOS=${isIOS} touch=${navigator.maxTouchPoints} UA=${navigator.userAgent}`);
if (isPhone) {
  const label = document.querySelector('input[name="mode"][value="ptt"] + span');
  if (label) label.textContent = "點擊監聽";
}

loadNotes();
state.notes.forEach(drainQueue); // 上次關掉網頁時還在排隊的句子,這次開啟就放進去
showCurrent();
// 預設:iPhone/iPad 的 Safari 不允許自動開始聆聽,預設用點擊監聽;其他裝置預設常開監聽
const savedMode = localStorage.getItem(KEY.mode);
setMode(savedMode === "auto" || savedMode === "ptt" ? savedMode : (isIOS ? "ptt" : "auto"), { save: false });

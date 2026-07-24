import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getDatabase, ref, get, set, onValue, runTransaction,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyCGfF37XeySFz145nUmvn3jbund4C3DRUM",
  authDomain: "poker-chips-b6458.firebaseapp.com",
  databaseURL: "https://poker-chips-b6458-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "poker-chips-b6458",
  storageBucket: "poker-chips-b6458.firebasestorage.app",
  messagingSenderId: "897370261437",
  appId: "1:897370261437:web:a9c499f5fd02c2d4def4d4",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ---------- state ----------
const homeScreen = document.getElementById("home-screen");
const tableScreen = document.getElementById("table-screen");
const homeError = document.getElementById("home-error");

let myPlayerId = null;
let roomCode = null;
let latestState = null;
let unsubscribe = null;

// ---------- helpers ----------
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n) => {
  const r = r2(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
};

function genId() {
  return Math.random().toString(36).slice(2, 10);
}
function genCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function roomRef(code) {
  return ref(db, "rooms/" + code);
}
function pushLog(log, msg) {
  const arr = Array.isArray(log) ? log.slice() : [];
  arr.push(msg);
  return arr.slice(-25);
}

function storageKey(code) { return `poker:${code}`; }
function saveSession(code, playerId, name) {
  localStorage.setItem(storageKey(code), JSON.stringify({ playerId, name }));
}
function loadSession(code) {
  try { return JSON.parse(localStorage.getItem(storageKey(code))); } catch { return null; }
}
function showHomeError(msg) { homeError.textContent = msg; }

// ---------- create / join ----------
async function createRoom() {
  const name = document.getElementById("create-name").value.trim();
  const stack = Number(document.getElementById("create-stack").value) || 1000;
  if (!name) return showHomeError("Enter your name");

  let code = genCode();
  for (let i = 0; i < 6; i++) {
    const snap = await get(roomRef(code));
    if (!snap.exists()) break;
    code = genCode();
  }

  await set(roomRef(code), {
    starting_stack: stack,
    pot: 0,
    current_bet: 0,
    players: {},
    log: [],
  });

  await enterRoom(code, name);
}

async function joinRoom() {
  const name = document.getElementById("join-name").value.trim();
  const code = document.getElementById("join-code").value.trim().toUpperCase();
  if (!name) return showHomeError("Enter your name");
  if (!code || code.length !== 4) return showHomeError("Enter a valid 4-character room code");

  const snap = await get(roomRef(code));
  if (!snap.exists()) return showHomeError("Room not found");

  await enterRoom(code, name);
}

async function enterRoom(code, name) {
  roomCode = code;
  const existing = loadSession(code);
  const pid = (existing && existing.playerId) || genId();

  await runTransaction(roomRef(code), (room) => {
    if (!room) return room;
    room.players = room.players || {};
    if (room.players[pid]) {
      room.players[pid].name = name;
    } else {
      room.players[pid] = {
        id: pid,
        name,
        stack: room.starting_stack,
        contributed: 0,
        folded: false,
        joined_at: Date.now(),
      };
      room.log = pushLog(room.log, `${name} joined with ${money(room.starting_stack)}`);
    }
    return room;
  });

  myPlayerId = pid;
  saveSession(code, pid, name);
  subscribe(code);
  showTableScreen();
}

function showTableScreen() {
  homeScreen.classList.add("hidden");
  tableScreen.classList.remove("hidden");
  document.getElementById("room-code-value").textContent = roomCode;
}

function subscribe(code) {
  if (unsubscribe) unsubscribe();
  unsubscribe = onValue(roomRef(code), (snap) => {
    latestState = snap.val();
    if (latestState) render();
  });
}

// ---------- actions (atomic transactions) ----------
function act(mutator) {
  if (!roomCode) return;
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    room.players = room.players || {};
    const me = room.players[myPlayerId];
    if (!me) return room;
    mutator(room, me);
    return room;
  });
}

function doCheck() {
  act((room, me) => { room.log = pushLog(room.log, `${me.name} checked`); });
}
function doCall() {
  act((room, me) => {
    let amt = Math.max(0, (room.current_bet || 0) - (me.contributed || 0));
    amt = Math.min(amt, me.stack);
    me.stack = r2(me.stack - amt);
    me.contributed = r2((me.contributed || 0) + amt);
    room.pot = r2((room.pot || 0) + amt);
    room.log = pushLog(room.log, amt > 0 ? `${me.name} called ${money(amt)}` : `${me.name} checked`);
  });
}
function doRaise(amount) {
  act((room, me) => {
    const raiseTo = Math.max(amount, room.current_bet || 0);
    let delta = raiseTo - (me.contributed || 0);
    delta = Math.max(0, Math.min(delta, me.stack));
    me.stack = r2(me.stack - delta);
    me.contributed = r2((me.contributed || 0) + delta);
    room.pot = r2((room.pot || 0) + delta);
    room.current_bet = Math.max(room.current_bet || 0, me.contributed);
    room.log = pushLog(room.log, `${me.name} raised to ${money(me.contributed)}`);
  });
}
function doFold() {
  act((room, me) => {
    me.folded = true;
    room.log = pushLog(room.log, `${me.name} folded`);
  });
}
function doAddChips(amount) {
  act((room, me) => {
    me.stack = r2(me.stack + amount);
    room.log = pushLog(room.log, `${me.name} added ${money(amount)} chips`);
  });
}
function awardPot(winnerIds) {
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    const players = room.players || {};
    const winners = winnerIds.filter((id) => players[id]);
    if (winners.length && (room.pot || 0) > 0) {
      const share = room.pot / winners.length;
      winners.forEach((id) => { players[id].stack = r2(players[id].stack + share); });
      const names = winners.map((id) => players[id].name).join(", ");
      room.log = pushLog(room.log, `${names} won pot of ${money(room.pot)}`);
    }
    room.pot = 0;
    room.current_bet = 0;
    Object.values(players).forEach((p) => { p.contributed = 0; p.folded = false; });
    return room;
  });
}
function newHand() {
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    room.current_bet = 0;
    Object.values(room.players || {}).forEach((p) => { p.contributed = 0; p.folded = false; });
    room.log = pushLog(room.log, "New hand");
    return room;
  });
}

// ---------- render ----------
function playersArray() {
  return Object.values(latestState.players || {}).sort(
    (a, b) => (a.joined_at || 0) - (b.joined_at || 0)
  );
}

function render() {
  if (!latestState) return;
  document.getElementById("pot-label").textContent = money(latestState.pot || 0);
  document.getElementById("call-label").textContent = money(latestState.current_bet || 0);

  const players = playersArray();
  const me = (latestState.players || {})[myPlayerId];
  const toCall = me ? Math.max(0, (latestState.current_bet || 0) - (me.contributed || 0)) : 0;
  document.getElementById("btn-call").textContent = toCall > 0 ? `Call ${money(toCall)}` : "Call";

  const list = document.getElementById("players-list");
  list.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    li.className = (p.id === myPlayerId ? "you " : "") + (p.folded ? "folded" : "");
    li.innerHTML = `
      <span class="player-name">${escapeHtml(p.name)}${p.id === myPlayerId ? '<span class="tag">YOU</span>' : ""}${p.folded ? '<span class="tag fold-tag">FOLDED</span>' : ""}</span>
      <span class="player-right">
        <span class="player-stack">${money(p.stack)}</span>
        <span class="player-contrib">${(p.contributed || 0) > 0 ? `in pot: ${money(p.contributed)}` : "&nbsp;"}</span>
      </span>
    `;
    list.appendChild(li);
  }

  const logList = document.getElementById("log-list");
  logList.innerHTML = "";
  for (const entry of [...(latestState.log || [])].reverse()) {
    const li = document.createElement("li");
    li.textContent = entry;
    logList.appendChild(li);
  }

  const actionPanel = document.getElementById("action-panel");
  actionPanel.querySelectorAll("button").forEach((b) => {
    b.disabled = !!(me && me.folded) && b.id !== "btn-add-chips";
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- event wiring ----------
document.getElementById("create-btn").addEventListener("click", createRoom);
document.getElementById("join-btn").addEventListener("click", joinRoom);

document.getElementById("room-code-label").addEventListener("click", async () => {
  const link = `${location.origin}${location.pathname}#${roomCode}`;
  const pill = document.getElementById("room-code-label");
  const original = pill.innerHTML;
  try {
    await navigator.clipboard.writeText(link);
    pill.textContent = "Link copied!";
  } catch {
    pill.textContent = link;
  }
  setTimeout(() => { pill.innerHTML = original; }, 1500);
});

document.getElementById("btn-check").addEventListener("click", doCheck);
document.getElementById("btn-call").addEventListener("click", doCall);
document.getElementById("btn-fold").addEventListener("click", doFold);

document.getElementById("btn-raise").addEventListener("click", () => {
  const input = document.getElementById("raise-amount");
  const amount = Number(input.value);
  if (!amount || amount <= 0) return;
  doRaise(amount);
  input.value = "";
});

document.getElementById("btn-add-chips").addEventListener("click", () => {
  const input = document.getElementById("chips-amount");
  const amount = Number(input.value);
  if (!amount || amount <= 0) return;
  doAddChips(amount);
  input.value = "";
});

document.getElementById("btn-new-hand").addEventListener("click", newHand);

document.getElementById("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
document.getElementById("raise-amount").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("btn-raise").click(); });
document.getElementById("chips-amount").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("btn-add-chips").click(); });

const awardModal = document.getElementById("award-modal");
document.getElementById("btn-award").addEventListener("click", () => {
  if (!latestState) return;
  const list = document.getElementById("award-players-list");
  list.innerHTML = "";
  for (const p of playersArray()) {
    if (p.folded) continue;
    const li = document.createElement("li");
    li.innerHTML = `<label>
      <input type="checkbox" value="${p.id}" /> ${escapeHtml(p.name)}
    </label>`;
    list.appendChild(li);
  }
  awardModal.classList.remove("hidden");
});

document.getElementById("award-cancel").addEventListener("click", () => {
  awardModal.classList.add("hidden");
});

document.getElementById("award-confirm").addEventListener("click", () => {
  const checked = [...document.querySelectorAll("#award-players-list input:checked")].map((i) => i.value);
  awardModal.classList.add("hidden");
  if (checked.length === 0) return;
  awardPot(checked);
});

// Prefill room code from URL hash (invite links)
(function autoFillCode() {
  const hash = location.hash.replace("#", "").toUpperCase();
  if (hash.length === 4) {
    document.getElementById("join-code").value = hash;
  }
})();

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

const STREETS = ["preflop", "flop", "turn", "river"];
const STREET_LABEL = {
  lobby: "Waiting",
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
};

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
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function storageKey(code) { return `poker:${code}`; }
function saveSession(code, playerId, name) {
  localStorage.setItem(storageKey(code), JSON.stringify({ playerId, name }));
}
function loadSession(code) {
  try { return JSON.parse(localStorage.getItem(storageKey(code))); } catch { return null; }
}
function showHomeError(msg) { homeError.textContent = msg; }

// ---------- seat / order helpers (operate on a room snapshot) ----------
// Every player who has joined, in a stable seat order.
function allSeatIds(room) {
  return Object.values(room.players || {})
    .sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0))
    .map((p) => p.id);
}
// Only players dealt into the current hand, in seat order.
function handSeatIds(room) {
  return Object.values(room.players || {})
    .filter((p) => p.in_hand)
    .sort((a, b) => (a.joined_at || 0) - (b.joined_at || 0))
    .map((p) => p.id);
}
function isPlayable(room) {
  return room && STREETS.includes(room.phase);
}
function canAct(room, id) {
  const p = room.players && room.players[id];
  return !!(p && p.in_hand && !p.folded && !p.all_in);
}
// Players still holding cards (may be all-in).
function liveIds(room) {
  return handSeatIds(room).filter((id) => !room.players[id].folded);
}
// First actor at/after startId (inclusive) who can still act.
function firstToAct(room, startId) {
  const order = handSeatIds(room);
  const n = order.length;
  if (!n) return null;
  let s = order.indexOf(startId);
  if (s < 0) s = 0;
  for (let i = 0; i < n; i++) {
    const id = order[(s + i) % n];
    if (canAct(room, id)) return id;
  }
  return null;
}
// Next actor strictly after fromId who still owes an action this street.
function nextToAct(room, fromId) {
  const order = handSeatIds(room);
  const n = order.length;
  if (!n) return null;
  let start = order.indexOf(fromId);
  if (start < 0) start = -1;
  const bet = room.street_bet || 0;
  for (let i = 1; i <= n; i++) {
    const id = order[(start + i + n) % n];
    const p = room.players[id];
    if (!canAct(room, id)) continue;
    if (!p.has_acted || (p.street_contributed || 0) < bet) return id;
  }
  return null;
}
// First active actor after the button (postflop opening actor).
function firstAfterButton(room) {
  const order = handSeatIds(room);
  const n = order.length;
  if (!n) return null;
  let d = order.indexOf(room.dealer_id);
  if (d < 0) d = -1;
  for (let i = 1; i <= n; i++) {
    const id = order[(d + i) % n];
    if (canAct(room, id)) return id;
  }
  return null;
}

// ---------- create / join ----------
async function createRoom() {
  const name = document.getElementById("create-name").value.trim();
  const stack = Number(document.getElementById("create-stack").value) || 1000;
  const bb = Math.max(1, Number(document.getElementById("create-bb").value) || 10);
  const sb = Math.max(0, Number(document.getElementById("create-sb").value) || Math.round(bb / 2));
  if (!name) return showHomeError("Enter your name");

  let code = genCode();
  for (let i = 0; i < 6; i++) {
    const snap = await get(roomRef(code));
    if (!snap.exists()) break;
    code = genCode();
  }

  await set(roomRef(code), {
    starting_stack: stack,
    small_blind: sb,
    big_blind: bb,
    pot: 0,
    street_bet: 0,
    min_raise: bb,
    phase: "lobby",
    dealer_id: null,
    current_turn: null,
    last_raiser: null,
    hand_no: 0,
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
        street_contributed: 0,
        total_contributed: 0,
        folded: false,
        all_in: false,
        in_hand: false,
        has_acted: false,
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

// ---------- hand lifecycle ----------
function postBlind(room, id, amount) {
  const p = room.players[id];
  const amt = Math.min(amount, p.stack);
  p.stack = r2(p.stack - amt);
  p.street_contributed = r2((p.street_contributed || 0) + amt);
  p.total_contributed = r2((p.total_contributed || 0) + amt);
  room.pot = r2((room.pot || 0) + amt);
  if (p.stack <= 0) p.all_in = true;
  room.log = pushLog(room.log, `${p.name} posts ${money(amt)}`);
}

function startHand() {
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    if (isPlayable(room)) return room; // a hand is already running

    // Reset every player for a fresh hand.
    Object.values(room.players || {}).forEach((p) => {
      p.street_contributed = 0;
      p.total_contributed = 0;
      p.folded = false;
      p.all_in = false;
      p.has_acted = false;
      p.in_hand = p.stack > 0;
    });

    const seats = handSeatIds(room);
    if (seats.length < 2) {
      room.log = pushLog(room.log, "Need 2+ players with chips to start a hand");
      room.phase = "lobby";
      return room;
    }

    // Rotate the dealer button.
    let dealer;
    if (room.dealer_id && seats.includes(room.dealer_id)) {
      const di = seats.indexOf(room.dealer_id);
      dealer = seats[(di + 1) % seats.length];
    } else {
      dealer = seats[0];
    }
    room.dealer_id = dealer;

    const n = seats.length;
    const di = seats.indexOf(dealer);
    let sbId, bbId, utg;
    if (n === 2) {
      // Heads-up: button is the small blind and acts first pre-flop.
      sbId = dealer;
      bbId = seats[(di + 1) % n];
      utg = dealer;
    } else {
      sbId = seats[(di + 1) % n];
      bbId = seats[(di + 2) % n];
      utg = seats[(di + 3) % n];
    }

    room.pot = 0;
    postBlind(room, sbId, room.small_blind || 0);
    postBlind(room, bbId, room.big_blind || 0);
    room.street_bet = room.big_blind || 0;
    room.min_raise = room.big_blind || 0;
    room.last_raiser = bbId;
    room.phase = "preflop";
    room.hand_no = (room.hand_no || 0) + 1;
    room.log = pushLog(room.log, `— Hand #${room.hand_no} · Pre-Flop —`);

    room.current_turn = firstToAct(room, utg);

    // Everyone already all-in from blinds → run it to showdown.
    if (liveIds(room).length <= 1) {
      autoAwardLast(room);
    } else if (!room.current_turn) {
      advanceStreet(room);
    }
    return room;
  });
}

// Move play forward after an action has been applied to `actor`.
function progress(room, actorId) {
  const live = liveIds(room);
  if (live.length <= 1) {
    autoAwardLast(room);
    return;
  }
  const next = nextToAct(room, actorId);
  if (next) {
    room.current_turn = next;
    return;
  }
  advanceStreet(room);
}

function advanceStreet(room) {
  // Loop so all-in run-outs skip streets that need no action.
  while (true) {
    if (room.phase === "river") {
      room.phase = "showdown";
      room.current_turn = null;
      room.street_bet = 0;
      room.log = pushLog(room.log, "Showdown — award the pot to the winner(s)");
      return;
    }
    const idx = STREETS.indexOf(room.phase);
    room.phase = STREETS[idx + 1];
    room.street_bet = 0;
    room.min_raise = room.big_blind || 0;
    room.last_raiser = null;
    handSeatIds(room).forEach((id) => {
      const p = room.players[id];
      p.street_contributed = 0;
      if (!p.folded && !p.all_in) p.has_acted = false;
    });
    room.log = pushLog(room.log, `— ${STREET_LABEL[room.phase]} —`);

    const first = firstAfterButton(room);
    if (first) {
      room.current_turn = first;
      return;
    }
    // Nobody can act (everyone all-in) → keep advancing.
  }
}

function autoAwardLast(room) {
  const live = liveIds(room);
  if (live.length === 1) {
    const p = room.players[live[0]];
    p.stack = r2(p.stack + (room.pot || 0));
    room.log = pushLog(room.log, `${p.name} wins ${money(room.pot)} (uncontested)`);
  }
  endHand(room);
}

function endHand(room) {
  room.pot = 0;
  room.street_bet = 0;
  room.min_raise = room.big_blind || 0;
  room.current_turn = null;
  room.last_raiser = null;
  room.phase = "lobby";
  Object.values(room.players || {}).forEach((p) => {
    p.street_contributed = 0;
    p.total_contributed = 0;
    p.folded = false;
    p.all_in = false;
    p.has_acted = false;
    p.in_hand = false;
  });
}

// ---------- turn-gated actions ----------
function turnAct(mutator) {
  if (!roomCode) return;
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    const me = room.players && room.players[myPlayerId];
    if (!me) return room;
    if (!isPlayable(room)) return room;             // no hand in progress
    if (room.current_turn !== myPlayerId) return room; // not your turn
    if (!canAct(room, myPlayerId)) return room;     // folded / all-in / not dealt in
    mutator(room, me);
    return room;
  });
}

function doCheck() {
  turnAct((room, me) => {
    const toCall = (room.street_bet || 0) - (me.street_contributed || 0);
    if (toCall > 0) return; // cannot check facing a bet
    me.has_acted = true;
    room.log = pushLog(room.log, `${me.name} checks`);
    progress(room, me.id);
  });
}

function doCall() {
  turnAct((room, me) => {
    const toCall = Math.max(0, (room.street_bet || 0) - (me.street_contributed || 0));
    const amt = Math.min(toCall, me.stack);
    me.stack = r2(me.stack - amt);
    me.street_contributed = r2((me.street_contributed || 0) + amt);
    me.total_contributed = r2((me.total_contributed || 0) + amt);
    room.pot = r2((room.pot || 0) + amt);
    if (me.stack <= 0) me.all_in = true;
    me.has_acted = true;
    room.log = pushLog(room.log, toCall > 0
      ? `${me.name} calls ${money(amt)}${me.all_in ? " (all in)" : ""}`
      : `${me.name} checks`);
    progress(room, me.id);
  });
}

function doRaise(raiseTo) {
  turnAct((room, me) => {
    const oldBet = room.street_bet || 0;
    const myContrib = me.street_contributed || 0;
    const maxTotal = r2(myContrib + me.stack); // shove ceiling
    let target = r2(raiseTo);

    if (target <= oldBet) return;               // must exceed the current bet
    const isAllIn = target >= maxTotal;
    if (isAllIn) target = maxTotal;

    const minLegal = r2(oldBet + (room.min_raise || room.big_blind || 0));
    if (!isAllIn && target < minLegal) return;  // below minimum raise

    const delta = r2(target - myContrib);
    me.stack = r2(me.stack - delta);
    me.street_contributed = target;
    me.total_contributed = r2((me.total_contributed || 0) + delta);
    room.pot = r2((room.pot || 0) + delta);
    if (me.stack <= 0) me.all_in = true;

    const increment = r2(target - oldBet);
    room.street_bet = target;

    // A full-sized raise reopens the action for everyone else.
    if (increment >= (room.min_raise || 0)) {
      room.min_raise = increment;
      room.last_raiser = me.id;
      handSeatIds(room).forEach((id) => {
        if (id === me.id) return;
        const p = room.players[id];
        if (!p.folded && !p.all_in) p.has_acted = false;
      });
    }
    me.has_acted = true;
    room.log = pushLog(room.log,
      `${me.name} ${oldBet > 0 ? "raises to" : "bets"} ${money(target)}${me.all_in ? " (all in)" : ""}`);
    progress(room, me.id);
  });
}

function doFold() {
  turnAct((room, me) => {
    me.folded = true;
    me.has_acted = true;
    room.log = pushLog(room.log, `${me.name} folds`);
    progress(room, me.id);
  });
}

// Rebuys are only allowed between hands, to keep in-hand chip counts honest.
function doAddChips(amount) {
  if (!roomCode) return;
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    const me = room.players && room.players[myPlayerId];
    if (!me) return room;
    if (isPlayable(room)) return room; // not during a live hand
    me.stack = r2(me.stack + amount);
    room.log = pushLog(room.log, `${me.name} added ${money(amount)} chips`);
    return room;
  });
}

function awardPot(winnerIds) {
  runTransaction(roomRef(roomCode), (room) => {
    if (!room) return room;
    if (room.phase !== "showdown") return room;
    const players = room.players || {};
    const winners = winnerIds.filter((id) => players[id] && players[id].in_hand && !players[id].folded);
    if (winners.length && (room.pot || 0) > 0) {
      const share = r2(room.pot / winners.length);
      winners.forEach((id) => { players[id].stack = r2(players[id].stack + share); });
      const names = winners.map((id) => players[id].name).join(", ");
      room.log = pushLog(room.log, `${names} won pot of ${money(room.pot)}`);
    }
    endHand(room);
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
  const room = latestState;
  const me = (room.players || {})[myPlayerId];
  const playing = isPlayable(room);
  const myTurn = playing && room.current_turn === myPlayerId && canAct(room, myPlayerId);

  document.getElementById("pot-label").textContent = money(room.pot || 0);
  document.getElementById("call-label").textContent = money(room.street_bet || 0);

  // Phase + turn banner.
  document.getElementById("phase-label").textContent = STREET_LABEL[room.phase] || "Waiting";
  const turnText = document.getElementById("turn-label");
  if (room.phase === "showdown") {
    turnText.textContent = "Award the pot";
  } else if (!playing) {
    turnText.textContent = "Between hands";
  } else if (myTurn) {
    turnText.textContent = "Your turn";
  } else {
    const cur = room.players && room.players[room.current_turn];
    turnText.textContent = cur ? `Waiting for ${cur.name}` : "—";
  }
  turnText.classList.toggle("mine", !!myTurn);

  const toCall = me ? Math.max(0, (room.street_bet || 0) - (me.street_contributed || 0)) : 0;
  document.getElementById("btn-call").textContent = toCall > 0 ? `Call ${money(toCall)}` : "Check";

  // Players list.
  const list = document.getElementById("players-list");
  list.innerHTML = "";
  for (const p of playersArray()) {
    const li = document.createElement("li");
    const classes = [];
    if (p.id === myPlayerId) classes.push("you");
    if (p.folded) classes.push("folded");
    if (playing && room.current_turn === p.id) classes.push("active-turn");
    if (!p.in_hand && playing) classes.push("sitting-out");
    li.className = classes.join(" ");

    const badges = [];
    if (room.dealer_id === p.id && (playing || room.phase === "showdown")) {
      badges.push('<span class="tag dealer-tag" title="Dealer button">D</span>');
    }
    if (p.id === myPlayerId) badges.push('<span class="tag">YOU</span>');
    if (p.folded) badges.push('<span class="tag fold-tag">FOLDED</span>');
    if (p.all_in) badges.push('<span class="tag allin-tag">ALL IN</span>');

    const street = p.street_contributed || 0;
    li.innerHTML = `
      <span class="player-name">${escapeHtml(p.name)}${badges.join("")}</span>
      <span class="player-right">
        <span class="player-stack">${money(p.stack)}</span>
        <span class="player-contrib">${street > 0 ? `bet: ${money(street)}` : "&nbsp;"}</span>
      </span>
    `;
    list.appendChild(li);
  }

  // Activity log.
  const logList = document.getElementById("log-list");
  logList.innerHTML = "";
  for (const entry of [...(room.log || [])].reverse()) {
    const li = document.createElement("li");
    li.textContent = entry;
    logList.appendChild(li);
  }

  // Action panel — enabled only on your turn.
  document.getElementById("action-panel").classList.toggle("disabled", !myTurn);
  document.getElementById("btn-check").disabled = !myTurn || toCall > 0;
  document.getElementById("btn-call").disabled = !myTurn;
  document.getElementById("btn-fold").disabled = !myTurn;
  document.getElementById("btn-raise").disabled = !myTurn || !me || me.stack <= 0;
  document.getElementById("raise-amount").disabled = !myTurn;

  // Between-hand controls.
  const canStart = !playing && room.phase !== "showdown";
  const startBtn = document.getElementById("btn-start");
  startBtn.classList.toggle("hidden", !canStart);
  const eligible = Object.values(room.players || {}).filter((p) => p.stack > 0).length;
  startBtn.disabled = eligible < 2;
  startBtn.textContent = eligible < 2 ? "Waiting for players…" : (room.hand_no ? "Deal Next Hand" : "Deal First Hand");

  document.getElementById("btn-award").classList.toggle("hidden", room.phase !== "showdown");

  // Add-chips only between hands.
  document.getElementById("btn-add-chips").disabled = playing;
  document.getElementById("chips-amount").disabled = playing;
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

document.getElementById("btn-start").addEventListener("click", startHand);

document.getElementById("join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
document.getElementById("raise-amount").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("btn-raise").click(); });
document.getElementById("chips-amount").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("btn-add-chips").click(); });

const awardModal = document.getElementById("award-modal");
document.getElementById("btn-award").addEventListener("click", () => {
  if (!latestState) return;
  const list = document.getElementById("award-players-list");
  list.innerHTML = "";
  for (const p of playersArray()) {
    if (p.folded || !p.in_hand) continue;
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

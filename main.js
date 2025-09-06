// main.js — 能力フック / 戦闘勝率式 / 重み付きイベント / ログ / HP上下限 / リトライ対応
// ＋ ボス戦演出（テキスト強調・フラッシュ）

// ===== 設定 =====
const MAX_HP = 5;
const MAP_LENGTH = 10;

// ===== 状態 =====
let map = [];
let pos = 0;
let hp = 3;
let items = 0;
let friends = 0;
let allies = [];                 // 仲間名の一覧
let eventsData = [];
let characters = [];
let activeAbilities = [];        // {code,label,trigger,usesLeft,effect,modifier}
let logHistory = [];

// ===== 初期化 =====
document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    const [evRes, chRes] = await Promise.all([
      fetch("data/events.json"),
      fetch("data/characters.json")
    ]);

    if (!evRes.ok) throw new Error(`events.jsonの取得に失敗: ${evRes.status}`);
    eventsData = await evRes.json();

    // characters.json は任意（無くても進行可）
    if (chRes.ok) characters = await chRes.json();
  } catch (e) {
    console.error(e);
    showMessage("データ読み込みに失敗しました。ページを再読み込みしてください。\n" + e.message);
    disableNext(true);
    return;
  }

  resetRun();
  generateMapWeighted();
  renderMap();
  updateStatus();
  showMessage("ゲームを開始しました。『次へ進む』をクリックしてください。");
  disableNext(false);
  document.getElementById("retryButton").style.display = "none";
}

function resetRun() {
  map = [];
  pos = 0;
  hp = 3;
  items = 0;
  friends = 0;
  allies = [];
  activeAbilities = [];
  logHistory = [];
  updateAlliesView();
}

// ===== マップ生成（重み付き） =====
function generateMapWeighted() {
  const total = eventsData.reduce((s, ev) => s + (ev.weight ?? 1), 0);
  for (let i = 0; i < MAP_LENGTH; i++) {
    let r = Math.random() * total;
    let picked = eventsData[0];
    for (const ev of eventsData) {
      r -= (ev.weight ?? 1);
      if (r <= 0) { picked = ev; break; }
    }
    map.push(picked);
  }
}

// ===== UI =====
function renderMap() {
  const wrap = document.getElementById("map");
  wrap.innerHTML = "";
  map.forEach((ev, i) => {
    const node = document.createElement("div");
    node.className = "node" + (i === pos ? " active" : "");
    node.innerText = ev.label ?? ev.type ?? `${i + 1}`;
    wrap.appendChild(node);
  });
}

function updateStatus(highlight) {
  const allyVal = document.getElementById("allyVal");
  const itemVal = document.getElementById("itemVal");
  const hpVal = document.getElementById("hpVal");
  allyVal.textContent = friends;
  itemVal.textContent = items;

  // HP表示＆ハイライト
  hpVal.textContent = hp;
  hpVal.className = "";
  if (highlight === "hit") {
    hpVal.classList.add("hp-hit", "blink");
    setTimeout(() => hpVal.classList.remove("hp-hit", "blink"), 500);
  } else if (highlight === "heal") {
    hpVal.classList.add("hp-heal", "blink");
    setTimeout(() => hpVal.classList.remove("hp-heal", "blink"), 500);
  }
}

function updateAlliesView() {
  const box = document.getElementById("allies");
  box.innerHTML = allies.map(n => `<span class="ally-badge">${n}</span>`).join("");
}

function showMessage(msg) {
  const logEl = document.getElementById("log");
  logEl.textContent = msg;
  // ボス強調クラスは都度リセット（必要時に付け直す）
  logEl.classList.remove("boss-event");

  logHistory.push(msg);
  const hist = document.getElementById("log-history");
  hist.innerHTML = logHistory.slice(-10).map(l => `<div>▶ ${l}</div>`).join("");
}

function disableNext(on) {
  document.getElementById("nextButton").disabled = on;
}

// ===== ボス演出（素材不要の簡易） =====
function bossFlash() {
  const flash = document.createElement("div");
  flash.className = "boss-flash";
  document.body.appendChild(flash);
  // CSSで 0.5s ×3 なので 1700ms で確実に除去
  setTimeout(() => { flash.remove(); }, 1700);
}

function bossEmphasizeLog() {
  const logEl = document.getElementById("log");
  logEl.classList.add("boss-event");
}

// ===== 共通ロジック =====
function clampHP(delta) {
  const prev = hp;
  hp = Math.max(0, Math.min(MAX_HP, hp + delta));
  if (hp > prev) updateStatus("heal");
  else if (hp < prev) updateStatus("hit");
  else updateStatus();
}

function applyEffect(effect = {}) {
  if (typeof effect.hp === "number") clampHP(effect.hp);
  if (typeof effect.items === "number") { items += effect.items; updateStatus(); }
  if (typeof effect.friends === "number") { friends += effect.friends; updateStatus(); }
}

function addAbilityFromCharacter(charObj) {
  if (!charObj?.ability) return;
  const a = charObj.ability;
  activeAbilities.push({
    code: a.code,
    label: a.label,
    trigger: a.trigger,
    usesLeft: (typeof a.uses === "number") ? a.uses : Infinity,
    effect: a.effect || null,
    modifier: a.modifier || null
  });
}

function runAbilityHooks(trigger, ctx) {
  // ctxは参照で変更され得る: { enemyType, incomingHpLoss, winRateBonus, afterBattleHpLost, isBigTreasure, ... }
  for (const ab of activeAbilities) {
    if (ab.trigger !== trigger) continue;
    if (ab.usesLeft === 0) continue;

    // modifier系
    if (ab.modifier) {
      if (ab.modifier.enemy_type_downgrade && ctx.enemyType === "strongEnemy") {
        ctx.enemyType = ab.modifier.enemy_type_downgrade; // 強敵→通常敵
        ab.usesLeft = Math.max(0, ab.usesLeft - 1);
      }
      if (ab.modifier.skip_hp_loss && ctx.incomingHpLoss > 0) {
        ctx.incomingHpLoss = 0; // 被弾無効
        ab.usesLeft = Math.max(0, ab.usesLeft - 1);
      }
      if (typeof ab.modifier.hp_damage_multi === "number" && ctx.incomingHpLoss > 0) {
        ctx.incomingHpLoss = Math.round(ctx.incomingHpLoss * ab.modifier.hp_damage_multi);
      }
      if (typeof ab.modifier.win_rate_bonus === "number") {
        ctx.winRateBonus = (ctx.winRateBonus || 0) + ab.modifier.win_rate_bonus;
      }
    }

    // effect系（発動タイミングに応じて）
    if (ab.effect) {
      if (trigger === "on_treasure" || trigger === "on_bigTreasure") {
        if (typeof ab.effect.items === "number") { items += ab.effect.items; updateStatus(); }
      }
      if (trigger === "post_battle_if_hp_loss" && (ctx.afterBattleHpLost || 0) > 0) {
        if (typeof ab.effect.hp === "number") { clampHP(ab.effect.hp); }
        ab.usesLeft = Math.max(0, ab.usesLeft - 1);
      }
    }
  }

  // usesLeft が0のものは削除
  activeAbilities = activeAbilities.filter(a => a.usesLeft > 0);
}

function calcWinRate(ev) {
  // 基本勝率（未設定時はタイプでデフォルト）
  let winRate = (typeof ev.winRateBase === "number")
    ? ev.winRateBase
    : (ev.type === "boss" ? 0.33 : ev.type === "strongEnemy" ? 0.4 : 0.5);

  // 仲間補正（仲間が多いほど有利）
  winRate += friends * 0.05;

  // 能力補正（pre_battle フックで ctx.winRateBonus を合算）
  const ctx = { winRateBonus: 0 };
  runAbilityHooks("pre_battle", ctx);
  winRate += ctx.winRateBonus || 0;

  // クランプ
  winRate = Math.max(0.15, Math.min(0.9, winRate));
  return winRate;
}

// ===== 進行 =====
function next() {
  if (pos >= map.length) return;

  const ev = map[pos] || {};
  let msg = ev.message || (ev.label ?? "イベント");

  const typeKey = ev.type || ev.label; // 日本語ラベル/英語typeのどちらでも反応

  // ---- イベント分岐 ----
  switch (typeKey) {
    // ====== 戦闘：通常/強敵/ボス ======
    case "enemy":
    case "敵":
    case "strongEnemy":
    case "強敵":
    case "boss":
    case "ボス": {
      // ---- ボス演出トリガー ----
      const isBoss = (typeKey === "boss" || typeKey === "ボス");
      if (isBoss) {
        // 先にメッセージ表示→強調＆フラッシュ
        showMessage(ev.message || "ボスが立ちはだかった！");
        bossEmphasizeLog();
        bossFlash();
      }

      // 強敵/ボス→前処理（強敵弱体化など）
      let enemyType = (ev.type || (typeKey === "強敵" ? "strongEnemy" : typeKey === "ボス" ? "boss" : "enemy"));
      if (enemyType === "strongEnemy") {
        runAbilityHooks("pre_strong_enemy", { enemyType });
      }

      // 勝率
      const effectiveEv = { ...ev, type: enemyType };
      const winRate = calcWinRate(effectiveEv);
      const win = Math.random() < winRate;

      if (win) {
        const reward = effectiveEv.reward?.items ?? (enemyType === "boss" ? 3 : enemyType === "strongEnemy" ? 2 : 1);
        items += reward;
        updateStatus();
        msg = (enemyType === "boss" ? "ボスに勝利！" : enemyType === "strongEnemy" ? "強敵に勝利！" : "敵に勝利！")
            + `アイテムを${reward}個手に入れた！`;
      } else {
        let dmg = effectiveEv.damage ?? (enemyType === "boss" ? 3 : enemyType === "strongEnemy" ? 2 : 1);
        const ctx = { incomingHpLoss: dmg };
        runAbilityHooks("pre_hp_loss", ctx);
        dmg = ctx.incomingHpLoss;
        clampHP(-dmg);
        msg = (enemyType === "boss" ? "ボスに敗北…" : enemyType === "strongEnemy" ? "強敵に敗北…" : "敵に敗北…")
            + `HPが${dmg}減った…`;
        // 被弾後の回復能力（例：自動回復1回）
        runAbilityHooks("post_battle_if_hp_loss", { afterBattleHpLost: dmg });
      }
      break;
    }

    // ===== 宝箱 =====
    case "treasure":
    case "宝": {
      applyEffect(ev.effect || { items: 1 });
      runAbilityHooks("on_treasure", {});
      msg = ev.message || "宝箱を見つけた！アイテムを手に入れた！";
      break;
    }

    // ===== 大きな宝箱 =====
    case "bigTreasure":
    case "大宝": {
      applyEffect(ev.effect || { items: 2 });
      runAbilityHooks("on_bigTreasure", { isBigTreasure: true });
      msg = ev.message || "大きな宝箱！アイテムをたくさん手に入れた！";
      break;
    }

    // ===== 休憩 =====
    case "rest":
    case "休": {
      applyEffect(ev.effect || { hp: 1 });
      msg = ev.message || "休憩してHPが回復した！";
      break;
    }

    // ===== 罠 =====
    case "trap":
    case "罠": {
      let dmg = (ev.effect && typeof ev.effect.hp === "number") ? -ev.effect.hp : 1; // effect.hpが-1想定
      dmg = Math.abs(dmg);
      const ctx = { incomingHpLoss: dmg };
      runAbilityHooks("on_trap", ctx);
      clampHP(-ctx.incomingHpLoss);
      msg = ev.message || "罠にかかってしまった…！";
      break;
    }

    // ===== 仲間加入 =====
    case "friend":
    case "仲間": {
      // 未加入優先
      const poolAll = (characters || []).filter(c => c.type === "friend");
      const poolNew = poolAll.filter(c => !allies.includes(c.name));
      const arr = (poolNew.length ? poolNew : poolAll);
      const picked = arr[Math.floor(Math.random() * Math.max(1, arr.length))];

      friends += 1;
      const name = picked?.name || `仲間${friends}`;
      allies.push(name);
      updateAlliesView();
      updateStatus();

      // 能力付与（ある場合）
      if (picked?.ability) addAbilityFromCharacter(picked);

      msg = picked
        ? `${name} が仲間になった！\n「${picked.line}」`
        : `新しい仲間が加わった！`;
      break;
    }

    // ===== レアイベント例：祠 =====
    case "shrine":
    case "祠": {
      if (Array.isArray(ev.shrinePool) && ev.shrinePool.length) {
        const pick = ev.shrinePool[Math.floor(Math.random() * ev.shrinePool.length)];
        if (pick.grant) applyEffect(pick.grant);
        if (pick.grantAbility) activeAbilities.push({
          code: pick.grantAbility.code, label: pick.grantAbility.label,
          trigger: pick.grantAbility.trigger, usesLeft: pick.grantAbility.uses ?? 1,
          effect: pick.grantAbility.effect || null, modifier: pick.grantAbility.modifier || null
        });
        msg = ev.message || "不思議な祠の力を感じた…";
      } else {
        msg = ev.message || "祠にお参りした。";
      }
      break;
    }

    // ===== レアイベント例：虹宝 =====
    case "rainbowChest":
    case "虹宝": {
      applyEffect(ev.effect || { items: 3 });
      if (Math.random() < (ev.bonusChance ?? 0)) applyEffect(ev.bonusEffect || { items: 1 });
      msg = ev.message || "虹色の宝箱！たくさんのアイテムを手に入れた！";
      break;
    }

    // ===== デフォルト（フェイルセーフ） =====
    default: {
      if (ev.effect) applyEffect(ev.effect);
      msg = ev.message || (ev.label ? `${ev.label}のマスだ。` : "何も起きなかった…");
      break;
    }
  }

  // 通常表示（ボスは演出後に勝敗メッセージで上書き）
  showMessage(msg);
  if (typeKey === "boss" || typeKey === "ボス") bossEmphasizeLog();

  // HP 0なら即終了
  if (hp <= 0) return endGame(true);

  pos++;
  renderMap();

  if (pos >= map.length) return endGame(false);
}

// ===== 終了処理 =====
function endGame(gameOver) {
  const total = friends * 100 + hp * 50 + items * 20;
  const title = gameOver ? "HPが尽きてしまった…ゲームオーバー！" : "冒険終了！おつかれさまでした！";
  showMessage(`${title}\n仲間: ${friends} / HP: ${hp} / アイテム: ${items}\n合計スコア: ${total}`);
  disableNext(true);
  document.getElementById("retryButton").style.display = "inline-block";
}

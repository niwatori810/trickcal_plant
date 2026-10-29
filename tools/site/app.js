(function () {
  "use strict";

  var payload = JSON.parse(document.getElementById("app-data").textContent);

  var MATERIALS = payload.materials.slice();
  var byId = new Map();
  var byLevel = { 0: [], 1: [], 2: [], 3: [] };

  MATERIALS.forEach(function (m) {
    byId.set(m.id, m);
    byLevel[m.level].push(m);
  });

  var TIER_LABEL = { 0: "C", 1: "N", 2: "R", 3: "SR" };
  var TIER_CLASS = { 0: "tier-c", 1: "tier-n", 2: "tier-r", 3: "tier-sr" };

  var TABS = {
    lab: {
      label: "生産ラボ",
      levelWord: "レベル",
      stages: payload.lab.levels,
      min: 2,
      max: 12
    },
    research: {
      label: "研究",
      levelWord: "段階",
      stages: payload.research.stages,
      min: 1,
      max: 12
    }
  };

  var STORAGE_KEY = "trickcalPlant.v1";
  var nf = new Intl.NumberFormat("ja-JP");

  var state = {
    tab: "lab",
    selected: { lab: 2, research: 1 },
    owned: Object.create(null),
    storageOk: true
  };

  var saveTimer = null;
  var renderQueued = false;

  // ---------- helpers ----------

  function fmt(n) {
    return nf.format(n);
  }

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function idNum(id) {
    var m = /(\d+)$/.exec(id);
    return m ? parseInt(m[1], 10) : 0;
  }

  function toCount(value) {
    var n = Math.floor(Number(String(value).replace(/[,，\s]/g, "")));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1e12) : 0;
  }

  function clampStage(tab, value) {
    var def = TABS[tab];
    var n = Math.round(Number(value));
    if (!Number.isFinite(n)) return def.min;
    if (n < def.min) return def.min;
    if (n > def.max) return def.max;
    return n;
  }

  function stageLabel(tab, value) {
    return tab === "lab" ? "Lv." + value : "段階 " + value;
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function announce(message) {
    setText("live-status", message);
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    window.requestAnimationFrame(function () {
      renderQueued = false;
      renderComputed();
    });
  }

  // ---------- calculation ----------

  function aggregate(entries) {
    var result = new Map();
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var id = Array.isArray(entry) ? entry[0] : entry.materialId;
      var count = Array.isArray(entry) ? entry[1] : entry.count;
      result.set(id, (result.get(id) || 0) + count);
    }
    return result;
  }

  // owned === null: 所持を無視した展開後のグロス必要数
  // owned !== null: 階層差し引き後の残りの不足
  function expand(direct, owned) {
    var gross = new Map(direct);
    var net = new Map();

    [3, 2, 1, 0].forEach(function (level) {
      byLevel[level].forEach(function (mat) {
        var have = owned ? Math.max(0, Math.floor(owned[mat.id] || 0)) : 0;
        var need = Math.max(0, (gross.get(mat.id) || 0) - have);
        net.set(mat.id, need);
        mat.recipe.forEach(function (ingredient) {
          var id = ingredient[0];
          gross.set(id, (gross.get(id) || 0) + need * ingredient[1]);
        });
      });
    });

    return net;
  }

  function flatten(stages) {
    var entries = [];
    for (var i = 0; i < stages.length; i++) {
      entries = entries.concat(stages[i].entries);
    }
    return entries;
  }

  function sumGold(stages) {
    var total = 0;
    for (var i = 0; i < stages.length; i++) total += stages[i].gold;
    return total;
  }

  function rowCmp(a, b, shortages) {
    var sa = shortages.get(a.id) || 0;
    var sb = shortages.get(b.id) || 0;
    if ((sa > 0) !== (sb > 0)) return sa > 0 ? -1 : 1;
    if (sa !== sb) return sb - sa;
    if (a.level !== b.level) return b.level - a.level;
    return idNum(a.id) - idNum(b.id);
  }

  // ---------- rendering ----------

  function materialCell(m) {
    var icon = m.icon
      ? '<img class="mat-icon" src="' + m.icon + '" alt="" width="28" height="28">'
      : '<span class="mat-icon-fallback" aria-hidden="true">' + esc(m.name.charAt(0)) + "</span>";
    return (
      '<td class="cell-name" data-label="素材"><span class="mat">' +
      icon +
      '<span class="mat-name">' +
      esc(m.name) +
      "</span>" +
      '<span class="tier ' +
      TIER_CLASS[m.level] +
      '">' +
      TIER_LABEL[m.level] +
      "</span></span></td>"
    );
  }

  function numCell(label, value) {
    return '<td data-label="' + label + '"><span class="num">' + fmt(value) + "</span></td>";
  }

  function shortCell(shortage) {
    if (shortage > 0) {
      return (
        '<td class="cell-short" data-label="残りの不足"><span class="short-badge">不足</span><strong>' +
        fmt(shortage) +
        "</strong></td>"
      );
    }
    return '<td data-label="残りの不足"><span class="ok-badge">充足</span></td>';
  }

  function emptyRow(cols, message) {
    return '<tr class="empty-row"><td colspan="' + cols + '">' + esc(message) + "</td></tr>";
  }

  function mainRow(m, stageReq, scopeReq, allReq, scopeShort) {
    var owned = state.owned[m.id] || 0;
    var short = scopeShort.get(m.id) || 0;
    var cls = "tier-" + TIER_LABEL[m.level].toLowerCase() + (short > 0 ? "" : " is-ok");
    return (
      '<tr class="' +
      cls +
      '">' +
      materialCell(m) +
      numCell("この段階", stageReq.get(m.id) || 0) +
      numCell("残り必要", scopeReq.get(m.id) || 0) +
      numCell("全期間", allReq.get(m.id) || 0) +
      numCell("所持", owned) +
      shortCell(short) +
      "</tr>"
    );
  }

  function baseRow(m, scopeReq, allReq, scopeShort) {
    var owned = state.owned[m.id] || 0;
    var short = scopeShort.get(m.id) || 0;
    var cls = "tier-c" + (short > 0 ? "" : " is-ok");
    return (
      '<tr class="' +
      cls +
      '">' +
      materialCell(m) +
      numCell("残り必要", scopeReq.get(m.id) || 0) +
      numCell("全期間", allReq.get(m.id) || 0) +
      numCell("所持", owned) +
      shortCell(short) +
      "</tr>"
    );
  }

  function stageRow(stage, selected, tab) {
    var pairs = Array.from(aggregate(stage.entries).entries());
    pairs.sort(function (a, b) {
      var ma = byId.get(a[0]);
      var mb = byId.get(b[0]);
      if (!ma || !mb) return 0;
      if (ma.level !== mb.level) return mb.level - ma.level;
      return idNum(ma.id) - idNum(mb.id);
    });

    var chips = pairs
      .map(function (pair) {
        var m = byId.get(pair[0]);
        if (!m) return "";
        var icon = m.icon ? '<img src="' + m.icon + '" alt="" width="18" height="18">' : "";
        return (
          '<span class="chip">' +
          icon +
          esc(m.name) +
          ' <span class="chip-count">×' +
          fmt(pair[1]) +
          "</span></span>"
        );
      })
      .join("");

    var status = "";
    if (stage.value < selected) {
      status = '<span class="stage-status is-done">完了</span>';
    } else if (stage.value === selected) {
      status = '<span class="stage-status is-current">挑戦中</span>';
    }

    var detail = "";
    if (tab === "lab" && stage.reward) {
      detail = '<span class="reward">' + esc(stage.reward) + "</span>";
    } else if (tab === "research") {
      detail = '<span class="reward">' + stage.entries.length + "件</span>";
    }

    return (
      '<tr><td class="stage-cell" data-label="段階"><span class="stage-no">' +
      esc(stageLabel(tab, stage.value)) +
      "</span>" +
      status +
      '</td><td data-label="必要素材"><div class="chips">' +
      chips +
      "</div>" +
      detail +
      '</td><td data-label="金"><span class="num">' +
      fmt(stage.gold) +
      "</span></td></tr>"
    );
  }

  function updateOwnedMeta() {
    var count = 0;
    MATERIALS.forEach(function (m) {
      if ((state.owned[m.id] || 0) > 0) count++;
    });
    setText("owned-count", count > 0 ? count + "品目に入力" : "未入力");
  }

  function renderComputed() {
    var def = TABS[state.tab];
    var selected = state.selected[state.tab];
    var scope = def.stages.filter(function (stage) {
      return stage.value >= selected;
    });
    var all = def.stages;

    var stageDirect = aggregate(scope[0].entries);
    var scopeDirect = aggregate(flatten(scope));
    var allDirect = aggregate(flatten(all));

    var stageReq = expand(stageDirect, null);
    var scopeReq = expand(scopeDirect, null);
    var allReq = expand(allDirect, null);
    var scopeShort = expand(scopeDirect, state.owned);

    var goldScope = sumGold(scope);
    var goldAll = sumGold(all);

    var shortCount = 0;
    MATERIALS.forEach(function (m) {
      if ((scopeShort.get(m.id) || 0) > 0) shortCount++;
    });

    setText("stat-short", fmt(shortCount));
    setText("stat-gold-scope", fmt(goldScope));
    setText("stat-gold-all", fmt(goldAll));
    setText(
      "range-readout",
      stageLabel(state.tab, selected) +
        " 〜 " +
        stageLabel(state.tab, def.max) +
        "（" +
        scope.length +
        "段階）"
    );
    updateOwnedMeta();

    var mainRows = MATERIALS.filter(function (m) {
      return (
        m.level > 0 &&
        ((scopeReq.get(m.id) || 0) > 0 || (state.owned[m.id] || 0) > 0)
      );
    });
    mainRows.sort(function (a, b) {
      return rowCmp(a, b, scopeShort);
    });

    document.getElementById("main-body").innerHTML = mainRows.length
      ? mainRows
          .map(function (m) {
            return mainRow(m, stageReq, scopeReq, allReq, scopeShort);
          })
          .join("")
      : emptyRow(6, "この範囲で必要な中間素材はありません。");

    var baseRows = byLevel[0].filter(function (m) {
      return (scopeReq.get(m.id) || 0) > 0 || (state.owned[m.id] || 0) > 0;
    });
    baseRows.sort(function (a, b) {
      return rowCmp(a, b, scopeShort);
    });

    document.getElementById("base-body").innerHTML = baseRows.length
      ? baseRows
          .map(function (m) {
            return baseRow(m, scopeReq, allReq, scopeShort);
          })
          .join("")
      : emptyRow(5, "この範囲で必要な基礎素材はありません。");

    document.getElementById("stage-body").innerHTML = all
      .map(function (stage) {
        return stageRow(stage, selected, state.tab);
      })
      .join("");

    setText("stage-meta", all.length + "段階 / 金 " + fmt(goldAll));
    setText("base-meta", baseRows.length + "種");
  }

  // ---------- owned inputs ----------

  function ownedItem(m) {
    var icon = m.icon
      ? '<img class="mat-icon" src="' + m.icon + '" alt="" width="28" height="28">'
      : '<span class="mat-icon-fallback" aria-hidden="true">' + esc(m.name.charAt(0)) + "</span>";
    var label = document.createElement("label");
    label.className = "owned-item";
    label.innerHTML =
      icon +
      '<span class="owned-name">' +
      esc(m.name) +
      "</span>" +
      '<span class="tier ' +
      TIER_CLASS[m.level] +
      '">' +
      TIER_LABEL[m.level] +
      "</span>" +
      '<input type="number" min="0" step="1" inputmode="numeric" autocomplete="off" data-id="' +
      m.id +
      '" aria-label="' +
      esc(m.name) +
      'の所持数">';
    var input = label.querySelector("input");
    var value = state.owned[m.id] || 0;
    input.value = value > 0 ? String(value) : "";
    return label;
  }

  function buildOwnedInputs() {
    var body = document.getElementById("owned-body");
    body.innerHTML = "";

    var groups = [
      {
        legend: "中間素材（SR / R / N）",
        items: MATERIALS.filter(function (m) {
          return m.level > 0;
        })
      },
      {
        legend: "基礎素材（C）",
        items: MATERIALS.filter(function (m) {
          return m.level === 0;
        })
      }
    ];

    groups[0].items.sort(function (a, b) {
      if (a.level !== b.level) return b.level - a.level;
      return idNum(a.id) - idNum(b.id);
    });
    groups[1].items.sort(function (a, b) {
      return idNum(a.id) - idNum(b.id);
    });

    groups.forEach(function (group) {
      var fieldset = document.createElement("fieldset");
      fieldset.className = "owned-group";
      var legend = document.createElement("legend");
      legend.textContent = group.legend;
      fieldset.appendChild(legend);

      var grid = document.createElement("div");
      grid.className = "owned-grid";
      group.items.forEach(function (m) {
        grid.appendChild(ownedItem(m));
      });
      fieldset.appendChild(grid);
      body.appendChild(fieldset);
    });

    var reset = document.createElement("button");
    reset.type = "button";
    reset.id = "reset-owned";
    reset.className = "btn-reset";
    reset.textContent = "所持数をすべて消す";
    body.appendChild(reset);
  }

  function normalizeInput(input) {
    var value = toCount(input.value);
    state.owned[input.dataset.id] = value;
    if (document.activeElement !== input) {
      input.value = value > 0 ? String(value) : "";
    }
    scheduleSave();
    scheduleRender();
  }

  function resetOwned() {
    if (!window.confirm("所持数をすべて消しますか？")) return;
    state.owned = Object.create(null);
    var inputs = document.querySelectorAll("#owned-body input[data-id]");
    for (var i = 0; i < inputs.length; i++) inputs[i].value = "";
    scheduleSave();
    renderComputed();
    announce("所持数をすべて消しました");
  }

  // ---------- tabs and selector ----------

  function updateTabsUI() {
    var buttons = document.querySelectorAll(".tab");
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute("data-tab") === state.tab;
      buttons[i].classList.toggle("is-active", active);
      buttons[i].setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function rebuildSelect() {
    var def = TABS[state.tab];
    var select = document.getElementById("stage-select");
    select.innerHTML = "";
    def.stages.forEach(function (stage) {
      var option = document.createElement("option");
      option.value = String(stage.value);
      option.textContent = stageLabel(state.tab, stage.value);
      if (stage.value === state.selected[state.tab]) option.selected = true;
      select.appendChild(option);
    });
    setText(
      "stage-label",
      "挑戦中の" + def.levelWord + "（この" + def.levelWord + "を含む）"
    );
  }

  function setTab(tab) {
    if (!TABS[tab] || tab === state.tab) return;
    state.tab = tab;
    state.selected[tab] = clampStage(tab, state.selected[tab]);
    updateTabsUI();
    rebuildSelect();
    renderComputed();
    scheduleSave();
    announce(TABS[tab].label + "に切り替えました");
  }

  // ---------- storage ----------

  function storageGet() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      state.storageOk = false;
      return null;
    }
  }

  function storageSet(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
      return true;
    } catch (e) {
      state.storageOk = false;
      return false;
    }
  }

  function showStorageNote() {
    var note = document.getElementById("storage-note");
    note.hidden = false;
    note.textContent =
      "この環境では所持数を保存できません。ページを閉じると入力は消えます。";
  }

  function loadState() {
    var raw = storageGet();
    if (!raw) return;
    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!saved || saved.v !== 1) return;

    if (saved.tab === "lab" || saved.tab === "research") state.tab = saved.tab;
    if (saved.selected && typeof saved.selected === "object") {
      state.selected.lab = clampStage("lab", saved.selected.lab);
      state.selected.research = clampStage("research", saved.selected.research);
    }
    if (saved.owned && typeof saved.owned === "object") {
      Object.keys(saved.owned).forEach(function (id) {
        if (byId.has(id)) state.owned[id] = toCount(saved.owned[id]);
      });
    }
  }

  function scheduleSave() {
    if (!state.storageOk) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 300);
  }

  function saveNow() {
    if (!state.storageOk) return;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    var owned = {};
    Object.keys(state.owned).forEach(function (id) {
      var value = state.owned[id] || 0;
      if (value > 0) owned[id] = value;
    });
    var ok = storageSet(
      JSON.stringify({
        v: 1,
        tab: state.tab,
        selected: state.selected,
        owned: owned
      })
    );
    if (!ok) showStorageNote();
  }

  // ---------- events ----------

  function bindEvents() {
    var ownedBody = document.getElementById("owned-body");

    ownedBody.addEventListener("input", function (event) {
      var input = event.target;
      if (!input || input.tagName !== "INPUT" || !input.dataset.id) return;
      if (event.isComposing) return;
      state.owned[input.dataset.id] = toCount(input.value);
      updateOwnedMeta();
      scheduleSave();
      scheduleRender();
    });

    ownedBody.addEventListener("change", function (event) {
      var input = event.target;
      if (!input || input.tagName !== "INPUT" || !input.dataset.id) return;
      normalizeInput(input);
    });

    ownedBody.addEventListener(
      "blur",
      function (event) {
        var input = event.target;
        if (!input || input.tagName !== "INPUT" || !input.dataset.id) return;
        window.setTimeout(function () {
          normalizeInput(input);
        }, 0);
      },
      true
    );

    ownedBody.addEventListener("click", function (event) {
      if (event.target && event.target.id === "reset-owned") resetOwned();
    });

    var tabbar = document.querySelector(".tabbar");

    tabbar.addEventListener("click", function (event) {
      var button = event.target.closest(".tab");
      if (button) setTab(button.getAttribute("data-tab"));
    });

    tabbar.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      var buttons = Array.prototype.slice.call(tabbar.querySelectorAll(".tab"));
      var index = buttons.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      var next =
        event.key === "ArrowRight"
          ? (index + 1) % buttons.length
          : (index - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
      setTab(buttons[next].getAttribute("data-tab"));
    });

    document.getElementById("stage-select").addEventListener("change", function (event) {
      state.selected[state.tab] = clampStage(state.tab, Number(event.target.value));
      scheduleSave();
      renderComputed();
      announce(stageLabel(state.tab, state.selected[state.tab]) + "に変更しました");
    });

    window.addEventListener("pagehide", saveNow);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") saveNow();
    });
  }

  // ---------- init ----------

  loadState();
  buildOwnedInputs();
  rebuildSelect();
  updateTabsUI();
  renderComputed();
  bindEvents();
  if (!state.storageOk) showStorageNote();
})();

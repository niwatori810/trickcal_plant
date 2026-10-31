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

  var TIER_LABEL = { 0: "N", 1: "R", 2: "SR", 3: "SSR" };
  // CSSクラス名は旧レアリティ名のまま。色と段階の対応を維持するための内部名。
  var TIER_CLASS = { 0: "tier-c", 1: "tier-n", 2: "tier-r", 3: "tier-sr" };

  var TABS = {
    lab: {
      label: "生産ラボ",
      levelWord: "レベル",
      stages: payload.lab.levels,
      min: 1,
      max: 12
    },
    research: {
      label: "研究",
      levelWord: "段階",
      stages: payload.research.stages,
      min: 1,
      max: 12
    },
    hq: {
      label: "本部",
      levelWord: "レベル",
      stages: payload.hq.levels,
      min: 1,
      max: 10
    }
  };

  var STORAGE_KEY = "trickcalPlant.v1";
  var nf = new Intl.NumberFormat("ja-JP");

  var state = {
    tab: "research",
    selected: { lab: 1, research: 1, hq: 1 },
    researchName: "",
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
    return tab === "research" ? "段階 " + value : "Lv." + value;
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

  // direct(その段階・範囲の直接要求)をレシピで下位素材に展開した
  // 必要数(グロス)を返す。所持は表の「所持」列で別に表示する。
  function expand(direct) {
    var gross = new Map(direct);
    var net = new Map();

    [3, 2, 1, 0].forEach(function (level) {
      byLevel[level].forEach(function (mat) {
        var need = Math.max(0, gross.get(mat.id) || 0);
        net.set(mat.id, need);
        mat.recipe.forEach(function (ingredient) {
          var id = ingredient[0];
          gross.set(id, (gross.get(id) || 0) + need * ingredient[1]);
        });
      });
    });

    return net;
  }

  // 実際に生産すべき数（残り必要数）。上位素材から順に
  // 「必要数 − 所持 = 作る数」を計算し、その作る数に応じて
  // 下位素材の必要数を展開する（所持分だけ下位の免除が連動する）。
  function craftNumber(direct, owned) {
    var gross = new Map(direct);
    var net = new Map();

    [3, 2, 1, 0].forEach(function (level) {
      byLevel[level].forEach(function (mat) {
        var have = Math.max(0, Math.floor(owned[mat.id] || 0));
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

  // 表示に使う段階のエントリ。研究タブで研究名が選ばれているときは、
  // 選択段階内では「その研究から先（リスト順）」を現在位置として扱う。
  function stageDisplay(stage, name, selected) {
    var list = stage.entries;
    if (name && stage.value === selected) {
      var index = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === name) {
          index = i;
          break;
        }
      }
      list = index >= 0 ? list.slice(index) : [];
    }
    return list;
  }

  function stageGold(stage, name, selected, tab) {
    if (tab === "lab") return stage.gold;
    var total = 0;
    var entries = stageDisplay(stage, name, selected);
    for (var i = 0; i < entries.length; i++) total += entries[i].gold || 0;
    return total;
  }

  function rowCmp(a, b, remains) {
    if (a.level !== b.level) return b.level - a.level;
    var sa = remains.get(a.id) || 0;
    var sb = remains.get(b.id) || 0;
    if (sa !== sb) return sb - sa;
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

  function emptyRow(cols, message) {
    return '<tr class="empty-row"><td colspan="' + cols + '">' + esc(message) + "</td></tr>";
  }

  // メイン表は「素材 / 残り必要数 / 所持」の3列。
  // 残り必要数 = 実際に生産する個数(所持を上位から連動して差し引いた値)。
  // 足りている行は青+薄く、足りない行は赤で強調する。
  function mainRow(m, remainReq) {
    var owned = state.owned[m.id] || 0;
    var remain = remainReq.get(m.id) || 0;
    var ok = remain === 0;
    return (
      '<tr class="' +
      TIER_CLASS[m.level] +
      (ok ? " is-covered" : "") +
      '">' +
      materialCell(m) +
      '<td data-label="残り必要数"><span class="num ' +
      (ok ? "num-ok" : "num-short") +
      '">' +
      fmt(remain) +
      "</span></td>" +
      '<td data-label="所持"><button type="button" class="owned-link" data-owned-id="' +
      esc(m.id) +
      '" aria-label="' +
      esc(m.name) +
      'の所持数を入力" title="所持数を入力"><span class="num">' +
      fmt(owned) +
      "</span></button></td>" +
      "</tr>"
    );
  }

  // currentWork: いま支援すべき段階。生産ラボは「選択中のLvの1つ上」の段階が現在地。
  // currentName: 研究タブで選択中の研究名。現在段階の内訳で完了/現在を判定する。
  function stageRow(stage, entries, selected, tab, gold, currentWork, currentName) {
    var pairs = Array.from(aggregate(entries).entries());
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
    if (stage.value < currentWork) {
      status = '<span class="stage-status is-done">完了</span>';
    } else if (stage.value === currentWork) {
      status = '<span class="stage-status is-current">現在</span>';
    }

    var detail = "";
    if (tab === "research") {
      // 研究ごとに「◯◯ 必要素材」と、要求されている素材の画像だけを並べる。
      // 同じ研究名が複数素材を要求する場合も1行にまとめる。
      var groups = [];
      var groupMap = Object.create(null);
      entries.forEach(function (e) {
        var key = e.name || "";
        var group = groupMap[key];
        if (!group) {
          group = { name: e.name, mats: [] };
          groupMap[key] = group;
          groups.push(group);
        }
        group.mats.push(e);
      });

      // 現在段階の内訳は全研究を表示する。選択中の研究より前を「完了」、
      // 選択中の研究を「現在」として扱う。
      var currentIndex = -1;
      if (currentName && stage.value === selected) {
        for (var gi = 0; gi < groups.length; gi++) {
          if (groups[gi].name === currentName) {
            currentIndex = gi;
            break;
          }
        }
      }

      var lines = groups
        .map(function (group, index) {
          var matHtml = Array.from(aggregate(group.mats).entries())
            .sort(function (a, b) {
              var ma = byId.get(a[0]);
              var mb = byId.get(b[0]);
              if (ma && mb && ma.level !== mb.level) return mb.level - ma.level;
              return idNum(a[0]) - idNum(b[0]);
            })
            .map(function (pair) {
              var mat = byId.get(pair[0]);
              if (!mat) return "";
              var icon = mat.icon
                ? '<img class="detail-icon" src="' +
                  mat.icon +
                  '" alt="' +
                  esc(mat.name) +
                  '" title="' +
                  esc(mat.name) +
                  '">'
                : '<span class="detail-mat-name">' + esc(mat.name) + "</span>";
              return (
                '<span class="detail-mat">' +
                icon +
                '<span class="detail-count">×' +
                fmt(pair[1]) +
                "</span></span>"
              );
            })
            .join("");

          var itemStatus = "";
          if (stage.value < selected) {
            itemStatus = '<span class="stage-status is-done">完了</span>';
          } else if (stage.value === selected) {
            if (!currentName) {
              if (index === 0) {
                itemStatus = '<span class="stage-status is-current">現在</span>';
              }
            } else if (index < currentIndex) {
              itemStatus = '<span class="stage-status is-done">完了</span>';
            } else if (index === currentIndex) {
              itemStatus = '<span class="stage-status is-current">現在</span>';
            }
          }
          return (
            '<div class="detail-line">' +
            '<span class="detail-name">' +
            esc(group.name) +
            '<span class="detail-label">必要素材</span></span>' +
            '<span class="detail-mats">' +
            matHtml +
            "</span>" +
            itemStatus +
            "</div>"
          );
        })
        .join("");
      detail =
        '<span class="reward">' +
        entries.length +
        "件</span>" +
        '<details class="stage-detail" data-stage="' +
        stage.value +
        '"><summary>研究ごとの必要素材を見る（' +
        entries.length +
        '件）</summary><div class="stage-detail-list">' +
        lines +
        "</div></details>";
    } else if (stage.reward) {
      detail = '<span class="reward">' + esc(stage.reward) + "</span>";
    }

    return (
      '<tr><td class="stage-cell" data-label="段階"><span class="stage-no">' +
      esc(stageLabel(tab, stage.value)) +
      "</span>" +
      status +
      '</td><td class="cell-materials" data-label="必要素材"><div class="chips">' +
      chips +
      "</div>" +
      detail +
      '</td><td data-label="金"><span class="num">' +
      fmt(gold) +
      "</span></td></tr>"
    );
  }

  function updateOwnedMeta() {
    var count = 0;
    MATERIALS.forEach(function (m) {
      if ((state.owned[m.id] || 0) > 0) count++;
    });
    var badge = document.getElementById("owned-count");
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = count === 0;
    }
    setText("owned-summary", count > 0 ? count + "品目に入力" : "未入力");
  }

  function researchNames() {
    // 現在位置の指定に使うので、選択段階の研究リスト(表示順)を返す。
    var def = TABS.research;
    var selected = state.selected.research;
    var current = null;
    for (var i = 0; i < def.stages.length; i++) {
      if (def.stages[i].value === selected) {
        current = def.stages[i];
        break;
      }
    }
    if (!current) return [];

    var seen = Object.create(null);
    var names = [];
    current.entries.forEach(function (entry) {
      if (!entry.name || seen[entry.name]) return;
      seen[entry.name] = true;
      names.push(entry.name);
    });
    return names;
  }

  function renderResearchNames() {
    var row = document.getElementById("research-name-row");
    var select = document.getElementById("research-name-select");
    if (!row || !select) return;

    if (state.tab !== "research") {
      row.hidden = true;
      return;
    }

    var names = researchNames();
    if (state.researchName && names.indexOf(state.researchName) < 0) {
      state.researchName = "";
    }

    row.hidden = names.length === 0;
    if (!names.length) {
      select.innerHTML = "";
      return;
    }

    var html = '<option value="">未着手</option>';
    names.forEach(function (name) {
      html +=
        '<option value="' + esc(name) + '">' + esc(name) + "</option>";
    });

    if (select.innerHTML !== html) select.innerHTML = html;
    select.value = state.researchName;
  }

  // 研究の段階内訳はアコーディオン(同時に1つだけ開く)。
  function onStageDetailToggle(event) {
    var current = event.currentTarget;
    if (!current.open) return;
    var nodes = document.querySelectorAll("#stage-body .stage-detail");
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] !== current) nodes[i].open = false;
    }
  }

  function renderComputed() {
    var def = TABS[state.tab];
    var tab = state.tab;
    var selected = state.selected[tab];
    renderResearchNames();
    var name = tab === "research" ? state.researchName : "";

    // 生産ラボ・本部: 選択中のレベルは完成済みとして「次」のレベルから最大までを集計する。
    // 研究: 選択中の段階(研究名を選んでいるときはその研究以降)から最終段階までを集計する。
    var scope = def.stages.filter(function (stage) {
      return tab === "research" ? stage.value >= selected : stage.value > selected;
    });
    var focusStage = scope.length ? scope[0] : null;

    function collect(getList) {
      var entries = [];
      getList().forEach(function (stage) {
        entries = entries.concat(
          tab === "research" ? stageDisplay(stage, name, selected) : stage.entries
        );
      });
      return entries;
    }

    var scopeDirect = aggregate(collect(function () { return scope; }));
    var scopeReq = expand(scopeDirect, null);

    // 生産ラボ・本部は「次の金額」= 選択中のレベルの1つ上の金。研究は今の位置〜段階末の金。
    var goldStage = focusStage
      ? (tab === "research"
          ? stageGold(focusStage, name, selected, tab)
          : focusStage.gold)
      : 0;

    setText(
      "stat-label-stage",
      tab === "research"
        ? "この段階をすべて終わらせるまでに必要な金額"
        : "次の金額"
    );
    setText("stat-gold-stage", focusStage ? fmt(goldStage) : "—");
    setText(
      "range-readout",
      def.label + "の最大" + def.levelWord + ": " + def.max
    );
    setText(
      "stage-detail-title",
      tab === "research" ? "研究の段階ごとの内訳" : "段階ごとの内訳"
    );
    updateOwnedMeta();

    // 「残り必要数」= 実際に生産すべき数。所持を上位から階層的に差し引き、
    // 上位の不足分(作る数)に応じて下位素材の必要数も連動して減る。
    var remainReq = craftNumber(scopeDirect, state.owned);

    var mainRows = MATERIALS.filter(function (m) {
      return (
        (scopeReq.get(m.id) || 0) > 0 ||
        (!name && focusStage && (state.owned[m.id] || 0) > 0)
      );
    });
    mainRows.sort(function (a, b) {
      return rowCmp(a, b, remainReq);
    });

    document.getElementById("main-body").innerHTML = mainRows.length
      ? mainRows
          .map(function (m) {
            return mainRow(m, remainReq);
          })
          .join("")
      : emptyRow(
          3,
          focusStage
            ? "この範囲で必要な素材はありません。"
            : "素材必要なし(最大" + def.levelWord + "です)。"
        );

    // 段階内訳は、生産ラボ・本部と同じく全段階を常に表示する。
    // 研究名による絞り込みは上の必要素材集計にだけ使い、内訳では完了/現在の表示に使う。
    var stageList = def.stages;
    // 生産ラボ・本部は「選択Lvの1つ上」が作業中の段階。研究は選択段階そのものが現在地。
    var currentWork = tab === "research" ? selected : selected + 1;

    var metaGold = 0;
    var rows = [];

    // 開いていた段階の研究内訳は再描画後も開いたままにする(アコーディオン)。
    var openStages = Object.create(null);
    var openNodes = document.querySelectorAll("#stage-body .stage-detail[open]");
    for (var oi = 0; oi < openNodes.length; oi++) {
      openStages[openNodes[oi].getAttribute("data-stage")] = true;
    }

    if (tab !== "research") {
      // Lv.1 は生産ラボ・本部の初期状態(素材要件なし)。内訳にも明示する。
      rows.push(
        '<tr><td class="stage-cell" data-label="段階"><span class="stage-no">' +
          esc(stageLabel(tab, 1)) +
          "</span>" +
          (1 < currentWork ? '<span class="stage-status is-done">完了</span>' : "") +
          '</td><td class="cell-materials" data-label="必要素材"><div class="chips">' +
          '<span class="chip-note">初期状態(必要素材なし)</span>' +
          "</div></td>" +
          '<td data-label="金"><span class="num">—</span></td></tr>'
      );
    }
    stageList.forEach(function (stage) {
      metaGold += stage.gold;
      rows.push(
        stageRow(stage, stage.entries, selected, tab, stage.gold, currentWork, name)
      );
    });
    document.getElementById("stage-body").innerHTML = rows.join("");

    var detailNodes = document.querySelectorAll("#stage-body .stage-detail");
    for (var di = 0; di < detailNodes.length; di++) {
      var detailNode = detailNodes[di];
      if (openStages[detailNode.getAttribute("data-stage")]) {
        detailNode.open = true;
      }
      detailNode.addEventListener("toggle", onStageDetailToggle);
    }

    var rowCount = tab === "research" ? stageList.length : stageList.length + 1;
    setText(
      "stage-meta",
      (name ? "現在: " + name + " / " : "") +
        "全" + rowCount + "段階 / 金 " +
        fmt(metaGold)
    );
  }

  // ---------- owned inputs ----------

  function ownedItem(m) {
    var icon = m.icon
      ? '<img class="mat-icon" src="' + m.icon + '" alt="" width="28" height="28">'
      : '<span class="mat-icon-fallback" aria-hidden="true">' + esc(m.name.charAt(0)) + "</span>";
    var label = document.createElement("label");
    label.className = "owned-item";
    label.dataset.name = m.name;
    label.dataset.tier = String(m.level);
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

    var items = MATERIALS.slice().sort(function (a, b) {
      if (a.level !== b.level) return b.level - a.level;
      return idNum(a.id) - idNum(b.id);
    });

    var grid = document.createElement("div");
    grid.className = "owned-grid";
    items.forEach(function (m) {
      grid.appendChild(ownedItem(m));
    });
    body.appendChild(grid);
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

  // ---------- dialogs ----------

  function showDialog(dialog) {
    if (!dialog || dialog.open) return;
    dialog.showModal();
    document.documentElement.classList.add("modal-open");
  }

  function closeDialog(dialog) {
    if (!dialog || !dialog.open) return;
    dialog.close();
  }

  function bindDialog(dialog) {
    if (!dialog) return;
    dialog.addEventListener("close", function () {
      if (!document.querySelector("dialog[open]")) {
        document.documentElement.classList.remove("modal-open");
      }
    });
    dialog.addEventListener("click", function (event) {
      // パネル外(バックドロップ)をクリックしたときだけ閉じる。
      if (event.target === dialog) closeDialog(dialog);
    });
  }

  var ownedFilter = { query: "", tier: "all" };

  function applyOwnedFilter() {
    var query = ownedFilter.query.trim().toLowerCase();
    var items = document.querySelectorAll("#owned-body .owned-item");
    var visible = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var name = (item.getAttribute("data-name") || "").toLowerCase();
      var tier = item.getAttribute("data-tier");
      var show =
        (ownedFilter.tier === "all" || tier === ownedFilter.tier) &&
        (!query || name.indexOf(query) >= 0);
      item.hidden = !show;
      if (show) visible++;
    }
    var empty = document.getElementById("owned-empty");
    if (empty) empty.hidden = visible > 0;
  }

  function resetOwnedFilter() {
    ownedFilter.query = "";
    ownedFilter.tier = "all";
    var search = document.getElementById("owned-search");
    if (search) search.value = "";
    var buttons = document.querySelectorAll("#owned-tier-filter .tier-filter-btn");
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].getAttribute("data-tier") === "all";
      buttons[i].classList.toggle("is-active", active);
      buttons[i].setAttribute("aria-pressed", active ? "true" : "false");
    }
    applyOwnedFilter();
  }

  function openOwnedDialog(focusId) {
    var dialog = document.getElementById("owned-dialog");
    if (!dialog) return;
    resetOwnedFilter();
    var body = dialog.querySelector(".owned-body");
    if (body) body.scrollTop = 0;
    showDialog(dialog);
    if (!focusId) return;
    var input = dialog.querySelector('input[data-id="' + focusId + '"]');
    if (!input) return;
    window.setTimeout(function () {
      input.focus();
      input.scrollIntoView({ block: "center" });
    }, 0);
  }

  // ---------- tabs and selector ----------

  function updateTabsUI() {
    document.body.setAttribute("data-tab", state.tab);
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
    // Lv.1 はデータ段階がなくても「現在のレベル」として選べるようにする。
    for (var value = def.min; value <= def.max; value++) {
      var option = document.createElement("option");
      option.value = String(value);
      option.textContent = stageLabel(state.tab, value);
      if (value === state.selected[state.tab]) option.selected = true;
      select.appendChild(option);
    }
    setText(
      "stage-label",
      "現在の" + def.levelWord
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

    if (saved.tab === "lab" || saved.tab === "research" || saved.tab === "hq") {
      state.tab = saved.tab;
    }
    if (saved.selected && typeof saved.selected === "object") {
      state.selected.lab = clampStage("lab", saved.selected.lab);
      state.selected.research = clampStage("research", saved.selected.research);
      state.selected.hq = clampStage("hq", saved.selected.hq);
    }
    if (typeof saved.researchName === "string") {
      state.researchName = saved.researchName;
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
        researchName: state.researchName,
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

    var resetButton = document.getElementById("reset-owned");
    if (resetButton) resetButton.addEventListener("click", resetOwned);

    var openOwned = document.getElementById("open-owned");
    if (openOwned) {
      openOwned.addEventListener("click", function () {
        openOwnedDialog("");
      });
    }

    var openInfo = document.getElementById("open-info");
    if (openInfo) {
      openInfo.addEventListener("click", function () {
        showDialog(document.getElementById("info-dialog"));
      });
    }

    var closeButtons = document.querySelectorAll("[data-close]");
    for (var ci = 0; ci < closeButtons.length; ci++) {
      closeButtons[ci].addEventListener("click", function (event) {
        closeDialog(event.currentTarget.closest("dialog"));
      });
    }

    bindDialog(document.getElementById("owned-dialog"));
    bindDialog(document.getElementById("info-dialog"));

    var ownedSearch = document.getElementById("owned-search");
    if (ownedSearch) {
      ownedSearch.addEventListener("input", function (event) {
        ownedFilter.query = event.target.value || "";
        applyOwnedFilter();
      });
    }

    var tierFilter = document.getElementById("owned-tier-filter");
    if (tierFilter) {
      tierFilter.addEventListener("click", function (event) {
        var button = event.target.closest(".tier-filter-btn");
        if (!button) return;
        ownedFilter.tier = button.getAttribute("data-tier");
        var buttons = tierFilter.querySelectorAll(".tier-filter-btn");
        for (var bi = 0; bi < buttons.length; bi++) {
          var active = buttons[bi] === button;
          buttons[bi].classList.toggle("is-active", active);
          buttons[bi].setAttribute("aria-pressed", active ? "true" : "false");
        }
        applyOwnedFilter();
      });
    }

    document.getElementById("main-body").addEventListener("click", function (event) {
      var button = event.target.closest(".owned-link");
      if (!button) return;
      openOwnedDialog(button.getAttribute("data-owned-id"));
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

    document
      .getElementById("research-name-select")
      .addEventListener("change", function (event) {
        state.researchName = event.target.value || "";
        scheduleSave();
        renderComputed();
        announce(
          state.researchName
            ? "研究「" + state.researchName + "」からこの段階の最後までを集計します"
            : "未着手から集計します"
        );
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

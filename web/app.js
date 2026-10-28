/**
 * FORGE-002 UI bound to GET /v1/read/*.
 * Ring lock: move ← active_kcal, exercise ← exercise_minutes, stand ← stand_hours.
 * Goals stay the FORGE-002 presentation targets; they are not database columns.
 */
(function () {
  "use strict";

  const THEME_KEY = "marco-theme";
  const GOALS = {
    active_kcal: 650,
    exercise_minutes: 30,
    stand_hours: 12,
    steps: 10000,
  };

  const ZONE_ORDER = ["warm_up", "fat_burning", "aerobic", "anaerobic", "extreme"];
  const ZONE_PRESENT = {
    warm_up: { name: "热身", color: "var(--zone-warm)" },
    fat_burning: { name: "燃脂", color: "var(--zone-fat)" },
    aerobic: { name: "有氧", color: "var(--zone-aero)" },
    anaerobic: { name: "无氧", color: "var(--zone-anaero)" },
    extreme: { name: "极限", color: "var(--zone-max)" },
  };

  const STAGE_ORDER = ["deep", "light", "rem", "awake"];
  const STAGE_PRESENT = {
    deep: { name: "深睡", color: "var(--sleep-deep)" },
    light: { name: "浅睡", color: "var(--sleep-light)" },
    rem: { name: "REM", color: "var(--sleep-rem)" },
    awake: { name: "清醒", color: "var(--sleep-awake)" },
  };

  const state = {
    today: null,
    trends: { week: null, month: null },
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function clampPct(n) {
    return Math.max(0, Math.min(100, n));
  }

  function avgPresent(arr) {
    const nums = arr.filter((value) => typeof value === "number" && Number.isFinite(value));
    if (!nums.length) return 0;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
  }

  function formatNum(n) {
    return Math.round(n).toLocaleString("zh-CN");
  }

  function formatMetric(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const number = Number(value);
    if (Number.isInteger(number)) return formatNum(number);
    return number.toLocaleString("zh-CN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function chartLabelFill() {
    const theme = document.documentElement.getAttribute("data-theme") || "dark";
    return theme === "light" ? "rgba(60,60,67,0.5)" : "rgba(235,235,245,0.45)";
  }

  function lineDotStroke() {
    const theme = document.documentElement.getAttribute("data-theme") || "dark";
    return theme === "light" ? "#ffffff" : "#000000";
  }

  function formatDayLabel(day) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    if (!match) return day || "";
    const month = Number(match[2]);
    const date = Number(match[3]);
    const weekday = new Date(Date.UTC(Number(match[1]), month - 1, date)).getUTCDay();
    const names = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    return names[weekday] + " · " + month + "月" + date + "日";
  }

  function clock(iso) {
    const match = /T(\d{2}):(\d{2})/.exec(iso || "");
    return match ? match[1] + ":" + match[2] : "";
  }

  function formatStamp(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
    if (!match) return iso || "";
    return Number(match[2]) + "月" + Number(match[3]) + "日 " + match[4] + ":" + match[5];
  }

  function minutesBetween(start, end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.round(ms / 60000);
  }

  function getTheme() {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch (e) {}
    return "dark";
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) {}
    const label = $("#theme-label");
    if (label) label.textContent = next === "light" ? "浅色" : "深色";
    $$(".theme-switch").forEach((btn) => {
      btn.setAttribute("aria-pressed", next === "light" ? "true" : "false");
    });
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute("content", next);
    if (state.trends.week || state.trends.month) renderTrends(currentRange());
  }

  function toggleTheme() {
    applyTheme(getTheme() === "light" ? "dark" : "light");
  }

  function bindTheme() {
    applyTheme(getTheme());
    $$(".theme-toggle, .theme-switch").forEach((btn) => {
      btn.addEventListener("click", toggleTheme);
    });
  }

  function currentRange() {
    const active = $(".seg-btn.is-active");
    return active && active.dataset.range === "month" ? "month" : "week";
  }

  function animateRings() {
    const today = state.today;
    if (!today) return;
    const move = today.rings.move.active_kcal;
    const exercise = today.rings.exercise.exercise_minutes;
    const stand = today.rings.stand.stand_hours;
    const setRing = (id, current, goal) => {
      const el = $(id);
      if (!el) return;
      const pct = current == null ? 0 : clampPct((current / goal) * 100);
      requestAnimationFrame(() => {
        el.setAttribute("stroke-dasharray", Math.min(pct, 100) + " 100");
      });
    };
    setTimeout(() => setRing("#ring-move", move, GOALS.active_kcal), 80);
    setTimeout(() => setRing("#ring-exercise", exercise, GOALS.exercise_minutes), 200);
    setTimeout(() => setRing("#ring-stand", stand, GOALS.stand_hours), 320);

    const wrap = $(".rings-svg-wrap");
    if (wrap) {
      wrap.setAttribute(
        "aria-label",
        "活动圆环：活动 " +
          formatMetric(move) +
          "/" +
          GOALS.active_kcal +
          " 千卡，锻炼 " +
          formatMetric(exercise) +
          "/" +
          GOALS.exercise_minutes +
          " 分钟，站立 " +
          formatMetric(stand) +
          "/" +
          GOALS.stand_hours +
          " 小时",
      );
    }
  }

  function bucketHours(points) {
    const hours = Array.from({ length: 24 }, () => 0);
    let any = false;
    (points || []).forEach((point) => {
      const match = /T(\d{2})/.exec(point.started_at || "");
      if (!match) return;
      const hour = Number(match[1]);
      if (hour < 0 || hour > 23) return;
      hours[hour] += Number(point.value_num) || 0;
      any = true;
    });
    return any ? hours : null;
  }

  function renderStepsSpark() {
    const svg = $("#steps-spark");
    const wrap = $("#steps-spark-wrap");
    if (!svg) return;
    const data = bucketHours(state.today && state.today.steps_minute);
    if (!data) {
      svg.innerHTML = "";
      svg.setAttribute("aria-label", "暂无分时步数");
      if (wrap) wrap.hidden = true;
      return;
    }
    if (wrap) wrap.hidden = false;
    const w = 320;
    const h = 48;
    const max = Math.max.apply(null, data.concat([1]));
    const pad = 2;
    const stepX = (w - pad * 2) / (data.length - 1 || 1);
    const points = data.map((value, index) => {
      const x = pad + index * stepX;
      const y = h - pad - (value / max) * (h - pad * 2);
      return [x, y];
    });
    let d = "";
    points.forEach((point, index) => {
      d += (index === 0 ? "M" : "L") + point[0].toFixed(1) + " " + point[1].toFixed(1) + " ";
    });
    const area = d + " L " + points[points.length - 1][0].toFixed(1) + " " + h + " L " + points[0][0].toFixed(1) + " " + h + " Z";
    svg.setAttribute("aria-label", "今日步数火花图");
    svg.innerHTML =
      '<defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#92e82a" stop-opacity="0.35"/>' +
      '<stop offset="100%" stop-color="#92e82a" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' +
      area +
      '" fill="url(#sparkFill)"/>' +
      '<path d="' +
      d +
      '" fill="none" stroke="#92e82a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  }

  function renderHRZones() {
    const list = $("#hr-zones");
    if (!list || !state.today) return;
    const zones = state.today.hr_zone_minutes || {};
    const ordered = ZONE_ORDER.filter((id) => Object.prototype.hasOwnProperty.call(zones, id)).map((id) => ({
      id: id,
      name: ZONE_PRESENT[id].name,
      color: ZONE_PRESENT[id].color,
      mins: Number(zones[id]) || 0,
    }));
    Object.keys(zones).forEach((id) => {
      if (ZONE_ORDER.indexOf(id) !== -1) return;
      ordered.push({ id: id, name: id, color: "var(--zone-rest)", mins: Number(zones[id]) || 0 });
    });
    const maxMins = Math.max.apply(null, ordered.map((zone) => zone.mins).concat([1]));
    list.innerHTML = ordered
      .map((zone) => {
        return (
          '<li class="zone-item"><span class="zone-name">' +
          escapeHtml(zone.name) +
          '</span><div class="zone-bar-track" role="presentation"><div class="zone-bar-fill" data-pct="' +
          (zone.mins / maxMins) * 100 +
          '" style="background:' +
          zone.color +
          '"></div></div><span class="zone-mins">' +
          Math.round(zone.mins) +
          " 分</span></li>"
        );
      })
      .join("");
    requestAnimationFrame(() => {
      $$(".zone-bar-fill", list).forEach((el) => {
        el.style.width = el.getAttribute("data-pct") + "%";
      });
    });
  }

  function sleepTotals(sleep, stages) {
    const fields = {
      deep: sleep ? sleep.deep_min : null,
      light: sleep ? sleep.light_min : null,
      rem: sleep ? sleep.rem_min : null,
      awake: sleep ? sleep.awake_min : null,
    };
    const anyField = STAGE_ORDER.some((id) => fields[id] != null);
    return STAGE_ORDER.map((id) => {
      let mins = 0;
      let known = false;
      if (anyField) {
        known = fields[id] != null;
        mins = known ? Math.max(0, Math.round(Number(fields[id]))) : 0;
      } else {
        stages.forEach((stage) => {
          if (stage.stage !== id) return;
          const span = minutesBetween(stage.started_at, stage.ended_at);
          if (span > 0) {
            known = true;
            mins += span;
          }
        });
      }
      return {
        id: id,
        name: STAGE_PRESENT[id].name,
        color: STAGE_PRESENT[id].color,
        mins: mins,
        known: known,
      };
    });
  }

  function stageBarHtml(stage) {
    return (
      '<div class="sleep-seg" style="flex:' +
      Math.max(stage.mins, 1) +
      ";background:" +
      stage.color +
      '" title="' +
      escapeHtml(stage.name + " " + formatMinutes(stage.mins)) +
      '"></div>'
    );
  }

  function formatMinutes(total) {
    const mins = Math.max(0, Math.round(total));
    const hours = Math.floor(mins / 60);
    const rest = mins % 60;
    if (hours > 0) return hours + "小时" + rest + "分";
    return rest + "分";
  }

  function renderSleep() {
    const sleep = state.today && state.today.sleep;
    const bar = $("#sleep-stages");
    const legend = $("#stage-legend");
    const wrap = $("#sleep-stages-wrap");
    const meta = $("#sleep-meta");
    if (!bar || !legend || !wrap || !meta) return;
    const stages = sleep && Array.isArray(sleep.stages) ? sleep.stages : [];
    const totals = sleepTotals(sleep, stages);
    const known = totals.filter((stage) => stage.known);
    const positive = totals.filter((stage) => stage.mins > 0);
    if (known.length === 0 && stages.length === 0) {
      wrap.hidden = true;
      bar.innerHTML = "";
      legend.innerHTML = "";
      bar.setAttribute("aria-label", "暂无睡眠阶段");
    } else {
      wrap.hidden = false;
      const timeline = stages.length > 0 && positive.length > 0;
      bar.classList.toggle("is-timeline", timeline);
      if (timeline) {
        bar.innerHTML = stages
          .map((stage) => {
            const present = STAGE_PRESENT[stage.stage];
            if (!present) return "";
            const mins = minutesBetween(stage.started_at, stage.ended_at);
            if (mins <= 0) return "";
            return stageBarHtml({ name: present.name, color: present.color, mins: mins });
          })
          .join("");
        bar.setAttribute(
          "aria-label",
          "睡眠阶段时间线：" +
            stages
              .map((stage) => {
                const present = STAGE_PRESENT[stage.stage];
                if (!present) return "";
                return present.name + " " + formatMinutes(minutesBetween(stage.started_at, stage.ended_at));
              })
              .filter(Boolean)
              .join("，"),
        );
      } else if (positive.length > 0) {
        bar.innerHTML = positive.map(stageBarHtml).join("");
        bar.setAttribute(
          "aria-label",
          "睡眠阶段：" + positive.map((stage) => stage.name + " " + formatMinutes(stage.mins)).join("，"),
        );
      } else {
        bar.innerHTML = "";
        bar.setAttribute("aria-label", "暂无睡眠阶段时长");
      }
      const legendRows = known.length > 0 ? known : positive;
      legend.innerHTML = legendRows
        .map((stage) => {
          return (
            '<li><span class="swatch" style="background:' +
            stage.color +
            '"></span>' +
            escapeHtml(stage.name) +
            "<strong>" +
            formatMinutes(stage.mins) +
            "</strong></li>"
          );
        })
        .join("");
    }
    const chips = sleepChips(sleep);
    meta.hidden = chips.length === 0;
    meta.innerHTML = chips
      .map((chip) => {
        return (
          '<li><span class="meta-label">' +
          escapeHtml(chip.label) +
          '</span><span class="meta-value">' +
          escapeHtml(chip.value) +
          "</span></li>"
        );
      })
      .join("");
  }

  function sleepChips(sleep) {
    if (!sleep) return [];
    const chips = [];
    if (sleep.efficiency != null) chips.push({ label: "睡眠效率", value: formatMetric(sleep.efficiency) + "%" });
    if (sleep.awake_count != null) chips.push({ label: "清醒次数", value: formatMetric(sleep.awake_count) + " 次" });
    if (sleep.avg_hr_bpm != null) {
      let value = formatMetric(sleep.avg_hr_bpm) + " 次/分";
      if (sleep.min_hr_bpm != null && sleep.max_hr_bpm != null) {
        value = formatMetric(sleep.avg_hr_bpm) + "（" + formatMetric(sleep.min_hr_bpm) + "–" + formatMetric(sleep.max_hr_bpm) + "）";
      }
      chips.push({ label: "睡眠心率", value: value });
    }
    if (sleep.avg_spo2 != null) chips.push({ label: "睡眠血氧", value: formatMetric(sleep.avg_spo2) + "%" });
    return chips;
  }

  function workoutVisual(sport) {
    if (sport === "outdoor_running" || sport === "running" || sport === "indoor_running") {
      return { icon: "🏃", bg: "rgba(146,232,42,0.18)" };
    }
    if (sport === "cycling" || sport === "outdoor_cycling" || sport === "indoor_cycling") {
      return { icon: "🚴", bg: "rgba(0,212,255,0.18)" };
    }
    if (sport === "strength" || sport === "strength_training") {
      return { icon: "💪", bg: "rgba(250,17,79,0.18)" };
    }
    if (sport === "yoga") return { icon: "🧘", bg: "rgba(191,90,242,0.18)" };
    return { icon: "🏅", bg: "rgba(100,210,255,0.18)" };
  }

  function renderWorkouts() {
    const list = $("#workout-list");
    if (!list || !state.today) return;
    const workouts = state.today.workouts || [];
    if (!workouts.length) {
      list.innerHTML = '<li class="workout-item"><div class="workout-info"><p class="workout-name">暂无锻炼</p></div></li>';
      return;
    }
    list.innerHTML = workouts
      .map((workout) => {
        const visual = workoutVisual(workout.sport_type);
        const name = workout.title || workout.sport_type_label || workout.sport_type || "锻炼";
        const parts = [formatStamp(workout.started_at)];
        if (workout.duration_sec != null) parts.push(Math.round(workout.duration_sec / 60) + " 分钟");
        if (workout.distance_m != null) parts.push((workout.distance_m / 1000).toFixed(1) + " 公里");
        const cal = workout.active_kcal == null ? "—" : formatMetric(workout.active_kcal);
        return (
          '<li class="workout-item"><div class="workout-icon" style="background:' +
          visual.bg +
          '" aria-hidden="true">' +
          visual.icon +
          '</div><div class="workout-info"><p class="workout-name">' +
          escapeHtml(name) +
          '</p><p class="workout-meta">' +
          escapeHtml(parts.join(" · ")) +
          '</p></div><span class="workout-cal">' +
          cal +
          " 千卡</span></li>"
        );
      })
      .join("");
  }

  function barChart(container, series, opts) {
    if (!container) return;
    const labels = opts.labels;
    const colors = opts.colors;
    const height = opts.height || 140;
    const maxVal = opts.maxVal;
    const ariaPrefix = opts.ariaPrefix || "图表";
    const n = labels.length;
    const values = Array.isArray(series[0]) ? series : [series];
    const colorList = colors || ["#92e82a"];
    const flat = values.reduce((all, row) => all.concat(row), []);
    const max = maxVal || Math.max.apply(null, flat.concat([1])) * 1.1;
    const w = 340;
    const h = height;
    const padL = 4;
    const padR = 4;
    const padT = 8;
    const padB = 22;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const groupW = chartW / n;
    const barGap = 3;
    const barCount = values.length;
    const barW = Math.max(2, Math.min(14, (groupW - 8 - (barCount - 1) * barGap) / barCount));
    const labelFill = chartLabelFill();
    let bars = "";
    values.forEach((arr, si) => {
      arr.forEach((value, index) => {
        const bh = Math.max(2, (value / max) * chartH);
        const x = padL + index * groupW + (groupW - barCount * barW - (barCount - 1) * barGap) / 2 + si * (barW + barGap);
        const y = padT + chartH - bh;
        bars +=
          '<rect x="' +
          x.toFixed(1) +
          '" y="' +
          y.toFixed(1) +
          '" width="' +
          barW +
          '" height="' +
          bh.toFixed(1) +
          '" rx="3" fill="' +
          colorList[si % colorList.length] +
          '" opacity="0.95"><title>' +
          escapeHtml(labels[index] + ": " + value) +
          "</title></rect>";
      });
    });
    const labelEls = labels
      .map((label, index) => {
        const x = padL + index * groupW + groupW / 2;
        return (
          '<text x="' +
          x.toFixed(1) +
          '" y="' +
          (h - 6) +
          '" text-anchor="middle" fill="' +
          labelFill +
          '" font-size="10" font-family="system-ui,sans-serif">' +
          escapeHtml(label) +
          "</text>"
        );
      })
      .join("");
    container.innerHTML = '<svg viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="' + escapeHtml(ariaPrefix) + '">' + bars + labelEls + "</svg>";
  }

  function lineChart(container, data, labels, opts) {
    if (!container) return;
    const color = (opts && opts.color) || "#ff2d55";
    const w = 340;
    const h = 120;
    const padL = 8;
    const padR = 8;
    const padT = 12;
    const padB = 22;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;
    const nums = data.filter((value) => typeof value === "number" && Number.isFinite(value));
    const min = (nums.length ? Math.min.apply(null, nums) : 0) - 2;
    const max = (nums.length ? Math.max.apply(null, nums) : 1) + 2;
    const range = max - min || 1;
    const labelFill = chartLabelFill();
    const dotStroke = lineDotStroke();
    let d = "";
    let drawing = false;
    const dots = [];
    data.forEach((value, index) => {
      const x = padL + (data.length > 1 ? (index / (data.length - 1)) * chartW : 0);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        drawing = false;
        return;
      }
      const y = padT + chartH - ((value - min) / range) * chartH;
      d += (drawing ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " ";
      drawing = true;
      dots.push(
        '<circle cx="' +
          x.toFixed(1) +
          '" cy="' +
          y.toFixed(1) +
          '" r="3.5" fill="' +
          color +
          '" stroke="' +
          dotStroke +
          '" stroke-width="1.5"><title>' +
          escapeHtml(value) +
          "</title></circle>",
      );
    });
    const labelEls = labels
      .map((label, index) => {
        const x = padL + (data.length > 1 ? (index / (data.length - 1)) * chartW : 0);
        return (
          '<text x="' +
          x.toFixed(1) +
          '" y="' +
          (h - 6) +
          '" text-anchor="middle" fill="' +
          labelFill +
          '" font-size="10" font-family="system-ui,sans-serif">' +
          escapeHtml(label) +
          "</text>"
        );
      })
      .join("");
    container.innerHTML =
      '<svg viewBox="0 0 ' +
      w +
      " " +
      h +
      '" role="img" aria-label="' +
      escapeHtml((opts && opts.aria) || "折线图") +
      '"><path d="' +
      d +
      '" fill="none" stroke="' +
      color +
      '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      dots.join("") +
      labelEls +
      "</svg>";
  }

  function renderTrends(range) {
    const trend = state.trends[range] || state.trends.week;
    if (!trend) return;
    const days = trend.days || [];
    const labels = days.map((day) => day.label);
    const isWeek = range === "week";
    barChart($("#chart-rings"), [
      days.map((day) => (day.active_kcal == null ? 0 : Math.round((day.active_kcal / GOALS.active_kcal) * 100))),
      days.map((day) => (day.exercise_minutes == null ? 0 : Math.round((day.exercise_minutes / GOALS.exercise_minutes) * 100))),
      days.map((day) => (day.stand_hours == null ? 0 : Math.round((day.stand_hours / GOALS.stand_hours) * 100))),
    ], {
      labels: labels,
      colors: ["#fa114f", "#92e82a", "#00d4ff"],
      maxVal: 130,
      ariaPrefix: "三环完成度百分比柱状图",
    });

    const steps = days.map((day) => day.steps);
    barChart($("#chart-steps"), steps.map((value) => (value == null ? 0 : value)), {
      labels: labels,
      colors: ["#92e82a"],
      ariaPrefix: "步数趋势柱状图",
    });
    const avgLabel = $("#steps-avg-label");
    if (avgLabel) avgLabel.textContent = isWeek ? "日均" : "周均";
    const stepsAvg = $("#steps-avg");
    if (stepsAvg) stepsAvg.textContent = formatNum(avgPresent(steps));

    const hr = days.map((day) => day.resting_hr_bpm);
    lineChart($("#chart-hr"), hr, labels, { color: "#ff2d55", aria: "静息心率折线图" });
    const hrAvg = $("#hr-avg");
    if (hrAvg) hrAvg.textContent = String(Math.round(avgPresent(hr)));

    const sleep = days.map((day) => day.sleep_hours);
    barChart($("#chart-sleep"), sleep.map((value) => (value == null ? 0 : value)), {
      labels: labels,
      colors: ["#5e5ce6"],
      maxVal: 10,
      ariaPrefix: "睡眠时长柱状图（小时）",
    });
    const sleepAvg = $("#sleep-avg");
    if (sleepAvg) sleepAvg.textContent = avgPresent(sleep).toFixed(1);

    const calories = days.map((day) => day.active_kcal);
    barChart($("#chart-cal"), calories.map((value) => (value == null ? 0 : value)), {
      labels: labels,
      colors: ["#ff375f"],
      ariaPrefix: "活动消耗柱状图",
    });
    const calAvg = $("#cal-avg");
    if (calAvg) calAvg.textContent = formatNum(avgPresent(calories));
  }

  function switchTab(name) {
    $$(".tab-panel").forEach((panel) => {
      const on = panel.dataset.tab === name;
      panel.hidden = !on;
      panel.classList.toggle("is-active", on);
    });
    $$(".tab-btn").forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const main = $("#main-content");
    if (main) main.scrollTop = 0;
  }

  function bindTabs() {
    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
    const bar = $(".tab-bar");
    if (!bar) return;
    bar.addEventListener("keydown", (event) => {
      const tabs = $$(".tab-btn");
      const index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      let next = index;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = tabs.length - 1;
      else return;
      event.preventDefault();
      tabs[next].focus();
      switchTab(tabs[next].dataset.tab);
    });
  }

  function bindRange() {
    $$(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".seg-btn").forEach((item) => {
          item.classList.toggle("is-active", item === btn);
          item.setAttribute("aria-selected", item === btn ? "true" : "false");
        });
        renderTrends(btn.dataset.range);
      });
    });
  }

  function sleepQuality(score) {
    if (score == null) return "暂无";
    if (score >= 85) return "优质";
    if (score >= 70) return "良好";
    if (score >= 50) return "一般";
    return "较差";
  }

  function text(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function hydrate() {
    const today = state.today;
    if (!today) return;
    const eyebrow = $("#tab-today .eyebrow");
    if (eyebrow) eyebrow.textContent = formatDayLabel(today.day);
    text("move-value", formatMetric(today.rings.move.active_kcal));
    text("exercise-value", formatMetric(today.rings.exercise.exercise_minutes));
    text("stand-value", formatMetric(today.rings.stand.stand_hours));

    const steps = today.steps;
    const stepsPct = steps == null ? 0 : Math.round(Math.min(100, (steps / GOALS.steps) * 100));
    text("steps-value", steps == null ? "—" : formatNum(steps));
    text("steps-pct", stepsPct + "%");
    const bar = $("#steps-bar");
    if (bar) {
      bar.style.width = stepsPct + "%";
      const progress = bar.parentElement;
      if (progress) progress.setAttribute("aria-valuenow", String(stepsPct));
    }
    text("distance-value", today.distance_m == null ? "—" : (today.distance_m / 1000).toFixed(1));
    const floors = $("#floors-line");
    if (floors) floors.hidden = today.floors == null;
    if (today.floors != null) text("floors-value", formatNum(today.floors));

    text("hr-resting", formatMetric(today.resting_hr_bpm));
    const restingNote = $("#hr-resting-note");
    if (restingNote) restingNote.textContent = today.source === "fixture" ? "样例日汇总" : "日汇总";
    const recent = (today.heart_rate || [])[today.heart_rate.length - 1];
    text("hr-recent", recent ? formatMetric(recent.bpm) : "—");
    const recentTime = $("#hr-recent-time");
    if (recentTime) recentTime.textContent = recent ? clock(recent.started_at) + " 测量" : "暂无测量";

    const session = today.sleep;
    const duration = session ? minutesBetween(session.started_at, session.ended_at) : null;
    text("sleep-duration", duration == null ? "—" : String(Math.floor(duration / 60)));
    text("sleep-mins", duration == null ? "—" : String(duration % 60));
    const windowLabel = $("#sleep-window");
    if (windowLabel) windowLabel.textContent = session ? clock(session.started_at) + " — " + clock(session.ended_at) : "暂无睡眠";
    const score = session && session.score != null ? session.score : today.sleep_score;
    text("sleep-score", formatMetric(score));
    const quality = $("#sleep-quality");
    if (quality) quality.textContent = sleepQuality(score);

    text("cal-active", formatMetric(today.active_kcal));
    text("cal-total", "—");
    const totalUnit = $("#cal-total-unit");
    if (totalUnit) totalUnit.hidden = true;

    const status = $("#device-status");
    if (status) status.textContent = today.source === "db" ? "已同步 · 数据库" : "样例数据 · 夹具回放";
    const hint = $("#device-hint");
    if (hint) {
      hint.textContent =
        today.source === "db"
          ? "数据来自 Postgres 日汇总与相关记录。时区 Asia/Shanghai。"
          : "这一天没有入库记录，界面回放 fixtures/mi_health 样例。响应带 source: fixture。";
    }
  }

  async function loadJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(url + " failed");
    return response.json();
  }

  async function loadAndPaint() {
    state.today = await loadJson("/v1/read/today");
    const day = encodeURIComponent(state.today.day);
    const [week, month] = await Promise.all([
      loadJson("/v1/read/trends?range=week&day=" + day),
      loadJson("/v1/read/trends?range=month&day=" + day),
    ]);
    state.trends.week = week;
    state.trends.month = month;
    hydrate();
    animateRings();
    renderStepsSpark();
    renderHRZones();
    renderSleep();
    renderWorkouts();
    renderTrends(currentRange());
  }

  function init() {
    bindTheme();
    bindTabs();
    bindRange();
    loadAndPaint().catch(() => {
      const eyebrow = $("#tab-today .eyebrow");
      if (eyebrow) eyebrow.textContent = "数据加载失败";
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

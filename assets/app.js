/* ============================================================
 * 分析配置生成器 · semi-auto
 * 纯原生 JS，无任何外部依赖
 *
 * 配置结构（semi-auto.json）：
 *   { "version": 1.0,
 *     "product": { 产品: { 分析类型: { 字段: { required: true|false, type: "str" } } } } }
 * ============================================================ */

(function () {
  'use strict';

  var STORE_KEY = 'semi-auto:state';
  var API = '/api/config';
  var SEP = '||';   // 可安全放进 HTML 属性 / localStorage 的分隔符

  /* 静态部署（无后端）时的兜底配置，结构与 semi-auto.json 一致 */
  var DEFAULT_CONFIG = {
    version: 1.0,
    product: {
      '扩增子': {
        '环境因子分析': {
          '分期号': { required: true, type: 'str' },
          '结果文件': { required: true, type: 'str' },
          '上传分期': { required: false, type: 'str' },
          '信息搜集表': { required: false, type: 'str' }
        },
        'alpha分析': {
          '分期号': { required: true, type: 'str' },
          '结果文件': { required: true, type: 'str' },
          '上传分期': { required: false, type: 'str' },
          '信息搜集表': { required: false, type: 'str' }
        }
      },
      '宏基因组': {},
      '单菌': {
        '单独用spade分析': {
          '分期号': { required: true, type: 'str' },
          '测序数据': { required: true, type: 'str' },
          '上传分期': { required: false, type: 'str' },
          '信息搜集表': { required: false, type: 'str' }
        }
      },
      '其它': {
        '释放全部数据': {
          '分期号': { required: false, type: 'str' },
          '测序数据': { required: false, type: 'str' },
          '上传分期': { required: true, type: 'str' }
        }
      }
    }
  };

  var TYPE_LABELS = {
    str: '文本', string: '文本', text: '文本',
    int: '整数', integer: '整数', float: '小数', number: '数字', double: '小数',
    bool: '布尔', boolean: '布尔',
    file: '文件', path: '路径', dir: '目录', folder: '目录',
    json: 'JSON', list: '列表', array: '数组', enum: '枚举', date: '日期'
  };

  /* ---------------- 状态 ---------------- */
  var CONFIG = null;          // 归一化后的配置（供渲染使用）
  var mode = 'loading';       // 'server' | 'static'
  var mtime = 0;
  var staticSnapshot = '';    // 静态部署时用于比对 semi-auto.json 是否变化

  var state = {
    selProduct: '',
    selAnalysis: '',
    search: '',
    checked: {},              // { key: true }
    values: {}                // { key + SEP + field: 'value' }
  };

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var elSelProduct = $('selProduct');
  var elSelAnalysis = $('selAnalysis');
  var elSearch = $('inpSearch');
  var elSearchHint = $('searchHint');
  var elList = $('analysisList');
  var elListCount = $('listCount');
  var elCheckedBar = $('checkedBar');
  var elCheckedInfo = $('checkedInfo');
  var elForm = $('formArea');
  var elFillStat = $('fillStat');
  var elOut = $('outJson');
  var elOutHint = $('outHint');
  var elValidate = $('validateBox');
  var elSrcBadge = $('srcBadge');
  var elSyncBadge = $('syncBadge');
  var elToast = $('toast');

  /* ============================================================
   * 工具函数
   * ============================================================ */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function key(p, a) { return encodeURIComponent(p) + SEP + encodeURIComponent(a); }

  function parseKey(k) {
    var i = String(k).indexOf(SEP);
    if (i === -1) return [String(k), ''];
    return [safeDecode(String(k).slice(0, i)), safeDecode(String(k).slice(i + SEP.length))];
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function valKey(p, a, f) { return key(p, a) + SEP + f; }

  function toast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { elToast.hidden = true; }, 2200);
  }

  function typeLabel(t) {
    var raw = t || 'str';
    var label = TYPE_LABELS[String(raw).toLowerCase()];
    return label ? label + ' · ' + raw : String(raw);
  }

  function nowIso() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var oh = p(Math.floor(Math.abs(off) / 60));
    var om = p(Math.abs(off) % 60);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
      sign + oh + ':' + om;
  }

  /* ============================================================
   * 配置解析
   * ============================================================ */
  function normalizeConfig(cfg) {
    var out = { version: (cfg && cfg.version) || 1.0, product: {} };
    var products = (cfg && cfg.product) || {};
    Object.keys(products).forEach(function (p) {
      var analyses = products[p] || {};
      out.product[p] = {};
      Object.keys(analyses).forEach(function (a) {
        var fields = analyses[a] || {};
        out.product[p][a] = {};
        Object.keys(fields).forEach(function (f) {
          var meta = fields[f];
          if (meta && typeof meta === 'object') {
            out.product[p][a][f] = {
              required: !!meta.required,
              type: meta.type || 'str',
              options: Array.isArray(meta.options) ? meta.options : null,
              note: typeof meta.note === 'string' ? meta.note : ''
            };
          } else {
            out.product[p][a][f] = { required: false, type: 'str', options: null, note: '' };
          }
        });
      });
    });
    return out;
  }

  /** 扁平列表：[{ product, analysis, key, fields: [{name, required, type, options}] }] */
  function listAnalyses() {
    var res = [];
    if (!CONFIG) return res;
    Object.keys(CONFIG.product).forEach(function (p) {
      Object.keys(CONFIG.product[p]).forEach(function (a) {
        var fieldMap = CONFIG.product[p][a];
        var fields = Object.keys(fieldMap).map(function (f) {
          return {
            name: f,
            required: fieldMap[f].required,
            type: fieldMap[f].type,
            options: fieldMap[f].options,
            note: fieldMap[f].note
          };
        });
        res.push({ product: p, analysis: a, key: key(p, a), fields: fields });
      });
    });
    return res;
  }

  function getAnalysis(k) {
    if (!CONFIG) return null;
    var pa = parseKey(k);
    var fieldMap = CONFIG.product[pa[0]] && CONFIG.product[pa[0]][pa[1]];
    if (!fieldMap) return null;
    var fields = Object.keys(fieldMap).map(function (f) {
      return {
        name: f,
        required: fieldMap[f].required,
        type: fieldMap[f].type,
        options: fieldMap[f].options,
        note: fieldMap[f].note
      };
    });
    return { product: pa[0], analysis: pa[1], key: k, fields: fields };
  }

  /** 当前筛选条件下可见的分析类型 */
  function visibleAnalyses() {
    var q = state.search.trim().toLowerCase();
    return listAnalyses().filter(function (x) {
      if (state.selProduct && x.product !== state.selProduct) return false;
      if (state.selAnalysis && x.key !== state.selAnalysis) return false;
      if (q) {
        var hay = (x.product + ' ' + x.analysis).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /* ============================================================
   * 渲染：下拉框
   * ============================================================ */
  function renderProductSelect() {
    var keep = state.selProduct;
    var opts = ['<option value="">全部产品</option>'];
    Object.keys(CONFIG.product).forEach(function (p) {
      var n = Object.keys(CONFIG.product[p]).length;
      opts.push('<option value="' + esc(p) + '">' + esc(p) + '（' + n + '）</option>');
    });
    elSelProduct.innerHTML = opts.join('');
    elSelProduct.value = keep && CONFIG.product[keep] !== undefined ? keep : '';
    state.selProduct = elSelProduct.value;
  }

  function renderAnalysisSelect() {
    var keep = state.selAnalysis;
    var opts = ['<option value="">全部分析类型</option>'];
    var all = listAnalyses();
    var pool = state.selProduct
      ? all.filter(function (x) { return x.product === state.selProduct; })
      : all;

    if (state.selProduct) {
      pool.forEach(function (x) {
        opts.push('<option value="' + esc(x.key) + '">' + esc(x.analysis) + '</option>');
      });
    } else {
      var byProduct = {};
      pool.forEach(function (x) { (byProduct[x.product] = byProduct[x.product] || []).push(x); });
      Object.keys(byProduct).forEach(function (p) {
        opts.push('<optgroup label="' + esc(p) + '">');
        byProduct[p].forEach(function (x) {
          opts.push('<option value="' + esc(x.key) + '">' + esc(x.analysis) + '</option>');
        });
        opts.push('</optgroup>');
      });
    }
    elSelAnalysis.innerHTML = opts.join('');
    var exists = pool.some(function (x) { return x.key === keep; });
    elSelAnalysis.value = exists ? keep : '';
    state.selAnalysis = elSelAnalysis.value;
  }

  /* ============================================================
   * 渲染：勾选列表
   * ============================================================ */
  function highlight(text, q) {
    if (!q) return esc(text);
    var lower = text.toLowerCase();
    var idx = lower.indexOf(q);
    if (idx === -1) return esc(text);
    return esc(text.slice(0, idx)) + '<mark>' + esc(text.slice(idx, idx + q.length)) + '</mark>' +
      esc(text.slice(idx + q.length));
  }

  function renderChecklist() {
    var list = visibleAnalyses();
    var q = state.search.trim().toLowerCase();
    var total = listAnalyses().length;

    if (!total) {
      elList.innerHTML = '<div class="empty">配置里还没有任何分析类型<br>请到「后台管理」添加</div>';
      elListCount.textContent = '';
      updateCheckedBar();
      return;
    }
    if (!list.length) {
      var prodEmpty = state.selProduct &&
        CONFIG.product[state.selProduct] &&
        Object.keys(CONFIG.product[state.selProduct]).length === 0;
      if (prodEmpty) {
        elList.innerHTML = '<div class="empty">「' + esc(state.selProduct) +
          '」下还没有配置分析类型<br>请到「后台管理」补充</div>';
      } else {
        elList.innerHTML = '<div class="empty">没有匹配的分析类型<br>换个关键词，或清空筛选条件</div>';
      }
      elListCount.textContent = '0 / ' + total;
      updateCheckedBar();
      return;
    }

    elList.innerHTML = list.map(function (x) {
      var reqN = x.fields.filter(function (f) { return f.required; }).length;
      var optN = x.fields.length - reqN;
      var on = !!state.checked[x.key];
      return '<label class="chk-item' + (on ? ' is-checked' : '') + '" data-key="' + esc(x.key) + '">' +
        '<input type="checkbox"' + (on ? ' checked' : '') + ' data-key="' + esc(x.key) + '">' +
        '<span class="chk-body">' +
        '<span class="chk-name">' +
        '<span class="chk-prod">' + highlight(x.product, q) + '</span>' +
        '<span class="chk-dash">—</span>' +
        highlight(x.analysis, q) +
        '</span>' +
        '<span class="chk-meta">必填 ' + reqN + ' · 选填 ' + optN + '</span>' +
        '</span></label>';
    }).join('');

    elListCount.textContent = list.length + ' / ' + total;
    updateCheckedBar();
  }

  /** 底部「已勾选 n 项」与清空按钮 */
  function updateCheckedBar() {
    var n = checkedKeysInOrder().length;
    if (elCheckedBar) elCheckedBar.hidden = n === 0;
    if (elCheckedInfo) elCheckedInfo.textContent = n ? '已勾选 ' + n + ' 个分析类型' : '';
  }

  /* ============================================================
   * 渲染：参数填写
   * ============================================================ */
  function checkedKeysInOrder() {
    return listAnalyses()
      .filter(function (x) { return state.checked[x.key]; })
      .map(function (x) { return x.key; });
  }

  function fieldInput(p, a, f, cur) {
    var v = esc(cur || '');
    var attr = 'class="val-input" data-p="' + esc(p) + '" data-a="' + esc(a) +
      '" data-f="' + esc(f.name) + '"';
    var t = String(f.type || 'str').toLowerCase();

    if (f.options && f.options.length) {
      var o = ['<option value=""></option>'];
      f.options.forEach(function (op) {
        o.push('<option value="' + esc(op) + '"' + (String(op) === String(cur) ? ' selected' : '') +
          '>' + esc(op) + '</option>');
      });
      return '<select ' + attr + '>' + o.join('') + '</select>';
    }
    if (t === 'bool' || t === 'boolean') {
      return '<select ' + attr + '>' +
        '<option value=""></option>' +
        '<option value="true"' + (cur === 'true' ? ' selected' : '') + '>true</option>' +
        '<option value="false"' + (cur === 'false' ? ' selected' : '') + '>false</option>' +
        '</select>';
    }
    if (t === 'int' || t === 'integer' || t === 'float' || t === 'number' || t === 'double') {
      return '<input type="number" step="' + (t === 'int' || t === 'integer' ? '1' : 'any') +
        '" ' + attr + ' value="' + v + '">';
    }
    return '<input type="text" ' + attr + ' value="' + v + '" placeholder="' +
      (f.required ? '必填' : '选填') + '">';
  }

  function renderForms() {
    var keys = checkedKeysInOrder();

    if (!keys.length) {
      elForm.innerHTML = '<div class="empty">还没有勾选分析类型<br>在左侧「勾选分析类型」里选择，或直接用搜索框查找</div>';
      elFillStat.textContent = '';
      return;
    }

    var html = '';
    var totalReq = 0, filledReq = 0, totalField = 0, filledField = 0;

    keys.forEach(function (k) {
      var x = getAnalysis(k);
      if (!x) return;
      var reqFields = x.fields.filter(function (f) { return f.required; });
      var optFields = x.fields.filter(function (f) { return !f.required; });

      var idx = listAnalyses().findIndex(function (y) { return y.key === k; });
      html += '<div class="card" data-key="' + esc(k) + '">' +
        '<div class="card-head">' +
        '<div class="card-path">' + esc(x.product) + '<span class="sep">/</span>' + esc(x.analysis) + '</div>' +
        '<div class="head-tools">' +
        '<span class="card-tag">分析 ' + (idx + 1) + '</span>' +
        '<button class="btn btn-mini" type="button" data-act="uncheck" data-key="' + esc(k) + '">取消勾选</button>' +
        '</div></div>';

      var groups = [
        { title: '必须文件 / 必填字段', cls: 'req', list: reqFields },
        { title: '非必须文件 / 选填字段', cls: 'opt', list: optFields }
      ];

      groups.forEach(function (g) {
        if (!g.list.length) return;
        html += '<div class="fgroup"><div class="fgroup-title ' + g.cls + '">' + g.title +
          '（' + g.list.length + '）</div>';
        g.list.forEach(function (f) {
          var cur = state.values[valKey(x.product, x.analysis, f.name)];
          if (typeof cur === 'undefined') cur = '';
          var empty = String(cur).trim() === '';
          totalField++;
          if (!empty) filledField++;
          if (f.required) {
            totalReq++;
            if (!empty) filledReq++;
          }
          html += '<div class="frow' + (f.required && empty ? ' invalid' : '') +
            '" data-req="' + (f.required ? '1' : '0') + '" data-fp="' +
            esc(valKey(x.product, x.analysis, f.name)) + '">' +
            '<div class="fname">' +
            (f.required ? '<span class="star">*</span>' : '') +
            '<span>' + esc(f.name) + '</span>' +
            '<span class="type-badge" title="字段类型：' + esc(f.type) + '">' + esc(typeLabel(f.type)) + '</span>' +
            '</div>' +
            fieldInput(x.product, x.analysis, f, cur) +
            (f.note ? '<div class="fnote">' + esc(f.note) + '</div>' : '') +
            '</div>';
        });
        html += '</div>';
      });

      html += '</div>';
    });

    elForm.innerHTML = html;
    elFillStat.textContent = '必填 ' + filledReq + '/' + totalReq + ' · 字段 ' + filledField + '/' + totalField;
  }

  /* ============================================================
   * 渲染：输出 JSON
   * ============================================================ */
  function buildOutput() {
    var keys = checkedKeysInOrder();
    var skipEmpty = $('optSkipEmpty').checked;
    var grouped = $('optGroup').checked;
    var missing = [];

    var tasks = [];
    var nested = {};

    keys.forEach(function (k) {
      var x = getAnalysis(k);
      if (!x) return;
      var files = {};
      var inner = {};
      x.fields.forEach(function (f) {
        var raw = state.values[valKey(x.product, x.analysis, f.name)];
        var v = typeof raw === 'undefined' ? '' : String(raw);
        if (v.trim() === '') {
          if (f.required) missing.push(x.product + ' / ' + x.analysis + ' → ' + f.name);
          if (skipEmpty) return;
        }
        files[f.name] = coerce(v, f.type);
        inner[f.name] = files[f.name];
      });
      tasks.push({ product: x.product, analysis: x.analysis, files: files });
      nested[x.product] = nested[x.product] || {};
      nested[x.product][x.analysis] = inner;
    });

    var out;
    if (grouped) {
      out = { version: CONFIG ? CONFIG.version : 1.0, generatedAt: nowIso(), product: nested };
    } else {
      out = { version: CONFIG ? CONFIG.version : 1.0, generatedAt: nowIso(), tasks: tasks };
    }

    return { json: JSON.stringify(out, null, 4), missing: missing, count: tasks.length };
  }

  function coerce(v, type) {
    var t = String(type || 'str').toLowerCase();
    var s = String(v).trim();
    if (s === '') return '';
    if (t === 'int' || t === 'integer') {
      var i = parseInt(s, 10);
      return isNaN(i) ? s : i;
    }
    if (t === 'float' || t === 'number' || t === 'double') {
      var f = parseFloat(s);
      return isNaN(f) ? s : f;
    }
    if (t === 'bool' || t === 'boolean') {
      if (s === 'true' || s === 'false') return s === 'true';
      return s;
    }
    if (t === 'json' || t === 'list' || t === 'array') {
      try { return JSON.parse(s); } catch (e) { return s; }
    }
    return s;
  }

  function renderOutput() {
    var r = buildOutput();
    var txt = r.count ? r.json : '// 还没有勾选任何分析类型\n// 请在左侧勾选后再生成';
    elOut.textContent = txt;   // 同步到 DOM，便于全选复制 / 页面抓取
    elOut.value = txt;
    elOutHint.textContent = r.count
      ? '已生成 ' + r.count + ' 个分析任务，可直接复制或下载。'
      : '';

    var msgs = [];
    if (r.missing.length) {
      msgs.push('<div class="validate-msg v-err">有 ' + r.missing.length +
        ' 个必填字段未填写：<ul>' +
        r.missing.slice(0, 12).map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') +
        (r.missing.length > 12 ? '<li>…等共 ' + r.missing.length + ' 项</li>' : '') +
        '</ul></div>');
    } else if (r.count) {
      msgs.push('<div class="validate-msg v-ok">必填字段已全部填写，可以提交。</div>');
    }
    elValidate.innerHTML = msgs.join('');
  }

  /* ============================================================
   * 总渲染
   * ============================================================ */
  function renderAll() {
    renderProductSelect();
    renderAnalysisSelect();
    renderChecklist();
    renderForms();
    renderOutput();
    saveState();
  }

  /* ============================================================
   * 状态持久化
   * ============================================================ */
  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        selProduct: state.selProduct,
        selAnalysis: state.selAnalysis,
        search: state.search,
        checked: state.checked,
        values: state.values
      }));
    } catch (e) { /* 忽略隐私模式等异常 */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      state.selProduct = s.selProduct || '';
      state.selAnalysis = s.selAnalysis || '';
      state.search = s.search || '';
      state.checked = s.checked || {};
      state.values = s.values || {};
    } catch (e) { /* ignore */ }
  }

  /** 配置变化后，丢弃失效的勾选与已填内容 */
  function pruneState() {
    var validKeys = {};
    var validVals = {};
    listAnalyses().forEach(function (x) {
      validKeys[x.key] = true;
      x.fields.forEach(function (f) { validVals[valKey(x.product, x.analysis, f.name)] = true; });
    });
    Object.keys(state.checked).forEach(function (k) { if (!validKeys[k]) delete state.checked[k]; });
    Object.keys(state.values).forEach(function (k) { if (!validVals[k]) delete state.values[k]; });
  }

  /* ============================================================
   * 配置加载 / 热更新
   * ============================================================ */
  function applyConfig(cfg, srcText) {
    CONFIG = normalizeConfig(cfg);
    pruneState();
    elSrcBadge.textContent = srcText;
    elSrcBadge.className = 'badge ' + (mode === 'server' ? 'badge-srv' : 'badge-muted');
    renderAll();
  }

  function validCfg(cfg) {
    return !!cfg && typeof cfg === 'object' && cfg.product && typeof cfg.product === 'object';
  }

  /** 方式一：本机带后端时，走 /api/config */
  function loadConfigFromServer() {
    return fetch(API + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { throw new Error('返回内容不是 JSON'); });
      })
      .then(function (d) {
        if (!d || d.ok !== true || !validCfg(d.config)) {
          throw new Error((d && d.error) || '接口返回异常');
        }
        mode = 'server';
        mtime = d.mtime || 0;
        applyConfig(d.config, '服务端 · semi-auto.json');
        elSyncBadge.textContent = '已同步';
        elSyncBadge.className = 'badge badge-ok';
        return true;
      });
  }

  /** 方式二：纯静态部署（GitHub Pages / Netlify）时，直接读同目录的 semi-auto.json */
  function loadConfigFromStaticFile() {
    return fetch('./semi-auto.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json().catch(function () { throw new Error('返回内容不是 JSON'); });
      })
      .then(function (cfg) {
        if (!validCfg(cfg)) throw new Error('配置缺少 product 字段');
        mode = 'static';
        staticSnapshot = JSON.stringify(cfg);
        applyConfig(cfg, '静态 · semi-auto.json');
        elSyncBadge.textContent = '静态部署';
        elSyncBadge.className = 'badge badge-warn';
        return false;
      });
  }

  /** 方式三：兜底内置配置 */
  function loadConfigFallback() {
    mode = 'static';
    applyConfig(DEFAULT_CONFIG, '内置只读配置');
    elSyncBadge.textContent = '只读模式';
    elSyncBadge.className = 'badge badge-warn';
    elSrcBadge.title = '未能读取 semi-auto.json，已使用内置示例配置';
    return Promise.resolve(false);
  }

  function initConfig() {
    return loadConfigFromServer()
      .catch(function () { return loadConfigFromStaticFile(); })
      .catch(function () { return loadConfigFallback(); });
  }

  /** 轮询检测 semi-auto.json 是否被改动 —— 实现「改 JSON，网站自动更新」
   *  本机后端：比对 mtime（2 秒一次）
   *  静态部署：比对文件内容快照（60 秒一次，GitHub 改完 + Netlify 重新部署后自动生效） */
  function startWatcher() {
    setInterval(function () {
      if (mode === 'server') {
        fetch('/api/mtime?t=' + Date.now(), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) return;
            if (d.mtime && d.mtime !== mtime) {
              mtime = d.mtime;
              fetch(API + '?t=' + Date.now(), { cache: 'no-store' })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                  if (res && res.ok) {
                    applyConfig(res.config, '服务端 · semi-auto.json');
                    elSyncBadge.textContent = '检测到更新，已刷新';
                    elSyncBadge.className = 'badge badge-ok';
                    toast('配置已更新：semi-auto.json 有改动');
                    setTimeout(function () { elSyncBadge.textContent = '已同步'; }, 3000);
                  }
                });
            }
          })
          .catch(function () { /* 网络抖动忽略 */ });
        return;
      }

      if (mode !== 'static') return;
      fetch('./semi-auto.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
          if (!validCfg(cfg)) return;
          var snap = JSON.stringify(cfg);
          if (!staticSnapshot) { staticSnapshot = snap; return; }
          if (snap !== staticSnapshot) {
            staticSnapshot = snap;
            applyConfig(cfg, '静态 · semi-auto.json');
            elSyncBadge.textContent = '检测到更新，已刷新';
            elSyncBadge.className = 'badge badge-ok';
            toast('配置已更新：线上的 semi-auto.json 有改动');
            setTimeout(function () {
              elSyncBadge.textContent = '静态部署';
              elSyncBadge.className = 'badge badge-warn';
            }, 4000);
          }
        })
        .catch(function () { /* 忽略 */ });
    }, mode === 'server' ? 2000 : 60000);
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */
  function toggleCheck(k, on) {
    if (on) state.checked[k] = true; else delete state.checked[k];
  }

  function bind() {
    elSelProduct.addEventListener('change', function () {
      state.selProduct = elSelProduct.value;
      state.selAnalysis = '';
      renderAnalysisSelect();
      renderChecklist();
    });

    elSelAnalysis.addEventListener('change', function () {
      state.selAnalysis = elSelAnalysis.value;
      if (state.selAnalysis) toggleCheck(state.selAnalysis, true);
      renderChecklist();
      renderForms();
      renderOutput();
      saveState();
      if (state.selAnalysis) {
        var card = elForm.querySelector('.card[data-key="' + cssEsc(state.selAnalysis) + '"]');
        if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });

    var onSearch = function () {
      state.search = elSearch.value;
      renderChecklist();
      var vis = visibleAnalyses().length;
      elSearchHint.textContent = state.search.trim()
        ? '匹配 ' + vis + ' 个分析类型，按 Enter 勾选第 1 个'
        : '';
      saveState();
    };
    elSearch.addEventListener('input', onSearch);
    elSearch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var first = visibleAnalyses()[0];
        if (first) {
          toggleCheck(first.key, true);
          elSelProduct.value = ''; state.selProduct = '';
          renderAnalysisSelect();
          renderChecklist();
          renderForms();
          renderOutput();
          saveState();
          toast('已勾选：' + first.analysis);
        }
      }
    });
    $('btnClearSearch').addEventListener('click', function () {
      elSearch.value = '';
      onSearch();
      elSearch.focus();
    });

    elList.addEventListener('change', function (e) {
      var t = e.target;
      if (t && t.matches('input[type="checkbox"][data-key]')) {
        toggleCheck(t.getAttribute('data-key'), t.checked);
        renderChecklist();
        renderForms();
        renderOutput();
        saveState();
      }
    });

    elForm.addEventListener('input', onValueChange);
    elForm.addEventListener('change', onValueChange);
    function onValueChange(e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains('val-input')) return;
      var k = valKey(t.getAttribute('data-p'), t.getAttribute('data-a'), t.getAttribute('data-f'));
      state.values[k] = t.value;
      var row = t.closest('.frow');
      if (row) row.classList.toggle('invalid', row.getAttribute('data-req') === '1' && t.value.trim() === '');
      renderOutput();
      updateFillStatOnly();
      saveState();
    }

    elForm.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act="uncheck"]');
      if (!b) return;
      var k = b.getAttribute('data-key');
      toggleCheck(k, false);
      if (state.selAnalysis === k) { state.selAnalysis = ''; renderAnalysisSelect(); }
      renderChecklist();
      renderForms();
      renderOutput();
      saveState();
    });

    $('btnUncheckAll').addEventListener('click', function () {
      state.checked = {};
      state.selAnalysis = '';
      renderAnalysisSelect();
      renderChecklist(); renderForms(); renderOutput(); saveState();
      toast('已清空全部勾选');
    });

    $('btnClearValues').addEventListener('click', function () {
      state.values = {};
      renderForms(); renderOutput(); saveState();
      toast('已清空填写内容');
    });

    $('optGroup').addEventListener('change', renderOutput);
    $('optSkipEmpty').addEventListener('change', renderOutput);

    $('btnCopy').addEventListener('click', function () {
      var txt = elOut.value;
      var done = function () { toast('已复制到剪贴板'); };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(txt).then(done).catch(fallback);
      } else { fallback(); }
      function fallback() {
        elOut.removeAttribute('readonly');
        elOut.select();
        try { document.execCommand('copy'); done(); }
        catch (e) { toast('复制失败，请手动选中复制'); }
        elOut.setAttribute('readonly', 'readonly');
        elOut.blur();
      }
    });

    $('btnDownload').addEventListener('click', function () {
      var blob = new Blob([elOut.value], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'semi-auto-config-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('已下载 JSON 文件');
    });

    $('btnRefresh').addEventListener('click', function () {
      initConfig().then(function () {
        toast('配置已重新载入');
      }).catch(function () {
        toast('配置载入失败');
      });
    });

  }

  function updateFillStatOnly() {
    var totalReq = 0, filledReq = 0, totalField = 0, filledField = 0;
    checkedKeysInOrder().forEach(function (k) {
      var x = getAnalysis(k);
      if (!x) return;
      x.fields.forEach(function (f) {
        var v = state.values[valKey(x.product, x.analysis, f.name)];
        var has = typeof v !== 'undefined' && String(v).trim() !== '';
        totalField++;
        if (has) filledField++;
        if (f.required) { totalReq++; if (has) filledReq++; }
      });
    });
    elFillStat.textContent = '必填 ' + filledReq + '/' + totalReq + ' · 字段 ' + filledField + '/' + totalField;
  }


  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ============================================================
   * 启动
   * ============================================================ */
  function boot() {
    loadState();
    bind();
    initConfig().then(function () {
      // 回填历史搜索关键词
      elSearch.value = state.search || '';
      if (state.search) elSearch.dispatchEvent(new Event('input'));
      startWatcher();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

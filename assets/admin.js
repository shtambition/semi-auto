/* ============================================================
 * 后台管理 · semi-auto 配置编辑
 * 所有写入操作都带 X-Admin-Token，服务端强校验
 * ============================================================ */

(function () {
  'use strict';

  var TOKEN_KEY = 'semi-auto:adminToken';
  var REMEMBER_DAYS = 30;
  var API = '/api';

  /* 部署到 GitHub 后，把仓库地址填在这里，线上「在 GitHub 上编辑」按钮就能直接跳转。
     例：var REPO_URL = 'https://github.com/sunhongtao8238/semi-auto'; */
  var REPO_URL = '';

  var token = '';

  var $ = function (id) { return document.getElementById(id); };
  var elLoginView = $('loginView');
  var elStaticView = $('staticView');
  var elEditorView = $('editorView');
  var elLoginForm = $('loginForm');
  var elLoginToken = $('loginToken');
  var elLoginMsg = $('loginMsg');
  var elRemember = $('optRemember');
  var elAuthBadge = $('authBadge');
  var elLogout = $('btnLogout');
  var elConfigJson = $('configJson');
  var elSaveMsg = $('saveMsg');
  var elCfgStat = $('cfgStat');
  var elBakList = $('bakList');
  var elToast = $('toast');

  /* ---------------- 工具 ---------------- */
  function toast(msg) {
    elToast.textContent = msg;
    elToast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { elToast.hidden = true; }, 2400);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtTime(ts) {
    var d = new Date(ts * 1000);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  /* ---------------- 口令存取 ---------------- */
  function saveToken(t, remember) {
    token = t;
    try {
      if (remember) {
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ t: t, exp: Date.now() + REMEMBER_DAYS * 864e5 }));
      } else {
        sessionStorage.setItem(TOKEN_KEY, t);
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch (e) { /* ignore */ }
  }

  function loadToken() {
    try {
      var s = sessionStorage.getItem(TOKEN_KEY);
      if (s) return s;
      var raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return '';
      var o = JSON.parse(raw);
      if (o && o.t && o.exp > Date.now()) return o.t;
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
    return '';
  }

  function clearToken() {
    token = '';
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 请求 ---------------- */
  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (token) headers['X-Admin-Token'] = token;
    if (options.body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; })
        .then(function (d) { d._status = r.status; return d; });
    });
  }

  /* ---------------- 视图切换 ---------------- */
  function hideAll() {
    elLoginView.hidden = true;
    elStaticView.hidden = true;
    elEditorView.hidden = true;
  }

  function showLogin(msg, isError) {
    hideAll();
    elLoginView.hidden = false;
    elLogout.hidden = true;
    elAuthBadge.textContent = '未登录';
    elAuthBadge.className = 'badge badge-warn';
    elLoginMsg.textContent = msg || '';
    elLoginMsg.className = 'modal-msg' + (isError ? ' err' : '');
    if (elLoginToken) { elLoginToken.value = ''; elLoginToken.focus(); }
  }

  /** 静态部署：没有后端可写，引导去 GitHub 改 */
  function showStatic() {
    hideAll();
    elStaticView.hidden = false;
    elLogout.hidden = true;
    elAuthBadge.textContent = '静态部署 · 只读';
    elAuthBadge.className = 'badge badge-warn';

    var link = $('lnkRepoFile');
    if (REPO_URL) {
      link.href = REPO_URL.replace(/\/+$/, '') + '/edit/main/semi-auto.json';
      $('repoHint').textContent = '仓库：' + REPO_URL;
    } else {
      link.hidden = true;
      $('repoHint').textContent = '提示：在 assets/admin.js 顶部填入 REPO_URL，此按钮就能直接跳转到编辑页。';
    }
  }

  function showEditor() {
    hideAll();
    elEditorView.hidden = false;
    elLogout.hidden = false;
    elAuthBadge.textContent = '已登录 · 可编辑';
    elAuthBadge.className = 'badge badge-ok';
    loadConfig();
    loadBackups();
  }

  /**
   * 探测是否存在本地后端：
   *   'ok'      —— 有后端且口令有效
   *   'denied'  —— 有后端但口令不对 / 被限流
   *   'static'  —— 没有后端（静态部署）
   */
  function probeBackend() {
    return fetch(API + '/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || '' }),
      cache: 'no-store'
    }).then(function (r) {
      return r.text().then(function (text) {
        var d = null;
        try { d = JSON.parse(text); } catch (e) { d = null; }
        if (!d || typeof d.ok === 'undefined') return 'static';
        return d.ok ? 'ok' : 'denied';
      });
    }).catch(function () { return 'static'; });
  }

  /* ---------------- 配置读写 ---------------- */
  function loadConfig() {
    return api('/config').then(function (d) {
      if (!d.ok) throw new Error(d.error || '读取失败');
      elConfigJson.value = JSON.stringify(d.config, null, 4);
      elCfgStat.textContent = 'mtime ' + fmtTime(d.mtime);
      return d;
    }).catch(function (e) {
      elCfgStat.textContent = '读取失败：' + e.message;
    });
  }

  function parseInput() {
    try {
      var obj = JSON.parse(elConfigJson.value);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        setMsg('配置顶层必须是 JSON 对象（以 { 开头）', 'err');
        return null;
      }
      if (!obj.product || typeof obj.product !== 'object') {
        setMsg('缺少 product 字段，或它不是对象', 'err');
        return null;
      }
      return obj;
    } catch (err) {
      setMsg('JSON 语法错误：' + err.message, 'err');
      return null;
    }
  }

  function setMsg(msg, cls) {
    elSaveMsg.textContent = msg || '';
    elSaveMsg.className = 'modal-msg ' + (cls || '');
  }

  function saveConfig() {
    var obj = parseInput();
    if (!obj) return;
    setMsg('保存中…', '');
    api('/config', { method: 'POST', body: { config: obj } }).then(function (d) {
      if (d._status === 401 || d._status === 429) {
        clearToken();
        showLogin(d.error || '登录已失效，请重新登录', true);
        return;
      }
      if (!d.ok) throw new Error(d.error || '保存失败');
      setMsg('已写入磁盘，公开页面将自动刷新', 'ok');
      toast('配置已保存，网站已更新');
      elCfgStat.textContent = 'mtime ' + fmtTime(d.mtime);
      loadBackups();
    }).catch(function (e) {
      setMsg('保存失败：' + e.message, 'err');
    });
  }

  /* ---------------- 备份 ---------------- */
  function loadBackups() {
    elBakList.innerHTML = '<div class="empty">载入中…</div>';
    api('/backups').then(function (d) {
      if (d._status === 401 || d._status === 429) {
        clearToken();
        showLogin(d.error || '登录已失效，请重新登录', true);
        return;
      }
      if (!d.ok) throw new Error(d.error || '读取失败');
      renderBackups(d.backups || []);
    }).catch(function (e) {
      elBakList.innerHTML = '<div class="empty">读取备份失败：' + esc(e.message) + '</div>';
    });
  }

  function renderBackups(list) {
    if (!list.length) {
      elBakList.innerHTML = '<div class="empty">还没有备份<br>首次保存后会自动生成</div>';
      return;
    }
    elBakList.innerHTML = list.map(function (b) {
      return '<div class="bak-item" data-name="' + esc(b.name) + '">' +
        '<div class="bak-info">' +
        '<div class="bak-name">' + esc(b.name) + '</div>' +
        '<div class="bak-meta">' + fmtTime(b.mtime) + ' · ' + fmtSize(b.size) + '</div>' +
        '</div>' +
        '<div class="bak-acts">' +
        '<button class="btn btn-mini" type="button" data-act="load">载入</button>' +
        '<button class="btn btn-mini btn-danger" type="button" data-act="restore">回滚</button>' +
        '</div></div>';
    }).join('');
  }

  /* ---------------- 事件 ---------------- */
  function bind() {
    elLoginForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = elLoginToken.value.trim();
      if (!t) { elLoginMsg.textContent = '请输入口令'; elLoginMsg.className = 'modal-msg err'; return; }
      elLoginMsg.textContent = '校验中…';
      elLoginMsg.className = 'modal-msg';
      token = t;
      probeBackend().then(function (state) {
        if (state === 'static') { clearToken(); showStatic(); return; }
        if (state === 'ok') {
          saveToken(t, elRemember.checked);
          elLoginMsg.textContent = '';
          showEditor();
          toast('登录成功');
          return;
        }
        clearToken();
        elLoginMsg.textContent = '口令错误';
        elLoginMsg.className = 'modal-msg err';
      });
    });

    elLogout.addEventListener('click', function () {
      clearToken();
      showLogin('已退出登录');
      toast('已退出登录');
    });

    $('btnFormat').addEventListener('click', function () {
      try {
        elConfigJson.value = JSON.stringify(JSON.parse(elConfigJson.value), null, 4);
        setMsg('格式化完成', 'ok');
      } catch (err) {
        setMsg('JSON 语法错误：' + err.message, 'err');
      }
    });

    $('btnReload').addEventListener('click', function () {
      setMsg('');
      loadConfig().then(function () { toast('已重新载入磁盘上的配置'); });
    });

    $('btnSave').addEventListener('click', saveConfig);

    $('btnRefreshBak').addEventListener('click', loadBackups);

    elBakList.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var item = btn.closest('.bak-item');
      var name = item && item.getAttribute('data-name');
      if (!name) return;
      var act = btn.getAttribute('data-act');

      if (act === 'load') {
        api('/backup?name=' + encodeURIComponent(name)).then(function (d) {
          if (!d.ok) throw new Error(d.error || '读取失败');
          elConfigJson.value = JSON.stringify(d.config, null, 4);
          setMsg('已载入备份 ' + name + '（尚未保存）', 'ok');
          toast('备份已载入编辑器');
        }).catch(function (err) { setMsg('读取失败：' + err.message, 'err'); });
        return;
      }

      if (act === 'restore') {
        if (!window.confirm('确定回滚到 ' + name + ' 吗？\n当前配置会先自动备份。')) return;
        api('/restore', { method: 'POST', body: { name: name } }).then(function (d) {
          if (!d.ok) throw new Error(d.error || '回滚失败');
          elConfigJson.value = JSON.stringify(d.config, null, 4);
          elCfgStat.textContent = 'mtime ' + fmtTime(d.mtime);
          setMsg('已回滚到 ' + name + '，公开页面将自动刷新', 'ok');
          toast('已回滚');
          loadBackups();
        }).catch(function (err) { setMsg('回滚失败：' + err.message, 'err'); });
      }
    });

    // Ctrl/Cmd + S 保存
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !elEditorView.hidden) {
        e.preventDefault();
        saveConfig();
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    bind();

    // 支持从启动日志里的 ?token=xxx 直达链接一键进入
    var url = new URL(window.location.href);
    var qToken = url.searchParams.get('token');
    if (qToken) {
      saveToken(qToken, elRemember.checked);
      url.searchParams.delete('token');
      history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    }

    token = token || loadToken();

    probeBackend().then(function (state) {
      if (state === 'ok') { showEditor(); return; }
      if (state === 'static') { clearToken(); showStatic(); return; }
      clearToken();
      showLogin('登录已失效，请重新输入口令', true);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

/* WindWhisper 面板的网络层（🍃 风语）
 *
 * 单独一个文件，就是为了让 app.js 只管界面。**必须是普通脚本** ——
 * iframe 里用 <script type="module"> 会破坏 ComfyUI 的 combo 初始化。
 *
 * 暴露一个全局 `WW`。
 */

var WW = (function () {
  var BASE = "/windwhisper";

  /* ------------------------------------------------------------ 基础请求 */

  function parse(resp) {
    return resp.text().then(function (t) {
      var data = null;
      try { data = t ? JSON.parse(t) : {}; } catch (e) { data = null; }
      if (data === null) {
        throw new Error("后端返回的不是 JSON（HTTP " + resp.status + "）：" + String(t).slice(0, 120));
      }
      if (!resp.ok || data.ok === false) {
        throw new Error(data.error || ("HTTP " + resp.status));
      }
      return data;
    });
  }

  function req(method, path, body) {
    var opts = { method: method, cache: "no-store", headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(BASE + path, opts).then(parse);
  }

  /* -------------------------------------------------------- 流式对话请求 */

  /* 用 fetch + ReadableStream 收 SSE，**不用 EventSource** ——
   * EventSource 只能发 GET，塞不下消息体和会话 id。用 SSE 的格式，不用它的 API。 */
  function streamChat(body, onEvent, signal) {
    return fetch(BASE + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (t) {
          var msg = String(t);
          try { msg = JSON.parse(t).error || msg; } catch (e) { /* 原样 */ }
          throw new Error("HTTP " + resp.status + " · " + msg);
        });
      }
      if (!resp.body || !resp.body.getReader) {
        throw new Error("这个浏览器不支持流式读取（需要较新的 Chrome / Edge）");
      }

      var reader = resp.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buf = "";

      function drain() {
        var idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          var block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          var lines = block.split("\n");
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf("data:") !== 0) continue;
            var raw = line.slice(5).trim();
            if (!raw) continue;
            try { onEvent(JSON.parse(raw)); } catch (e) { /* 单条坏分片不该中断整条流 */ }
          }
        }
      }

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += decoder.decode(r.value, { stream: true }).replace(/\r\n/g, "\n");
          drain();
          return pump();
        });
      }
      return pump();
    });
  }

  /* -------------------------------------------------------------- 对外 API */

  return {
    streamChat: streamChat,

    getConfig: function () { return req("GET", "/config").then(function (d) { return d.config; }); },
    saveConfig: function (patch) { return req("POST", "/config", patch); },
    testConfig: function (cfg) { return req("POST", "/config/test", cfg || {}).then(function (d) { return d.result; }); },
    listModels: function () { return req("GET", "/models"); },
    systemPrompt: function (masterId, refIds) {
      var q = "?master=" + encodeURIComponent(masterId || "") +
              "&refs=" + encodeURIComponent((refIds || []).join(","));
      return req("GET", "/prompt" + q);
    },

    listChats: function (includeArchived) {
      return req("GET", "/chats" + (includeArchived ? "?archived=1" : "")).then(function (d) { return d.chats || []; });
    },
    createChat: function (skillId) { return req("POST", "/chats", { skillId: skillId }).then(function (d) { return d.chat; }); },
    /* 会话里那张图的地址。会话 json 只存文件名，图是后端按需读出来的 ——
     * 所以 <img src> 要拼这条路由，不能像以前那样直接把 data URL 塞进去。 */
    imgUrl: function (chatId, name) {
      return BASE + "/image?chat=" + encodeURIComponent(chatId || "") + "&name=" + encodeURIComponent(name || "");
    },
    getChat: function (id) { return req("GET", "/chats/" + encodeURIComponent(id)).then(function (d) { return d.chat; }); },
    saveChat: function (id, patch) { return req("POST", "/chats/" + encodeURIComponent(id), patch).then(function (d) { return d.chat; }); },
    deleteChat: function (id) { return req("DELETE", "/chats/" + encodeURIComponent(id)); },

    listSkills: function () { return req("GET", "/skills"); },
    getSkill: function (id) { return req("GET", "/skills/" + encodeURIComponent(id)).then(function (d) { return d.skill; }); },

    /* ---- skill 增删改（只有用户目录里的能改能删，内置的会返回 400 说明原因） ---- */
    createSkill: function (fields) { return req("POST", "/skills", fields).then(function (d) { return d.skill; }); },
    saveSkill: function (id, fields) {
      return req("POST", "/skills/" + encodeURIComponent(id), fields).then(function (d) { return d.skill; });
    },
    /* 只写适配层：**不碰 SKILL.md**，所以内置 skill 也能调（改正文那条不行）。 */
    saveSkillAdapter: function (id, fields) {
      return req("POST", "/skills/" + encodeURIComponent(id) + "/adapter", fields).then(function (d) { return d.skill; });
    },
    deleteSkill: function (id) { return req("DELETE", "/skills/" + encodeURIComponent(id)); },
    duplicateSkill: function (id, opts) {
      return req("POST", "/skills/" + encodeURIComponent(id) + "/duplicate", opts || {}).then(function (d) { return d.skill; });
    },
    exportSkill: function (id) { return req("GET", "/skills/" + encodeURIComponent(id) + "/export"); },

    /* ---- 目录导入：scan 只读，run 才落盘，且永远不删源 ---- */
    scanImportDir: function (dir) { return req("POST", "/skills/import/scan", { dir: dir }); },
    runImport: function (dir, ids, overwrite) {
      return req("POST", "/skills/import/run", { dir: dir, ids: ids, overwrite: !!overwrite });
    },

    /* ---- 词库 ---- */
    listLibrary: function (opts) {
      opts = opts || {};
      var bits = [];
      if (opts.kw) bits.push("kw=" + encodeURIComponent(opts.kw));
      if (opts.cat) bits.push("cat=" + encodeURIComponent(opts.cat));
      if (opts.fav) bits.push("fav=1");
      return req("GET", "/library" + (bits.length ? "?" + bits.join("&") : ""));
    },
    saveLibItem: function (fields) { return req("POST", "/library", fields); },
    deleteLibItem: function (id) { return req("DELETE", "/library/" + encodeURIComponent(id)); },
    exportLibrary: function () { return req("GET", "/library/export"); }
  };
})();

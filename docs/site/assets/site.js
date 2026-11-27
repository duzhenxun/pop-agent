
document.documentElement.classList.add("reveal-ready");

// 归因与转化埋点
//
// 三条约束（都是为了不破坏「纯静态、可离线打开」这个前提）：
//   1. 不新增任何第三方脚本、不发任何新请求 —— 只往**已有的**百度统计里推事件；
//   2. 被广告拦截器挡掉、或本地用 file:// 打开时，一切埋点静默失效，不能影响点击；
//   3. 记的是 **first-touch**：同一个人的第三次访问不该把功劳算给第三个渠道。
(function () {
  var KEY = "pop.attribution";
  var PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

  function campaignFromUrl() {
    var query = new URLSearchParams(location.search);
    var out = null;
    PARAMS.forEach(function (key) {
      var value = (query.get(key) || "").trim();
      if (!value) return;
      out = out || {};
      out[key.replace("utm_", "")] = value.slice(0, 60);
    });
    return out;
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (error) { return null; }
  }

  function save(attr) {
    try { localStorage.setItem(KEY, JSON.stringify(attr)); } catch (error) { /* 隐私模式写不进去就算了 */ }
  }

  var attr = load();
  var seen = campaignFromUrl();
  if (!attr) {
    attr = seen || { source: "(direct)" };
    attr.landing = location.pathname;
    attr.referrer = document.referrer
      ? document.referrer.replace(/^https?:\/\//, "").split("/")[0]
      : "";
    attr.firstSeen = new Date().toISOString();
    save(attr);
  } else if (seen) {
    // 老访客又走了一次带参链接（换了渠道）：记下最后一次，但不覆盖 first-touch
    attr.lastSource = seen.source || "";
    save(attr);
  }

  // 页面上任何脚本都能读：window.popAttr().source
  window.popAttr = function () { return attr; };

  // 事件名固定用 `cta`，action 是点了什么，label 是渠道 —— 这样在百度统计的
  // 「事件分析」里按 label 分组，就是每个渠道各自的 CTA 点击量。
  function track(action, label) {
    var channel = label || attr.source || "(direct)";
    try {
      if (window._hmt) window._hmt.push(["_trackEvent", "cta", action, channel, 0]);
    } catch (error) { /* 统计挂了不能影响点击 */ }
    if (window.console && console.debug) console.debug("[cta]", action, channel);
  }
  window.popTrack = track;

  // 标了 data-cta 的元素：点击即记录（capture 阶段，先于原来的复制/跳转逻辑，
  // 且用 closest 兜住按钮里的图标/文字子节点）
  document.addEventListener(
    "click",
    function (event) {
      var node = event.target;
      if (!node || node.nodeType !== 1) node = node && node.parentElement;
      var hit = node && node.closest ? node.closest("[data-cta]") : null;
      if (!hit) return;
      track(hit.getAttribute("data-cta"), hit.getAttribute("data-cta-label") || "");
    },
    true
  );
})();
(function () {
  // 复制
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        var area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      var old = btn.textContent;
      btn.textContent = "✓";
      setTimeout(function () { btn.textContent = old; }, 1200);
    });
  });

  // 移动端导航
  var toggle = document.querySelector(".nav-toggle");
  var links = document.getElementById("navlinks");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", function (event) {
      if (event.target.tagName === "A") links.classList.remove("open");
    });
  }

  // 巡览切换
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tour-tab"));
  var tourImg = document.getElementById("tourImg");
  var tourCap = document.getElementById("tourCap");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (other) { other.setAttribute("aria-selected", "false"); });
      tab.setAttribute("aria-selected", "true");
      var src = tab.getAttribute("data-src");
      tourImg.src = src;
      tourImg.alt = tab.getAttribute("data-alt") || "";
      tourCap.textContent = tab.getAttribute("data-cap") || "";
    });
  });

  // 大图
  var lightbox = document.getElementById("lightbox");
  var lightboxImg = document.getElementById("lightboxImg");
  document.querySelectorAll("[data-zoom]").forEach(function (img) {
    img.style.cursor = "zoom-in";
    img.addEventListener("click", function () {
      lightboxImg.src = img.currentSrc || img.src;
      lightboxImg.alt = img.alt;
      lightbox.setAttribute("open", "");
    });
  });
  function closeLightbox() { lightbox.removeAttribute("open"); lightboxImg.src = ""; }
  document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", function (event) { if (event.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeLightbox(); });

  // 滚动出现
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
    document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".reveal").forEach(function (el) { el.classList.add("in"); });
  }
})();

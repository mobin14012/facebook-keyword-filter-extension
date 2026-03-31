(() => {
  const STORAGE_KEY = "blockedKeywords";
  const HIDDEN_ATTRIBUTE = "data-fb-keyword-filter-hidden";
  const ORIGINAL_DISPLAY_ATTRIBUTE = "data-fb-keyword-filter-original-display";
  const SKIP_MARKER_ATTRIBUTE = "data-fb-keyword-filter-skip-pending";
  const expandedButtons = new WeakSet();

  // Facebook uses different wrappers across desktop, mobile, reels, and watch pages.
  const POST_SELECTORS = [
    '[role="article"]',
    "article",
    'div[aria-posinset]',
    'div[data-pagelet^="FeedUnit_"]',
    'div[data-pagelet*="FeedUnit"]',
    'div[data-pagelet*="MainFeed"]',
    'div[data-pagelet*="Video"]',
    'div[data-pagelet*="Reel"]',
    'div[data-pagelet*="Watch"]',
    'div[data-pagelet*="Tahoe"]',
    'div[data-pagelet*="VideoChatHomeUnit"]',
    'div[data-pagelet*="Story"]',
    '[role="main"] article'
  ];

  const VIDEO_CONTAINER_SELECTORS = [
    'div[data-pagelet*="Video"]',
    'div[data-pagelet*="Watch"]',
    'div[data-pagelet*="Tahoe"]',
    'div[data-pagelet*="Reel"]',
    'div[data-video-id]',
    '[role="main"] article',
    '[role="main"] section'
  ];

  let blockedKeywords = [];
  let observer = null;
  let scanTimer = null;
  let lastUrl = location.href;
  let periodicScanId = null;
  let lastAutoSkipAt = 0;

  function normalizeKeywords(keywords) {
    if (!Array.isArray(keywords)) {
      return [];
    }

    return keywords
      .map((keyword) => String(keyword || "").trim().toLowerCase())
      .filter(Boolean);
  }

  function loadKeywords() {
    chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
      blockedKeywords = normalizeKeywords(result[STORAGE_KEY]);
      scheduleScan(document.body);
    });
  }

  function isElementNode(node) {
    return Boolean(node && node.nodeType === Node.ELEMENT_NODE);
  }

  function matchesPostSelector(element) {
    if (!isElementNode(element) || !element.matches) {
      return false;
    }

    return POST_SELECTORS.some((selector) => element.matches(selector));
  }

  function isLikelyFeedChild(element) {
    if (!isElementNode(element) || !element.parentElement) {
      return false;
    }

    const parent = element.parentElement;
    return (
      parent.getAttribute("role") === "feed" ||
      parent.matches?.('[data-pagelet*="Feed"], [data-pagelet*="Stories"]')
    );
  }

  function findPostContainer(element) {
    if (!isElementNode(element)) {
      return null;
    }

    let current = element;
    let depth = 0;

    while (current && current !== document.body && depth < 12) {
      if (matchesPostSelector(current) || isLikelyFeedChild(current)) {
        return current;
      }

      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function findVideoContainer(element) {
    if (!isElementNode(element)) {
      return null;
    }

    for (const selector of VIDEO_CONTAINER_SELECTORS) {
      const match = element.closest(selector);
      if (match) {
        return match;
      }
    }

    return findPostContainer(element);
  }

  function collectPostContainers(root) {
    const containers = new Set();

    if (!isElementNode(root)) {
      return containers;
    }

    const closest = findPostContainer(root);
    if (closest) {
      containers.add(closest);
    }

    if (matchesPostSelector(root) || isLikelyFeedChild(root)) {
      containers.add(root);
    }

    POST_SELECTORS.forEach((selector) => {
      root.querySelectorAll(selector).forEach((element) => {
        containers.add(element);
      });
    });

    root.querySelectorAll("video").forEach((video) => {
      const container = findVideoContainer(video);
      if (container) {
        containers.add(container);
      }
    });

    root.querySelectorAll('[role="feed"] > div, [role="main"] [aria-posinset]').forEach((element) => {
      const container = findPostContainer(element) || element;
      containers.add(container);
    });

    return containers;
  }

  function normalizeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = "";
      return parsed.href;
    } catch (error) {
      return "";
    }
  }

  function isVisible(element) {
    if (!isElementNode(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isSeeMoreControl(element) {
    if (!isElementNode(element) || expandedButtons.has(element) || !isVisible(element)) {
      return false;
    }

    const label = (
      element.innerText ||
      element.textContent ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

    if (!label) {
      return false;
    }

    return (
      label === "see more" ||
      label.endsWith(" see more") ||
      label.includes("see more") ||
      label === "more results"
    );
  }

  function expandHiddenText(container) {
    if (!isElementNode(container)) {
      return false;
    }

    const controls = container.querySelectorAll('a, button, div[role="button"], span[role="button"]');
    let clicked = false;

    controls.forEach((control) => {
      if (!isSeeMoreControl(control)) {
        return;
      }

      expandedButtons.add(control);
      control.click();
      clicked = true;
    });

    return clicked;
  }

  function getAccessibleText(element) {
    if (!isElementNode(element)) {
      return "";
    }

    return (
      element.innerText ||
      element.textContent ||
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function getVisibleText(element) {
    if (!isElementNode(element)) {
      return "";
    }

    const parts = [];
    const mainText = element.innerText || element.textContent || "";
    if (mainText) {
      parts.push(mainText);
    }

    element.querySelectorAll("img[alt], a[aria-label], div[aria-label], span[aria-label]").forEach((node) => {
      const value = node.getAttribute("alt") || node.getAttribute("aria-label") || "";
      if (value) {
        parts.push(value);
      }
    });

    element.querySelectorAll("a[title], span[title], div[title]").forEach((node) => {
      const value = node.getAttribute("title") || "";
      if (value) {
        parts.push(value);
      }
    });

    element.querySelectorAll('a[href*="/hashtag/"], a[href*="hashtag"], a[href*="/tags/"]').forEach((node) => {
      const text = node.innerText || node.textContent || "";
      const href = node.getAttribute("href") || "";
      if (text) {
        parts.push(text);
      }
      if (href) {
        parts.push(decodeURIComponent(href));
      }
    });

    return parts.join(" ").toLowerCase();
  }

  function hasBlockedKeyword(text) {
    if (!text || blockedKeywords.length === 0) {
      return false;
    }

    return blockedKeywords.some((keyword) => text.includes(keyword));
  }

  function isWatchPage() {
    const href = location.href.toLowerCase();
    return href.includes("/watch") || href.includes("/videos/") || href.includes("/reel/");
  }

  function hasLargeVisibleVideo(container) {
    if (!isElementNode(container)) {
      return false;
    }

    return Array.from(container.querySelectorAll("video")).some((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width >= 220 && rect.height >= 120 && rect.bottom > 0 && rect.top < window.innerHeight;
    });
  }

  function isCurrentVideoContainer(container) {
    if (!isElementNode(container)) {
      return false;
    }

    const videos = Array.from(container.querySelectorAll("video"));
    if (videos.length === 0) {
      return false;
    }

    if (
      videos.some((video) => !video.paused && !video.ended && video.readyState > 1) ||
      (isWatchPage() && hasLargeVisibleVideo(container))
    ) {
      return true;
    }

    return false;
  }

  function pauseVideos(container) {
    if (!isElementNode(container)) {
      return;
    }

    container.querySelectorAll("video").forEach((video) => {
      video.pause();
      video.muted = true;
    });
  }

  function clickElement(element) {
    if (!isElementNode(element)) {
      return false;
    }

    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
    return true;
  }

  function findNextVideoButton() {
    const controls = document.querySelectorAll('a, button, div[role="button"], span[role="button"]');

    for (const control of controls) {
      if (!isVisible(control)) {
        continue;
      }

      const label = getAccessibleText(control);
      if (
        label === "next" ||
        label === "next video" ||
        label.includes("next reel") ||
        label.includes("next video")
      ) {
        return control;
      }
    }

    return null;
  }

  function findNextVideoLink(currentContainer) {
    const currentUrl = normalizeUrl(location.href);
    const candidateSelectors = [
      'a[href*="/watch/?v="]',
      'a[href*="/watch?v="]',
      'a[href*="/videos/"]',
      'a[href*="/reel/"]'
    ];

    const candidates = document.querySelectorAll(candidateSelectors.join(", "));

    for (const link of candidates) {
      if (!isVisible(link) || currentContainer?.contains(link)) {
        continue;
      }

      const href = link.getAttribute("href");
      const normalizedHref = normalizeUrl(href);
      if (!normalizedHref || normalizedHref === currentUrl) {
        continue;
      }

      return link;
    }

    return null;
  }

  function trySkipBlockedVideo(container) {
    if (!isCurrentVideoContainer(container)) {
      return false;
    }

    const now = Date.now();
    if (now - lastAutoSkipAt < 1200) {
      return true;
    }

    lastAutoSkipAt = now;
    pauseVideos(container);
    container.setAttribute(SKIP_MARKER_ATTRIBUTE, "true");

    const nextButton = findNextVideoButton();
    if (nextButton) {
      return clickElement(nextButton);
    }

    const nextLink = findNextVideoLink(container);
    if (nextLink) {
      return clickElement(nextLink);
    }

    return false;
  }

  function hideElement(element) {
    if (!isElementNode(element) || element.getAttribute(HIDDEN_ATTRIBUTE) === "true") {
      return;
    }

    const currentDisplay = element.style.display || "";
    element.setAttribute(ORIGINAL_DISPLAY_ATTRIBUTE, currentDisplay);
    element.style.setProperty("display", "none", "important");
    element.setAttribute(HIDDEN_ATTRIBUTE, "true");
  }

  function showElement(element) {
    if (!isElementNode(element) || element.getAttribute(HIDDEN_ATTRIBUTE) !== "true") {
      if (isElementNode(element)) {
        element.removeAttribute(SKIP_MARKER_ATTRIBUTE);
      }
      return;
    }

    const originalDisplay = element.getAttribute(ORIGINAL_DISPLAY_ATTRIBUTE) || "";

    if (originalDisplay) {
      element.style.setProperty("display", originalDisplay);
    } else {
      element.style.removeProperty("display");
    }

    element.removeAttribute(ORIGINAL_DISPLAY_ATTRIBUTE);
    element.removeAttribute(HIDDEN_ATTRIBUTE);
    element.removeAttribute(SKIP_MARKER_ATTRIBUTE);
  }

  function evaluateContainer(element) {
    if (!isElementNode(element)) {
      return;
    }

    const expanded = expandHiddenText(element);
    if (expanded) {
      window.setTimeout(() => evaluateContainer(element), 250);
    }

    const text = getVisibleText(element);

    if (hasBlockedKeyword(text)) {
      if (trySkipBlockedVideo(element)) {
        return;
      }

      hideElement(element);
    } else {
      showElement(element);
    }
  }

  function runScan(root = document.body) {
    if (!document.body) {
      return;
    }

    const containers = collectPostContainers(root);
    containers.forEach(evaluateContainer);
  }

  function scheduleScan(root = document.body) {
    if (scanTimer) {
      window.clearTimeout(scanTimer);
    }

    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      runScan(root);
    }, 120);
  }

  function handleMutations(mutations) {
    const containersToCheck = new Set();
    let shouldRescanEntirePage = false;

    mutations.forEach((mutation) => {
      if (mutation.type === "characterData") {
        const parent = mutation.target.parentElement;
        const container = findPostContainer(parent);

        if (container) {
          containersToCheck.add(container);
        } else {
          shouldRescanEntirePage = true;
        }
      }

      mutation.addedNodes.forEach((node) => {
        if (!isElementNode(node)) {
          return;
        }

        const container = findPostContainer(node);
        if (container) {
          containersToCheck.add(container);
        }

        collectPostContainers(node).forEach((item) => {
          containersToCheck.add(item);
        });
      });
    });

    if (shouldRescanEntirePage) {
      scheduleScan(document.body);
      return;
    }

    if (containersToCheck.size === 0) {
      return;
    }

    containersToCheck.forEach(evaluateContainer);
  }

  function startObserver() {
    if (!document.body || observer) {
      return;
    }

    observer = new MutationObserver(handleMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function watchUrlChanges() {
    window.setInterval(() => {
      if (location.href === lastUrl) {
        return;
      }

      lastUrl = location.href;
      scheduleScan(document.body);
    }, 1000);
  }

  function startPeriodicScan() {
    if (periodicScanId) {
      return;
    }

    periodicScanId = window.setInterval(() => {
      scheduleScan(document.body);
    }, 1500);
  }

  function startScrollWatcher() {
    window.addEventListener(
      "scroll",
      () => {
        scheduleScan(document.body);
      },
      { passive: true }
    );
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) {
      return;
    }

    blockedKeywords = normalizeKeywords(changes[STORAGE_KEY].newValue);
    scheduleScan(document.body);
  });

  loadKeywords();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      startObserver();
      watchUrlChanges();
      startPeriodicScan();
      startScrollWatcher();
      scheduleScan(document.body);
    });
  } else {
    startObserver();
    watchUrlChanges();
    startPeriodicScan();
    startScrollWatcher();
    scheduleScan(document.body);
  }
})();

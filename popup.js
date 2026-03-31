const STORAGE_KEY = "blockedKeywords";

const keywordForm = document.getElementById("keyword-form");
const keywordInput = document.getElementById("keyword-input");
const keywordList = document.getElementById("keyword-list");
const emptyState = document.getElementById("empty-state");

function normalizeKeyword(keyword) {
  return String(keyword || "").trim().toLowerCase();
}

function getKeywords() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
      resolve(result[STORAGE_KEY]);
    });
  });
}

function saveKeywords(keywords) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: keywords }, () => {
      resolve();
    });
  });
}

function createKeywordItem(keyword) {
  const item = document.createElement("li");
  item.className = "keyword-item";

  const label = document.createElement("span");
  label.textContent = keyword;
  label.className = "keyword-text";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "remove-btn";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", async () => {
    // Remove only the clicked keyword, then refresh the list in the popup.
    const keywords = await getKeywords();
    const updatedKeywords = keywords.filter((savedKeyword) => savedKeyword !== keyword);
    await saveKeywords(updatedKeywords);
    renderKeywords(updatedKeywords);
  });

  item.append(label, removeButton);
  return item;
}

function renderKeywords(keywords) {
  keywordList.innerHTML = "";

  if (keywords.length === 0) {
    emptyState.style.display = "block";
    return;
  }

  emptyState.style.display = "none";

  keywords.forEach((keyword) => {
    keywordList.appendChild(createKeywordItem(keyword));
  });
}

async function addKeyword(event) {
  event.preventDefault();

  const newKeyword = normalizeKeyword(keywordInput.value);
  if (!newKeyword) {
    keywordInput.focus();
    return;
  }

  const keywords = await getKeywords();
  if (keywords.includes(newKeyword)) {
    keywordInput.value = "";
    keywordInput.focus();
    return;
  }

  // Save the new keyword so the content script can react to it automatically.
  const updatedKeywords = [...keywords, newKeyword];
  await saveKeywords(updatedKeywords);
  renderKeywords(updatedKeywords);

  keywordInput.value = "";
  keywordInput.focus();
}

async function initializePopup() {
  const keywords = await getKeywords();
  renderKeywords(keywords);
}

keywordForm.addEventListener("submit", addKeyword);
initializePopup();

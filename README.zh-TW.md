# Gemini Imgen Enhancer

[English](README.md) | 繁體中文

提升 Gemini 網頁版圖片生成體驗的 Tampermonkey userscript：

- **強制 Nano Banana Pro** — 圖片生成從第一次請求就直接用 Nano Banana Pro，省去「先用 Nano Banana 2 生成一次、再手動改用 Pro 重做」的預設流程。
- **Prompt 圖片編輯器** — 已送出訊息上的附圖可以直接編輯：調整順序、移除、加圖，然後重送。
- **每一輪都能重做** — Gemini 只讓最新一輪重做；本腳本把重做按鈕補回先前的每一輪。
- **免責聲明改顯示用量** — 輸入框下方那行「Gemini 是 AI，有時可能會出錯」改為顯示 /usage 頁面所報的帳號用量。

各項功能在 Tampermonkey 選單各有獨立開關，預設皆為開啟；重做屬於編輯器的一部分。

腳本頁面：[Greasy Fork](https://greasyfork.org/zh-TW/scripts/592510)

## 安裝

從 Greasy Fork 安裝（建議，之後的版本會自動更新）：

1. 安裝 Tampermonkey 擴充功能。
2. 開啟[腳本頁面](https://greasyfork.org/zh-TW/scripts/592510)，點「安裝此腳本」。
3. 重新整理 Gemini 頁面。

手動安裝：在 Tampermonkey 建立新腳本，貼上 `gemini-imgen-enhancer.user.js` 全文並儲存，然後重新整理 Gemini 頁面。`@run-at document-start` 不可省略——攔截必須趕在 Gemini 前端快取 `XMLHttpRequest` 之前完成。

## 使用

### 強制 Nano Banana Pro

開啟即生效，照常送出圖片生成的 prompt 就行。要恢復 Gemini 原本的模型選擇，到 Tampermonkey 選單關閉開關即可。

### Prompt 圖片編輯器

用編輯按鈕打開自己的訊息。只要訊息帶有附圖，縮圖列就會變成可編輯狀態：

- 拖曳縮圖調整順序。
- 縮圖右上角的 `×` 移除該圖。
- 虛線的 `+` 方塊用來加圖：點選檔案，或直接把檔案拖放上去。
- **Reset** 恢復為原始清單。
- 點縮圖會以 Gemini 內建的檢視器開啟。

按 Gemini 的**更新**按鈕送出，訊息立刻改顯示新的附圖清單。

幾個細節：

- 縮圖上的編號就是 prompt 文字裡「圖 1」「圖 2」指的位置；調換順序後編號跟著圖走，prompt 不會指錯張。
- 重送的請求與原生送出完全同形，速度也與原生相同。
- 需要重新上傳的圖片，檔名保留當初上傳時的原樣。
- Gemini 在 prompt 文字未改動時不開放更新按鈕；腳本補一個零寬空白讓檢查通過，並在請求送出前移除，伺服器收到的 prompt 原封不動。

### 重做先前的輪次

Gemini 的重做按鈕只出現在最新一輪。編輯器啟用時，先前每一輪的回應也會在同樣的位置出現同一顆按鈕，按下即把該則訊息原樣重送、重新生成回答。注意：該輪之後的對話會被新結果取代，效果與編輯訊息相同。

### 帳號用量

輸入框下方那行「Gemini 是 AI，有時可能會出錯」改為顯示帳號用量：目前用量與每週上限兩個視窗，各自標示已使用比例、剩餘額度與重設時刻。列尾的按鈕可隨時重新取值，取值期間該按鈕旋轉。

取值時機為：生成結束後、切回該分頁時、視窗重設時，其餘情況每五分鐘一次；分頁在背景時不取值。關閉開關即恢復 Gemini 原本的文字；取值未曾成功時也不注入任何內容，頁面與未安裝腳本時相同。

### 選單

Tampermonkey 選單有四個項目，各自顯示目前狀態；設定會保存，重啟瀏覽器後仍有效：

- `Force Nano Banana Pro: ON / OFF`
- `Prompt Image Editor: ON / OFF`
- `Usage Display: ON / OFF`
- `Debug Trace: ON / OFF` — 每次送出固定在主控台印一行耗時摘要；此開關另外啟用詳細的協定追蹤。

## 授權

MIT

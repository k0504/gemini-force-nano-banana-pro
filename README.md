# Gemini Imgen Enhancer

English | [繁體中文](README.zh-TW.md)

A Tampermonkey userscript that improves the image generation experience in the Gemini web app:

- **Forced Nano Banana Pro selection** — every image request generates with Nano Banana Pro from the start, instead of Gemini's default of generating with Nano Banana 2 first and offering Pro only as a manual retry.
- **Prompt image editor** — the images attached to an already-sent prompt become editable: reorder, remove, add, then resend.
- **Retry on every turn** — the regenerate button Gemini offers only on its newest turn is restored to every earlier one.
- **Account usage in place of the disclaimer** — the line under the composer carries the quota the /usage page reports, rather than a reminder that Gemini can make mistakes.

Each feature is a separate toggle in the Tampermonkey menu, on by default; retry belongs to the editor.

Script page: [Greasy Fork](https://greasyfork.org/zh-TW/scripts/592510)

## Install

From Greasy Fork (recommended, updates arrive automatically):

1. Install the Tampermonkey extension.
2. Open the [script page](https://greasyfork.org/zh-TW/scripts/592510) and click **Install this script**.
3. Reload the Gemini page.

Manually: create a new Tampermonkey script, paste the full contents of `gemini-imgen-enhancer.user.js`, save, and reload the Gemini page. `@run-at document-start` is required — the hook must be in place before the Gemini frontend caches its `XMLHttpRequest` reference.

## Usage

### Force Nano Banana Pro

While the toggle is on, send image prompts as usual and the request is routed to Nano Banana Pro. Switch it off in the Tampermonkey menu to restore Gemini's own model choice.

### Prompt image editor

Open one of your own messages with the edit button. On a message with attachments, the thumbnails become an editable strip:

- Drag a thumbnail to reorder.
- `×` removes it.
- The dashed `+` tile uploads a file and appends it; a file dropped onto it is uploaded the same way.
- **Reset** restores the original list.
- Clicking a thumbnail opens it in Gemini's image viewer.

Press Gemini's **Update** button to resend the prompt with the new list. The message shows the new list immediately.

Details:

- The numbers on the thumbnails are the positions the prompt text refers to, so "image 1" keeps pointing at the right file after a reorder.
- The resend has the same shape as a natively sent message and completes at native speed.
- A re-uploaded image keeps the file name it was originally uploaded under.
- Gemini disables Update until the prompt text changes; the script satisfies that check with a zero-width space and strips it before the request leaves the browser.

### Retry an earlier turn

Gemini renders its regenerate button only on the newest turn. With the editor enabled, every earlier turn's response carries the same button in the same spot. Pressing it resends that message as it stands and regenerates its answer; the turns after it are replaced, as with an edit.

### Account usage

The line under the composer that reads "Gemini can make mistakes" is replaced with the account's own quota: for both the current window and the weekly cap, the share used, the units left and the time that window resets. The button at the end of the line reads the numbers again on demand, and spins while it does.

They are read again when a generation finishes, when the tab is returned to, when a window resets, and every five minutes otherwise. A tab in the background is not read at all. Switching the toggle off restores Gemini's line, as does a session that cannot reach the quota endpoint: nothing is drawn until the first read lands.

### Menu

Four Tampermonkey menu entries, each showing its current state; settings persist across browser restarts:

- `Force Nano Banana Pro: ON / OFF`
- `Prompt Image Editor: ON / OFF`
- `Usage Display: ON / OFF`
- `Debug Trace: ON / OFF` — a concise timing line is always printed per send; this adds the verbose protocol trace.

## License

MIT

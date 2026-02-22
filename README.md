# Speed Reader

A browser extension that increases reading speed by training your eye movements directly on the page you're reading — no separate app, no copy-pasting text.

The highlight moves across the page line by line, guiding your eyes to jump further and faster than they naturally would. Over time this trains saccade range (the distance your eye can travel in a single jump) and reduces the subvocalisation that slows most readers down.

---

## How it works

Most people read at 200–250 wpm because they fixate on nearly every word. Speed reading training works by forcing wider, faster eye jumps and reducing fixation time per chunk. This extension does that in-place, on real content:

- A highlight rectangle moves across the page at your target WPM
- Words are shown in chunks (default: 3 at a time), pushing your eye to take in more per fixation
- The highlight's return sweep at the end of each line mimics natural saccadic return, reinforcing the motion
- Scroll modes let you gradually extend how far your eye travels before the page scrolls for you

You read real articles at speed, not synthetic flash-card text. The context and layout stay intact.

---

## Setup (Developer Mode)

The extension is not published to a browser store. Load it directly from source:

### Chrome / Edge / Brave

1. Clone or download this repository to your machine.
2. Open your browser and go to `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** — toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the root folder of this repository (the one containing `manifest.json`).
6. The Speed Reader icon appears in your toolbar. Pin it for easy access.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select the `manifest.json` file inside the repository root.
4. Note: temporary add-ons are removed when Firefox restarts. For persistent loading, use Firefox Developer Edition with `xpinstall.signatures.required` set to `false` in `about:config`.

### After loading

- Navigate to any article or long-form page.
- Click the extension icon and press **Start**, or press **Alt+R**.
- Adjust WPM and chunk size in the popup. Fine-tune all settings via **Options**.

---

## Controls

| Action | Method |
|--------|--------|
| Start / Pause / Resume | **Alt+R** or popup button |
| Stop & save position | **Alt+S** or popup Stop button |
| Open settings | Popup → Options |

Position is saved per URL. Returning to a page resumes from where you left off.

---

## Settings

All settings are in the **Options** page (right-click the icon → Options, or click Options in the popup).

| Setting | Default | What it does |
|---------|---------|--------------|
| WPM | 300 | Target reading speed. Start near your natural speed, increase by 25–50 wpm once comfortable. |
| Chunk size | 3 | Words highlighted per fixation. Larger chunks train wider saccades but reduce comprehension at first. |
| Chunk overlap | 1 | Words re-shown from the previous chunk. Reduces skipping errors on dense text. |
| Line-end pause | 400 ms | Pause at end of each line before the return sweep. Gives your eye time to prepare for the jump back. |
| Return sweep speed | 150 ms | Duration of the dim-and-jump animation that simulates saccadic return. |
| Scroll mode | Mixed | Controls how the page scrolls as you read (see below). |
| Eye jump lines | 3 | In Mixed mode, how many lines your eye jumps before the page scrolls. |
| Complexity adapt | On | Automatically narrows chunk size on long/complex words, widens it on short simple words. |
| Highlight colour | Yellow | Light-mode highlight colour. |
| Dark highlight colour | Blue | Chosen automatically when the page background is dark. |
| Highlight opacity | 0.6 | Transparency of the highlight rectangle. |
| Progress indicator | On | Thin bar at the top of the viewport showing reading progress. |

### Scroll modes

| Mode | Behaviour | Good for |
|------|-----------|----------|
| **Eye-only** | Page never auto-scrolls. Your eye must track all the way to the bottom before the highlight jumps back to visible area. | Advanced training — maximum saccade distance. |
| **Mixed** | Eye jumps N lines (set by Eye jump lines), then the page scrolls to recentre. | The main training mode. Gradually increase Eye jump lines as you improve. |
| **Auto-scroll** | Page recentres after every line. | Comfortable reading; minimal eye-jump training. |
| **Page-turn** | Page flips when the highlight reaches the bottom margin, like turning a page. | Long documents where smooth scrolling is distracting. |

---

## Training approach

1. **Start at your natural speed.** Find a WPM where comprehension stays high, then push it up 10–15% once a session feels easy.
2. **Use Mixed mode.** Begin with Eye jump lines = 3, increase to 4, then 5 over weeks.
3. **Increase chunk size slowly.** Going from 2 to 3 words per chunk has more impact on speed than raising WPM alone.
4. **Read real material.** Comprehension on real content is the goal, not score on a test. Stop and re-read sections if you've lost the thread — that feedback is useful.

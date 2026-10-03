# Zen Library — Bookmarks Section

A Sine mod that adds a **Bookmarks** section to Zen's **native library sidebar** — the panel Zen opens with its library toolbar button or the swipe-from-edge gesture. No extra panel, no extra bar: your bookmarks appear as one more tab next to History, Downloads, Boosts and Spaces.

> **Version 3.0 note:** this repo used to ship a full standalone "Zen Library" panel (its own sidebar overlay with downloads, history, media, spaces, boosts and bookmarks tabs, opened with Alt+Shift+B). Zen's native library made that panel obsolete — and its `<zen-library>` element name collided with Zen's, breaking both. The old code still exists in this repo's git history; going forward this mod only injects the Bookmarks section into Zen's own sidebar. **Remove the old install in Sine and clear the startup cache (`about:support`) when updating.**

## Features

- Native look: uses Zen's own row, group, search-box and empty-state styling.
- Collapsible folder tree (Toolbar / Menu / Other / Mobile, any nesting depth), folders first in Firefox order.
- Live search across title, URL and folder, with infinite scroll on results.
- Opens on click (closes the library, like native sections); Ctrl+click / middle-click opens in a background tab and keeps the library open.
- Delete button on hover, mirroring the history section's trash action.
- Updates live via Places observers — adding or removing a bookmark refreshes the section.

## Requirements

- [Sine](https://github.com/CosmoCreeper/Sine)
- Zen build that ships the native library (`moz-src:///zen/library/ZenLibrary.mjs`, Zen 1.20+).

## Installation

1. In Zen: Settings → Sine Mods → settings icon next to the marketplace, enable **downloading JS from unofficial sources** (this mod ships JavaScript).
2. Paste `https://github.com/vicanfon/Zen-Library` into Sine's install box and install.
3. If you previously had version 2.x installed, uninstall it first (or update in place and then clear the startup cache via `about:support` → Clear startup cache).
4. Open Zen's library — the **Bookmarks** tab is there.

## How it works

Zen renders its sidebar tabs from the public `zenLibrarySections` object on the `<zen-library>` element (`src/zen/library/ZenLibrary.mjs` in zen-browser/desktop). This mod:

1. waits for Zen's own `<zen-library>` element to register, then grabs the class from the custom-element registry (importing `ZenLibrary.mjs` directly would fail — Lit, which it depends on, needs a `document` that `ChromeUtils.importESModule`'s realm doesn't have),
2. injects a bookmarks section definition into `lib.zenLibrarySections.bookmarks` — the section is a plain `HTMLElement` that reuses Zen's own row/search/empty-state CSS classes (the library renders into light DOM, so `bookmarks.css` reaches it),
3. adds the tab icon and folder-tree styling.

Zen has no Fluent string for a bookmarks tab label, so the mod fills it with "Bookmarks" via a small MutationObserver fallback.

## Troubleshooting

Open the Browser Console (`Ctrl+Shift+J`) and filter for `[ZenBookmarksSection]`:

- `Module loaded` / `Bookmarks section added` — working.
- `Zen's <zen-library> element never registered` — your Zen is older than the native library, or the old Zen Library mod won the `<zen-library>` registration race: uninstall it and clear the startup cache.
- `Injection failed` — read the attached error; usually means Zen changed its library internals.
- Missing tab icon — the chrome stylesheet didn't load; check Sine's mod settings for the style entry.

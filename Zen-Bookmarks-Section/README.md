# Zen Bookmarks Section

A Sine mod that adds a **Bookmarks** section to Zen's **native library sidebar** — the panel Zen opens with its library toolbar button or the swipe-from-edge gesture. No extra panel, no extra bar: your bookmarks appear as one more tab next to History, Downloads, Boosts and Spaces.

![screenshot placeholder]

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

**Disable the old "Zen Library" mod first.** It registers its own `<zen-library>` custom element, which collides with Zen's native element and breaks both mods. After disabling, clear the startup cache (`about:support` → Clear startup cache).

## Installation

1. In Zen: Settings → Sine Mods → settings icon next to the marketplace, enable **downloading JS from unofficial sources** (this mod ships JavaScript).
2. Paste this repository URL into Sine's install box. If Sine installs from the repo root (which holds the old mod), point it at the `Zen-Bookmarks-Section` folder or copy the folder into Sine's mods directory manually and restart / clear the startup cache.
3. Open Zen's library and the **Bookmarks** tab is there.

## How it works

Zen renders its sidebar tabs from the public `zenLibrarySections` object on the `<zen-library>` element (`src/zen/library/ZenLibrary.mjs` in zen-browser/desktop). This mod:

1. imports `ZenLibrary` and `ZenLibrarySearchSection` from `moz-src://`,
2. defines a `zen-library-bookmarks-section` Lit element extending Zen's own search-section base (so it inherits the native search box, filter scaffold and scroll sentinel),
3. injects it as `lib.zenLibrarySections.bookmarks`,
4. adds the tab icon and folder-tree styling from `bookmarks.css` (the library renders into light DOM, so document-level chrome CSS reaches it).

Zen has no Fluent string for a bookmarks tab label, so the mod fills it with "Bookmarks" via a small MutationObserver fallback.

## Troubleshooting

Open the Browser Console (`Ctrl+Shift+J`) and filter for `[ZenBookmarksSection]`:

- `Module loaded` / `Bookmarks section added` — working.
- `This Zen build does not ship the native library` — your Zen is older than the native library, or the old Zen Library mod won the `<zen-library>` registration race: disable it and clear the startup cache.
- Missing tab icon — the chrome stylesheet didn't load; check Sine's mod settings for the style entry.

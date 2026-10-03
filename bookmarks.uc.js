"use strict";

/**
 * Zen Bookmarks Section
 *
 * Adds a "Bookmarks" section to Zen's NATIVE library sidebar
 * (the panel Zen opens with its library button / swipe-from-edge).
 *
 * How it works:
 *  - Zen renders its sidebar tabs from the public `zenLibrarySections`
 *    object on the <zen-library> element (src/zen/library/ZenLibrary.mjs).
 *  - This script grabs Zen's already-registered <zen-library> class with
 *    customElements.get() and injects a bookmarks section into that
 *    object. The section is a plain HTMLElement styled with Zen's own
 *    zen-library.css classes - no Lit, no module imports, so it can be
 *    loaded from a plain subscript.
 *  - No panel of our own is created: no extra bars, no tag-name
 *    collisions, nothing to disable.
 *
 * Requires a Zen build that ships the native library
 * (moz-src:///zen/library/ZenLibrary.mjs, Zen 1.20+).
 *
 * NOTE: the old "Zen Library" Sine mod must not be installed alongside
 * this one. It registers a <zen-library> custom element of its own,
 * which collides with Zen's native element and breaks both.
 */

(function () {
    if (window.gZenBookmarksSection) {
        console.log("[ZenBookmarksSection] Already loaded, skipping re-init");
        return;
    }

    const { PlacesUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
    );

    const PAGE_LIMIT = 100;
    const SEARCH_DEBOUNCE_MS = 250;
    const ROOT_ORDER = [
        "Bookmarks Toolbar",
        "Bookmarks Menu",
        "Other Bookmarks",
        "Mobile Bookmarks",
    ];

    // ------------------------------------------------------------------
    // Tiny DOM helper (light DOM: Zen's zen-library.css styles everything)
    // ------------------------------------------------------------------
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        const { className, id, textContent, onclick, oninput, onauxclick, ...other } = props;
        if (className) node.className = className;
        if (id) node.id = id;
        if (textContent !== undefined) node.textContent = textContent;
        if (onclick) node.onclick = onclick;
        if (oninput) node.oninput = oninput;
        if (onauxclick) node.onauxclick = onauxclick;
        for (const key in other) {
            const value = other[key];
            // Skip null/undefined - setAttribute(key, null) stringifies and
            // makes presence-checking attribute selectors (e.g. [open]) match
            // every row.
            if (value === null || value === undefined) continue;
            node.setAttribute(key, value);
        }
        for (const child of children) {
            if (child) node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }

    // ------------------------------------------------------------------
    // Section element
    // ------------------------------------------------------------------
    class ZenLibraryBookmarksSection extends HTMLElement {
        constructor() {
            super();
            this.library = null;
            this._built = false;
            this._bookmarks = [];
            this._loading = true;
            this._searchTerm = "";
            this._limit = PAGE_LIMIT;
            this._expanded = new Set();
            this._treeCache = null;
            this._treeSource = null;
            this._fetchGeneration = 0;
            this._observing = false;
        }

        connectedCallback() {
            if (!this._built) {
                this._built = true;
                this._build();
            }
            this._observeBookmarks();
            this._fetch();
        }

        disconnectedCallback() {
            if (this._observing) {
                try {
                    PlacesUtils.observers.removeListener(
                        ["bookmark-added", "bookmark-removed", "bookmark-changed"],
                        this._onPlacesChange
                    );
                } catch (e) { /* already gone */ }
                this._observing = false;
            }
        }

        /* Hooks the native library calls on sections. */
        onShown() {
            if (!this._bookmarks.length && !this._loading) this._fetch();
        }

        onHidden() { /* nothing to pause */ }

        onLibraryOpening() { /* nothing to prepare */ }

        onLibraryClosing() { /* nothing to persist */ }

        // --------------------------------------------------------------
        // DOM
        // --------------------------------------------------------------

        _build() {
            this.textContent = "";

            // Mirrors the markup ZenLibrarySearchSection renders, minus
            // the filter panel (this section has no filters).
            const searchTop = el("div", { className: "zen-library-search-top" }, [
                el("div", { className: "zen-library-search-header" }, [
                    el("div", { className: "zen-library-search-box" }, [
                        el("img", {
                            className: "zen-library-search-icon",
                            src: "chrome://browser/skin/zen-icons/search-glass.svg",
                            alt: "",
                        }),
                        this._searchInput = el("input", {
                            type: "search",
                            placeholder: "Search bookmarks...",
                        }),
                    ]),
                ]),
            ]);
            this._searchInput.addEventListener("input", () => {
                clearTimeout(this._debounce);
                this._debounce = setTimeout(() => {
                    this._searchTerm = this._searchInput.value.trim();
                    this._limit = PAGE_LIMIT;
                    this._refresh();
                }, SEARCH_DEBOUNCE_MS);
            });

            this._results = el("div", { className: "zen-library-search-results" }, [
                this._sentinel = el("div", { className: "zen-library-search-sentinel" }),
            ]);
            this._results.addEventListener(
                "scroll",
                () => this._results.toggleAttribute("scrolled", this._results.scrollTop > 0),
                { passive: true }
            );

            this._sentinelObserver = new IntersectionObserver(
                entries => {
                    if (entries.some(entry => entry.isIntersecting)) this._onScrolledToEnd();
                },
                { root: this._results, rootMargin: "200px" }
            );
            this._sentinelObserver.observe(this._sentinel);

            this.appendChild(searchTop);
            this.appendChild(this._results);
        }

        _onScrolledToEnd() {
            // Infinite scroll only applies to the flat (search) list.
            if (!this._searchTerm) return;
            this._limit += PAGE_LIMIT;
            this._refresh();
        }

        // --------------------------------------------------------------
        // Data
        // --------------------------------------------------------------

        _onPlacesChange = async () => {
            this._treeCache = null;
            await this._fetch();
        };

        _observeBookmarks() {
            if (this._observing) return;
            try {
                PlacesUtils.observers.addListener(
                    ["bookmark-added", "bookmark-removed", "bookmark-changed"],
                    this._onPlacesChange
                );
                this._observing = true;
            } catch (e) {
                console.warn("[ZenBookmarksSection] Observer setup failed:", e);
            }
        }

        async _fetch() {
            const generation = ++this._fetchGeneration;
            let items = [];
            try {
                items = await this._fetchPerFolder();
                if (!items.length) {
                    items = await this._fetchViaSQL();
                }
            } catch (e) {
                console.error("[ZenBookmarksSection] Fetch error:", e);
            }
            if (generation !== this._fetchGeneration) return;

            items.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
            this._loading = false;
            this._bookmarks = items;
            this._refresh();
        }

        /**
         * Walks every root (Toolbar / Menu / Other / Mobile) recursively
         * via PlacesUtils.bookmarks.fetch({ parentGuid }), collecting all
         * children with a callback (without one fetch() resolves only the
         * first match).
         */
        async _fetchPerFolder() {
            const items = [];
            const seen = new Set();
            const roots = [
                [PlacesUtils.bookmarks.toolbarGuid, "Bookmarks Toolbar"],
                [PlacesUtils.bookmarks.menuGuid, "Bookmarks Menu"],
                [PlacesUtils.bookmarks.unfiledGuid, "Other Bookmarks"],
            ];
            try {
                if (PlacesUtils.bookmarks.mobileGuid) {
                    roots.push([PlacesUtils.bookmarks.mobileGuid, "Mobile Bookmarks"]);
                }
            } catch (e) { /* older builds */ }

            const TYPE_BOOKMARK = PlacesUtils.bookmarks.TYPE_BOOKMARK;
            const TYPE_FOLDER = PlacesUtils.bookmarks.TYPE_FOLDER;
            const toMs = (d) => {
                if (d instanceof Date) return d.getTime();
                if (typeof d === "number") return d > 1e14 ? Math.floor(d / 1000) : d;
                return Date.now();
            };

            const fetchChildren = async (parentGuid) => {
                const collected = [];
                try {
                    const first = await PlacesUtils.bookmarks.fetch(
                        { parentGuid },
                        b => { if (b) collected.push(b); }
                    );
                    if (!collected.length && first) collected.push(first);
                } catch (e) {
                    console.warn("[ZenBookmarksSection] fetch failed for", parentGuid, e);
                }
                return collected;
            };

            const walk = async (parentGuid, folderName) => {
                const children = await fetchChildren(parentGuid);
                for (const child of children) {
                    if (!child) continue;
                    if (child.type === TYPE_BOOKMARK && child.url) {
                        const href = child.url?.href || String(child.url);
                        if (!href || href.startsWith("place:")) continue;
                        const key = (child.guid || "") + "|" + href;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        items.push({
                            guid: child.guid,
                            title: child.title || href,
                            uri: href,
                            folder: folderName || "Bookmarks",
                            dateAdded: toMs(child.dateAdded),
                        });
                    } else if (child.type === TYPE_FOLDER && child.guid) {
                        try {
                            if (
                                PlacesUtils.bookmarks.tagsGuid &&
                                child.guid === PlacesUtils.bookmarks.tagsGuid
                            ) continue;
                        } catch (e) { /* noop */ }
                        const subName = child.title
                            ? (folderName ? `${folderName} / ${child.title}` : child.title)
                            : folderName;
                        await walk(child.guid, subName);
                    }
                }
            };

            for (const [guid, folderTitle] of roots) {
                if (guid) await walk(guid, folderTitle);
            }
            return items;
        }

        /**
         * Read-only fallback straight from the Places database, building
         * the full folder path with a recursive CTE.
         */
        async _fetchViaSQL() {
            const items = [];
            const db = await PlacesUtils.promiseDBConnection();
            const rows = await db.executeCached(`
                WITH RECURSIVE tree(id, parent, path) AS (
                    SELECT id, parent, COALESCE(title, '') FROM moz_bookmarks WHERE id = 1
                    UNION ALL
                    SELECT b.id, b.parent, tree.path || ' / ' || COALESCE(b.title, '')
                    FROM moz_bookmarks b JOIN tree ON b.parent = tree.id
                )
                SELECT b.guid AS guid,
                       COALESCE(b.title, '') AS title,
                       p.url AS url,
                       b.dateAdded AS dateAdded,
                       tree.path AS folderPath
                FROM moz_bookmarks b
                JOIN moz_places p ON p.id = b.fk
                JOIN tree ON tree.id = b.parent
                WHERE b.type = 1
                  AND p.url NOT LIKE 'place:%'
                  AND tree.path NOT LIKE '%tag________%'
                ORDER BY b.dateAdded DESC
            `);
            for (const row of rows) {
                const uri = row.getResultByName("url");
                if (!uri) continue;
                let folder = row.getResultByName("folderPath") || "Bookmarks";
                const parts = folder.split(" / ");
                if (parts.length > 1) folder = parts.slice(1).join(" / ");
                items.push({
                    guid: row.getResultByName("guid"),
                    title: row.getResultByName("title") || uri,
                    uri,
                    folder,
                    dateAdded: Math.floor((row.getResultByName("dateAdded") || 0) / 1000),
                });
            }
            return items;
        }

        // --------------------------------------------------------------
        // Tree model
        // --------------------------------------------------------------

        _getTree() {
            if (this._treeCache && this._treeSource === this._bookmarks) {
                return this._treeCache;
            }
            const newNode = (name, path) => ({
                name, path, folders: new Map(), bookmarks: [], total: 0,
            });
            const root = newNode("", "");
            for (const item of this._bookmarks) {
                const parts = String(item.folder || "Bookmarks")
                    .split(" / ")
                    .map(s => s.trim())
                    .filter(Boolean);
                let node = root;
                let path = "";
                for (const part of parts) {
                    path = path ? `${path} / ${part}` : part;
                    let child = node.folders.get(part);
                    if (!child) {
                        child = newNode(part, path);
                        node.folders.set(part, child);
                    }
                    node = child;
                }
                node.bookmarks.push(item);
            }
            const countTotals = (node) => {
                let total = node.bookmarks.length;
                for (const child of node.folders.values()) total += countTotals(child);
                node.total = total;
                return total;
            };
            for (const child of root.folders.values()) countTotals(child);
            this._treeCache = root;
            this._treeSource = this._bookmarks;
            return root;
        }

        /** Roots in Firefox order first, everything else alphabetical. */
        _sortedFolders(node) {
            return Array.from(node.folders.values()).sort((a, b) => {
                const ia = ROOT_ORDER.indexOf(a.name);
                const ib = ROOT_ORDER.indexOf(b.name);
                if (ia !== -1 || ib !== -1) {
                    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                }
                return a.name.localeCompare(b.name);
            });
        }

        _toggleFolder(path) {
            if (this._expanded.has(path)) this._expanded.delete(path);
            else this._expanded.add(path);
            this._refresh();
        }

        // --------------------------------------------------------------
        // Rendering
        // --------------------------------------------------------------

        _open(item, event) {
            const inBackground =
                !!event &&
                (event.button === 1 ||
                    (event.type === "click" && (event.ctrlKey || event.metaKey)));
            window.openTrustedLinkIn(item.uri, "tab", { inBackground });
            if (!inBackground) {
                // Native sections toggle the library closed on a plain click.
                this.library?.constructor.toggle();
            }
        }

        async _delete(item, event) {
            event.stopPropagation();
            try {
                await PlacesUtils.bookmarks.remove(item.guid);
                this._bookmarks = this._bookmarks.filter(b => b.guid !== item.guid);
                this._treeCache = null;
                this._refresh();
            } catch (e) {
                console.error("[ZenBookmarksSection] Delete failed:", e);
            }
        }

        _renderFolder(node, depth) {
            const open = this._expanded.has(node.path);
            const wrap = el("div", {
                className: "zen-library-bm-folder",
                open: open ? "true" : null,
            });
            wrap.appendChild(el("div", {
                className: "zen-library-row zen-library-bm-folder-row",
                onclick: () => this._toggleFolder(node.path),
            }, [
                el("img", {
                    className: "zen-library-bm-chevron",
                    src: "chrome://browser/skin/zen-icons/arrow-right.svg",
                    alt: "",
                }),
                el("img", {
                    className: "zen-library-row-icon",
                    src: "chrome://browser/skin/zen-icons/folder.svg",
                    alt: "",
                }),
                el("div", { className: "zen-library-row-text" }, [
                    el("span", { className: "zen-library-row-title", textContent: node.name }),
                    el("span", {
                        className: "zen-library-row-subtitle",
                        textContent: `${node.total} ${node.total === 1 ? "bookmark" : "bookmarks"}`,
                    }),
                ]),
            ]));
            if (open) {
                wrap.appendChild(this._renderChildren(node, depth + 1));
            }
            return wrap;
        }

        _renderChildren(node, depth) {
            const children = el("div", { className: "zen-library-bm-children" });
            for (const folder of this._sortedFolders(node)) {
                children.appendChild(this._renderFolder(folder, depth));
            }
            for (const bm of node.bookmarks) {
                children.appendChild(this._renderBookmark(bm));
            }
            return children;
        }

        _renderBookmark(item) {
            return el("div", {
                className: "zen-library-row",
                onclick: e => this._open(item, e),
                onauxclick: e => this._open(item, e),
            }, [
                el("img", {
                    className: "zen-library-row-icon",
                    src: `page-icon:${item.uri}`,
                    alt: "",
                }),
                el("div", { className: "zen-library-row-text" }, [
                    el("span", { className: "zen-library-row-title", textContent: item.title }),
                    el("span", { className: "zen-library-row-subtitle" }, [
                        el("span", { className: "zen-library-visit-url", textContent: item.uri }),
                    ]),
                ]),
                el("div", { className: "zen-library-row-actions" }, [
                    el("toolbarbutton", {
                        className: "toolbarbutton-1",
                        title: "Delete bookmark",
                        onclick: e => this._delete(item, e),
                    }, [
                        el("img", {
                            className: "toolbarbutton-icon",
                            src: "chrome://browser/skin/zen-icons/trash.svg",
                            alt: "",
                        }),
                    ]),
                ]),
            ]);
        }

        _renderEmpty(text) {
            return el("div", { className: "zen-library-empty", textContent: text });
        }

        _refresh() {
            if (!this._results) return;

            const fragment = document.createDocumentFragment();
            if (!this._bookmarks.length) {
                fragment.appendChild(this._renderEmpty(
                    this._loading
                        ? "Loading bookmarks..."
                        : "No bookmarks yet. Bookmark pages with Ctrl+D and they'll show up here."
                ));
            } else if (this._searchTerm) {
                const term = this._searchTerm.toLowerCase();
                const filtered = this._bookmarks.filter(
                    b =>
                        (b.title || "").toLowerCase().includes(term) ||
                        (b.uri || "").toLowerCase().includes(term) ||
                        (b.folder || "").toLowerCase().includes(term)
                );
                if (!filtered.length) {
                    fragment.appendChild(this._renderEmpty("No results found"));
                } else {
                    const group = el("div", { className: "zen-library-group" });
                    for (const bm of filtered.slice(0, this._limit)) {
                        group.appendChild(this._renderBookmark(bm));
                    }
                    fragment.appendChild(group);
                }
            } else {
                const group = el("div", { className: "zen-library-group" });
                for (const folder of this._sortedFolders(this._getTree())) {
                    group.appendChild(this._renderFolder(folder, 0));
                }
                for (const bm of this._getTree().bookmarks) {
                    group.appendChild(this._renderBookmark(bm));
                }
                fragment.appendChild(group);
            }

            // Keep the sentinel last so the IntersectionObserver keeps working.
            for (const child of Array.from(this._results.childNodes)) {
                if (child !== this._sentinel) child.remove();
            }
            this._results.insertBefore(fragment, this._sentinel);
        }
    }

    if (!customElements.get("zen-library-bookmarks-section")) {
        customElements.define(
            "zen-library-bookmarks-section",
            ZenLibraryBookmarksSection
        );
    }

    /**
     * The library calls these statics on whatever sits in
     * zenLibrarySections: `id` for the tab, `label` for its text and
     * `render(library)` for the content. Returning the element node is
     * fine - Lit renders Node values as-is.
     */
    const ZenLibraryBookmarksSectionDef = {
        id: "bookmarks",
        label: "zen-library-bookmarks-section-title",
        render(library) {
            const section = document.createElement("zen-library-bookmarks-section");
            section.className = "zen-library-section";
            section.setAttribute("data-section", "bookmarks");
            section.library = library;
            return section;
        },
    };

    /**
     * Injection. We deliberately do NOT import ZenLibrary.mjs: modules
     * imported via ChromeUtils.importESModule run in the shared JSM realm
     * without `document`, and lit.all.mjs (which ZenLibrary.mjs statically
     * imports) needs one at top level. The window-realm class is already
     * registered, so we just pick it up from the custom element registry.
     */
    const inject = async () => {
        try {
            await Promise.race([
                customElements.whenDefined("zen-library"),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("zen-library never registered")),
                        20000
                    )
                ),
            ]);
        } catch (e) {
            console.error(
                "[ZenBookmarksSection] Zen's <zen-library> element never registered. " +
                "This Zen build likely predates the native library.",
                e
            );
            return;
        }

        try {
            const ZenLibraryClass = customElements.get("zen-library");
            const lib = ZenLibraryClass.getInstance();
            if (lib.zenLibrarySections.bookmarks !== ZenLibraryBookmarksSectionDef) {
                lib.zenLibrarySections.bookmarks = ZenLibraryBookmarksSectionDef;
                lib.requestUpdate();
            }

            // Zen has no Fluent string for our tab label; fill it whenever
            // Lit re-renders the tab list.
            const ensureLabel = () => {
                const tab = lib.querySelector(
                    '.zen-library-tab[data-section="bookmarks"] label'
                );
                if (tab && !tab.textContent.trim()) {
                    tab.textContent = "Bookmarks";
                }
            };
            ensureLabel();
            new MutationObserver(ensureLabel).observe(lib, {
                childList: true,
                subtree: true,
            });

            window.gZenBookmarksSection = ZenLibraryBookmarksSectionDef;
            console.log(
                "[ZenBookmarksSection] Bookmarks section added to Zen's library"
            );
        } catch (e) {
            console.error("[ZenBookmarksSection] Injection failed:", e);
        }
    };

    if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", inject, { once: true });
    } else {
        inject();
    }

    console.log("[ZenBookmarksSection] Module loaded");
})();

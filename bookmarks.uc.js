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
 *  - This script imports that class, defines a bookmarks section as a
 *    Lit element extending Zen's own ZenLibrarySearchSection (so it gets
 *    the native search box + scroll behaviour), and injects it into the
 *    sections object.
 *  - No panel of our own is created: no extra bars, no tag-name
 *    collisions, nothing to disable.
 *
 * Requires a Zen build that ships the native library
 * (moz-src:///zen/library/ZenLibrary.mjs, Zen 1.20+).
 *
 * NOTE: disable the old "Zen Library" Sine mod when using this one. It
 * registers a <zen-library> custom element of its own, which collides
 * with Zen's native element and breaks both.
 */

(function () {
    if (window.gZenBookmarksSection) {
        console.log("[ZenBookmarksSection] Already loaded, skipping re-init");
        return;
    }

    let html, nothing;
    let ZenLibrary, ZenLibrarySearchSection;
    try {
        ({ html, nothing } = ChromeUtils.importESModule(
            "chrome://global/content/vendor/lit.all.mjs"
        ));
        ({ ZenLibrary } = ChromeUtils.importESModule(
            "moz-src:///zen/library/ZenLibrary.mjs"
        ));
        ({ ZenLibrarySearchSection } = ChromeUtils.importESModule(
            "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs"
        ));
    } catch (e) {
        console.error(
            "[ZenBookmarksSection] This Zen build does not ship the native " +
            "library (moz-src:///zen/library/ZenLibrary.mjs). " +
            "If you use the old Zen Library mod, its <zen-library> element " +
            "is blocking Zen's own definition - disable it and clear the " +
            "startup cache.",
            e
        );
        return;
    }

    const PAGE_LIMIT = 100;
    const ROOT_ORDER = [
        "Bookmarks Toolbar",
        "Bookmarks Menu",
        "Other Bookmarks",
        "Mobile Bookmarks",
    ];

    const { PlacesUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
    );

    class ZenLibraryBookmarksSection extends ZenLibrarySearchSection {
        static id = "bookmarks";
        // Fluent id used by the sidebar tab. Zen has no string for us, so
        // a fallback below fills the label text if Fluent can't resolve it.
        static label = "zen-library-bookmarks-section-title";

        static properties = {
            bookmarks: { state: true },
            loading: { state: true },
        };

        static render(library) {
            return html`
                <zen-library-bookmarks-section
                    class="zen-library-section"
                    data-section="bookmarks"
                    .library=${library}
                ></zen-library-bookmarks-section>
            `;
        }

        constructor() {
            super();
            this.bookmarks = [];
            this.loading = true;
            this.#limit = PAGE_LIMIT;
        }

        /** Non-reactive view state. */
        #limit = PAGE_LIMIT;
        #expanded = new Set();
        #treeCache = null;
        #treeSource = null;
        #fetchGeneration = 0;
        #observing = false;

        get searchPlaceholderL10nId() {
            return "";
        }

        connectedCallback() {
            super.connectedCallback();
            this.#observeBookmarks();
            this.#fetch();
        }

        disconnectedCallback() {
            super.disconnectedCallback();
            if (this.#observing) {
                try {
                    PlacesUtils.observers.removeListener(
                        ["bookmark-added", "bookmark-removed", "bookmark-changed"],
                        this.#onPlacesChange
                    );
                } catch (e) { /* already gone */ }
                this.#observing = false;
            }
        }

        firstUpdated() {
            super.firstUpdated?.();
            // Base class renders the search input with a Fluent id; ours
            // has none, so set the placeholder imperatively.
            const input = this.querySelector(".zen-library-search-box input");
            if (input && !input.placeholder) {
                input.placeholder = "Search bookmarks...";
            }
        }

        onSearchChanged() {
            this.#limit = PAGE_LIMIT;
        }

        /** Infinite scroll: only the flat (search) list paginates. */
        onListScrolledToEnd() {
            this.#limit += PAGE_LIMIT;
            this.requestUpdate();
        }

        // ------------------------------------------------------------------
        // Data
        // ------------------------------------------------------------------

        #onPlacesChange = async () => {
            this.#treeCache = null;
            await this.#fetch();
        };

        #observeBookmarks() {
            if (this.#observing) return;
            try {
                PlacesUtils.observers.addListener(
                    ["bookmark-added", "bookmark-removed", "bookmark-changed"],
                    this.#onPlacesChange
                );
                this.#observing = true;
            } catch (e) {
                console.warn("[ZenBookmarksSection] Observer setup failed:", e);
            }
        }

        async #fetch() {
            const generation = ++this.#fetchGeneration;
            let items = [];
            try {
                items = await this.#fetchPerFolder();
                if (!items.length) {
                    items = await this.#fetchViaSQL();
                }
            } catch (e) {
                console.error("[ZenBookmarksSection] Fetch error:", e);
            }
            if (generation !== this.#fetchGeneration) return;

            items.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
            this.loading = false;
            this.bookmarks = items;
        }

        /**
         * Walks every root (Toolbar / Menu / Other / Mobile) recursively
         * via PlacesUtils.bookmarks.fetch({ parentGuid }), collecting all
         * children with a callback (without one fetch() resolves only the
         * first match).
         */
        async #fetchPerFolder() {
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
        async #fetchViaSQL() {
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

        // ------------------------------------------------------------------
        // Tree model
        // ------------------------------------------------------------------

        #getTree() {
            if (this.#treeCache && this.#treeSource === this.bookmarks) {
                return this.#treeCache;
            }
            const newNode = (name, path) => ({
                name, path, folders: new Map(), bookmarks: [], total: 0,
            });
            const root = newNode("", "");
            for (const item of this.bookmarks) {
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
            this.#treeCache = root;
            this.#treeSource = this.bookmarks;
            return root;
        }

        /** Roots in Firefox order first, everything else alphabetical. */
        #sortedFolders(node) {
            return Array.from(node.folders.values()).sort((a, b) => {
                const ia = ROOT_ORDER.indexOf(a.name);
                const ib = ROOT_ORDER.indexOf(b.name);
                if (ia !== -1 || ib !== -1) {
                    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
                }
                return a.name.localeCompare(b.name);
            });
        }

        #toggleFolder(path) {
            if (this.#expanded.has(path)) this.#expanded.delete(path);
            else this.#expanded.add(path);
            this.requestUpdate();
        }

        // ------------------------------------------------------------------
        // Rendering
        // ------------------------------------------------------------------

        #open(item, event) {
            const inBackground =
                !!event &&
                (event.button === 1 ||
                    (event.type === "click" && (event.ctrlKey || event.metaKey)));
            window.openTrustedLinkIn(item.uri, "tab", { inBackground });
            if (!inBackground) {
                // Native sections toggle the library closed on a plain click.
                this.library.constructor.toggle();
            }
        }

        async #delete(item, event) {
            event.stopPropagation();
            try {
                await PlacesUtils.bookmarks.remove(item.guid);
                this.bookmarks = this.bookmarks.filter(b => b.guid !== item.guid);
                this.#treeCache = null;
                this.requestUpdate();
            } catch (e) {
                console.error("[ZenBookmarksSection] Delete failed:", e);
            }
        }

        #renderFolder(node, depth) {
            const open = this.#expanded.has(node.path);
            return html`
                <div class="zen-library-bm-folder" ?open=${open}>
                    <div
                        class="zen-library-row zen-library-bm-folder-row"
                        style=${`--bm-depth: ${depth}`}
                        @click=${() => this.#toggleFolder(node.path)}
                    >
                        <img
                            class="zen-library-bm-chevron"
                            src="chrome://browser/skin/zen-icons/arrow-right.svg"
                            alt=""
                        />
                        <img
                            class="zen-library-row-icon"
                            src="chrome://browser/skin/zen-icons/folder.svg"
                            alt=""
                        />
                        <div class="zen-library-row-text">
                            <span class="zen-library-row-title">${node.name}</span>
                            <span class="zen-library-row-subtitle">
                                ${node.total} ${node.total === 1 ? "bookmark" : "bookmarks"}
                            </span>
                        </div>
                    </div>
                    ${open
                        ? html`<div class="zen-library-bm-children">
                              ${this.#renderChildren(node, depth + 1)}
                          </div>`
                        : nothing}
                </div>
            `;
        }

        #renderChildren(node, depth) {
            const parts = [];
            for (const folder of this.#sortedFolders(node)) {
                parts.push(this.#renderFolder(folder, depth));
            }
            for (const bm of node.bookmarks) {
                parts.push(this.#renderBookmark(bm));
            }
            return parts;
        }

        #renderBookmark(item) {
            return html`
                <div
                    class="zen-library-row"
                    @click=${e => this.#open(item, e)}
                    @auxclick=${e => this.#open(item, e)}
                >
                    <img class="zen-library-row-icon" src=${`page-icon:${item.uri}`} alt="" />
                    <div class="zen-library-row-text">
                        <span class="zen-library-row-title">${item.title}</span>
                        <span class="zen-library-row-subtitle">
                            <span class="zen-library-visit-url">${item.uri}</span>
                        </span>
                    </div>
                    <div class="zen-library-row-actions">
                        <toolbarbutton
                            class="toolbarbutton-1"
                            title="Delete bookmark"
                            @click=${e => this.#delete(item, e)}
                        >
                            <img
                                class="toolbarbutton-icon"
                                src="chrome://browser/skin/zen-icons/trash.svg"
                                alt=""
                            />
                        </toolbarbutton>
                    </div>
                </div>
            `;
        }

        #renderEmpty() {
            return html`
                <div class="zen-library-empty">
                    No bookmarks yet. Bookmark pages with Ctrl+D and they'll show up here.
                </div>
            `;
        }

        renderItems() {
            if (!this.bookmarks.length) {
                return this.loading ? null : this.#renderEmpty();
            }

            const term = (this.searchQuery || "").trim().toLowerCase();
            if (term) {
                const filtered = this.bookmarks.filter(
                    b =>
                        (b.title || "").toLowerCase().includes(term) ||
                        (b.uri || "").toLowerCase().includes(term) ||
                        (b.folder || "").toLowerCase().includes(term)
                );
                if (!filtered.length) return this.#renderEmpty();
                return html`
                    <div class="zen-library-group">
                        ${filtered.slice(0, this.#limit).map(bm => this.#renderBookmark(bm))}
                    </div>
                `;
            }

            const tree = this.#getTree();
            return html`
                <div class="zen-library-group">
                    ${this.#renderChildren(tree, 0)}
                </div>
            `;
        }
    }

    if (!customElements.get("zen-library-bookmarks-section")) {
        customElements.define(
            "zen-library-bookmarks-section",
            ZenLibraryBookmarksSection
        );
    }

    /**
     * Inject the section into the native library. Runs once the document
     * is past parsing so #navigator-toolbox exists for getInstance().
     */
    const inject = () => {
        try {
            const lib = ZenLibrary.getInstance();
            if (lib.zenLibrarySections.bookmarks !== ZenLibraryBookmarksSection) {
                lib.zenLibrarySections.bookmarks = ZenLibraryBookmarksSection;
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

    window.gZenBookmarksSection = ZenLibraryBookmarksSection;
    console.log("[ZenBookmarksSection] Module loaded");
})();

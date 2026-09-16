"use strict";

(function () {
    class ZenLibraryBookmarks {
        constructor(library) {
            this.library = library;
            this._container = null;
            this._wrapper = null;
            this._items = [];
            this._searchTerm = "";
            this._batchSize = 50;
            this._isLoading = false;
            this._renderedCount = 0;
            this._lastGroupLabel = null;
            this._isFetching = false;
            this._initialized = false;
            this._observerAdded = false;
        }

        async init() {
            if (this._isFetching || this._initialized) return;
            if (this.library.store) {
                this.library.store.subscribe((state) => {
                    if (state.bookmarks && state.bookmarks !== this._items) {
                        this._items = state.bookmarks;
                        if (this._container) this.renderBatch(true);
                    }
                });
            }
            this._isFetching = true;
            try {
                await this.fetchBookmarks();
                this._initialized = true;
            } catch (e) {
                console.error("ZenLibrary Bookmarks init error:", e);
            } finally {
                this._isFetching = false;
            }
        }

        get el() { return this.library.el.bind(this.library); }

        render() {
            const wrapper = this.el("div", {
                className: "library-list-wrapper"
            });
            this._wrapper = wrapper;

            const container = this.el("div", {
                className: "library-list-container",
                onscroll: (e) => {
                    const el = e.target;
                    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
                        this.loadMore();
                    }
                }
            });
            this._container = container;
            wrapper.appendChild(container);

            if (this._initialized && this._items.length > 0) {
                this.renderBatch(true);
                container.classList.add("library-content-fade-in");
                setTimeout(() => container.classList.add("scrollbar-visible"), 50);
                return wrapper;
            }

            const loading = this.el("div", { className: "empty-state library-content-fade-in" }, [
                this.el("div", { className: "empty-icon bookmarks-icon" }),
                this.el("h3", { textContent: "Loading bookmarks..." }),
                this.el("p", { textContent: "Gathering your bookmarked pages." })
            ]);
            container.appendChild(loading);

            this._observeBookmarkChanges();

            const isTransitioning = window.gZenLibrary && window.gZenLibrary._isTransitioning;
            const delay = isTransitioning ? 300 : 100;
            setTimeout(() => {
                if (!this._container || (this.library.activeTab && this.library.activeTab !== "bookmarks")) return;
                this.fetchBookmarks().then(() => {
                    const l = container.querySelector(".empty-state");
                    if (l) l.remove();
                    this._initialized = true;
                    this.renderBatch(true);
                    container.classList.add("library-content-fade-in");
                    setTimeout(() => container.classList.add("scrollbar-visible"), 100);
                });
            }, delay);

            return wrapper;
        }

        async fetchBookmarks() {
            this._isLoading = true;
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                // Primary: fetch() per root folder — walks every subfolder.
                // (fetchTree is not implemented on this Zen build; classic
                // setFolders history queries need numeric ids we can't resolve,
                // so both are retired in favour of this.)
                let items = [];
                try {
                    items = await this._fetchViaFetchPerFolder(PlacesUtils);
                    if (items.length) console.log("[ZenLibrary Bookmarks] source: bookmarks.fetch()");
                } catch (qErr) {
                    console.warn("ZenLibrary Bookmarks folder fetch failed:", qErr);
                }
                // Last resort: read the Places DB directly (read-only SELECT).
                // Needed because this build has no fetchTree and no GUID->id API.
                if (!items.length) {
                    try {
                        items = await this._fetchViaSQL(PlacesUtils);
                        if (items.length) console.log("[ZenLibrary Bookmarks] source: places SQL");
                    } catch (sqlErr) {
                        console.warn("ZenLibrary Bookmarks SQL fallback failed:", sqlErr);
                    }
                }
                items.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
                console.log(`[ZenLibrary Bookmarks] fetched ${items.length} items`);
                if (this.library.store) {
                    this.library.store.dispatch({ type: 'SET_BOOKMARKS', payload: items });
                } else {
                    this._items = items;
                }
            } catch (e) {
                console.error("ZenLibrary Bookmarks Fetch Error:", e);
            } finally {
                this._isLoading = false;
            }
        }

        _makeItem(guid, title, uri, folder, ms) {
            return {
                guid, title, uri,
                folder: folder || "Bookmarks",
                dateAdded: ms,
                time: ms * 1000,
                timeStr: new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                dateStr: new Date(ms).toLocaleDateString("en-GB", { day: '2-digit', month: '2-digit', year: 'numeric' })
            };
        }

        async _fetchViaFetchPerFolder(PlacesUtils) {
            // Uses PlacesUtils.bookmarks.fetch({ parentGuid }) — GUID-based,
            // so no numeric itemId resolution is needed. Recursively walks
            // each root (Toolbar / Menu / Other / Mobile) to any depth,
            // e.g. Bookmarks Menu > Bookmarks bar > GB > English > ...
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
            } catch (e) { /* noop */ }
            const TYPE_BOOKMARK = PlacesUtils.bookmarks.TYPE_BOOKMARK;
            const TYPE_FOLDER = PlacesUtils.bookmarks.TYPE_FOLDER;
            const toMs = (d) => {
                if (d instanceof Date) return d.getTime();
                if (typeof d === "number") return d > 1e14 ? Math.floor(d / 1000) : d;
                return Date.now();
            };
            // fetch({parentGuid}) with no callback resolves to the FIRST
            // match only, so pass a collector callback to get all children.
            // Both shapes are handled for safety across builds.
            const fetchChildren = async (parentGuid) => {
                const collected = [];
                try {
                    const first = await PlacesUtils.bookmarks.fetch(
                        { parentGuid },
                        b => { if (b) collected.push(b); }
                    );
                    if (!collected.length && first) collected.push(first);
                } catch (e) {
                    console.warn("ZenLibrary Bookmarks: fetch failed for", parentGuid, e);
                }
                return collected;
            };
            const walk = async (parentGuid, folderName) => {
                const children = await fetchChildren(parentGuid);
                for (const child of children) {
                    if (!child) continue;
                    if (child.type === TYPE_BOOKMARK && child.url) {
                        const href = (child.url && child.url.href) ? child.url.href : String(child.url);
                        if (!href || href.startsWith("place:")) continue;
                        const key = (child.guid || "") + "|" + href;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        items.push(this._makeItem(
                            child.guid, child.title || href, href,
                            folderName || "Bookmarks", toMs(child.dateAdded)
                        ));
                    } else if (child.type === TYPE_FOLDER && child.guid) {
                        // Skip the tags virtual root if it ever shows up
                        try {
                            if (PlacesUtils.bookmarks.tagsGuid && child.guid === PlacesUtils.bookmarks.tagsGuid) continue;
                        } catch (e) { /* noop */ }
                        const subName = child.title
                            ? (folderName ? `${folderName} / ${child.title}` : child.title)
                            : folderName;
                        await walk(child.guid, subName);
                    }
                }
            };
            for (const [guid, folderTitle] of roots) {
                if (!guid) continue;
                await walk(guid, folderTitle);
            }
            return items;
        }

        async _fetchViaSQL(PlacesUtils) {
            // Read-only fallback straight from the Places database.
            // Builds the full folder path via a recursive CTE so group
            // headers match the Firefox Library tree.
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
                // Strip the invisible Places root from the path
                let folder = row.getResultByName("folderPath") || "Bookmarks";
                const parts = folder.split(" / ");
                if (parts.length > 1) folder = parts.slice(1).join(" / ");
                items.push(this._makeItem(
                    row.getResultByName("guid"),
                    row.getResultByName("title") || uri,
                    uri,
                    folder,
                    Math.floor((row.getResultByName("dateAdded") || 0) / 1000)
                ));
            }
            return items;
        }

        _observeBookmarkChanges() {
            if (this._observerAdded) return;
            try {
                const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                this._bmObserver = async () => {
                    this._initialized = false;
                    await this.fetchBookmarks();
                    this._initialized = true;
                    if (this._container && this.library.activeTab === "bookmarks") {
                        this.renderBatch(true);
                    }
                };
                PlacesUtils.observers.addListener(
                    ["bookmark-added", "bookmark-removed", "bookmark-changed"],
                    this._bmObserver
                );
                this._observerAdded = true;
                window.addEventListener("unload", () => {
                    try {
                        PlacesUtils.observers.removeListener(
                            ["bookmark-added", "bookmark-removed", "bookmark-changed"],
                            this._bmObserver
                        );
                    } catch (e) { /* noop */ }
                }, { once: true });
            } catch (e) {
                console.warn("ZenLibrary Bookmarks observer setup failed:", e);
            }
        }

        renderBatch(reset = true) {
            try {
                if (!this._container) return;
                if (!customElements.get('zen-library-item')) {
                    console.error("ZenLibrary bookmarks: zen-library-item not registered");
                    return;
                }
                if (reset) {
                    this._container.innerHTML = "";
                    this._renderedCount = 0;
                    this._lastGroupLabel = null;
                }
                const term = (this._searchTerm || "").toLowerCase();
                const filtered = term
                    ? this._items.filter(i =>
                        (i.title || "").toLowerCase().includes(term) ||
                        (i.uri || "").toLowerCase().includes(term) ||
                        (i.folder || "").toLowerCase().includes(term)
                    )
                    : this._items;
                if (filtered.length === 0 && !this._isLoading) {
                    if (!reset) return;
                    const empty = this.el("div", { className: "empty-state" }, [
                        this.el("div", { className: "empty-icon bookmarks-icon" }),
                        this.el("h3", { textContent: this._searchTerm ? "No results found" : "No bookmarks found" }),
                        this.el("p", { textContent: this._searchTerm ? "Try a different search term." : "Bookmark pages with Ctrl+D and they'll show up here." })
                    ]);
                    this._container.appendChild(empty);
                    return;
                }
                const nextBatch = filtered.slice(this._renderedCount, this._renderedCount + this._batchSize);
                if (nextBatch.length === 0) return;
                const fragment = document.createDocumentFragment();
                nextBatch.forEach(item => {
                    try {
                        const groupLabel = this._searchTerm ? "Search Results" : (item.folder || "Bookmarks");
                        if (groupLabel !== this._lastGroupLabel) {
                            fragment.appendChild(this.el("div", { className: "history-section-header", textContent: groupLabel }));
                            this._lastGroupLabel = groupLabel;
                        }
                        const itemEl = document.createElement('zen-library-item');
                        if (!itemEl || typeof itemEl.setAttribute !== 'function') return;
                        itemEl.data = item;
                        itemEl.setAttribute("icon", `page-icon:${item.uri}`);
                        itemEl.setAttribute("title", item.title);
                        itemEl.setAttribute("subtitle", item.uri);
                        itemEl.setAttribute("time", item.dateStr || "");
                        itemEl.onclick = () => {
                            window.gBrowser.selectedTab = window.gBrowser.addTab(item.uri, {
                                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                            });
                            window.gZenLibrary.close();
                        };
                        itemEl.oncontextmenu = (e) => {
                            e.preventDefault();
                            this._showContextMenu(e, item, itemEl);
                        };
                        fragment.appendChild(itemEl);
                    } catch (itemError) {
                        console.error("ZenLibrary Error processing bookmark item:", itemError, item);
                    }
                });
                this._renderedCount += nextBatch.length;
                const oldSpacer = this._container.querySelector(".history-bottom-spacer");
                if (oldSpacer) oldSpacer.remove();
                this._container.appendChild(fragment);
                this._container.appendChild(this.el("div", { className: "history-bottom-spacer" }));
            } catch (e) {
                console.error("ZenLibrary Error in bookmarks renderBatch:", e);
            }
        }

        renderList(items) {
            if (Array.isArray(items)) this._items = items;
            this.renderBatch(true);
        }

        loadMore() { if (!this._isLoading) this.renderBatch(false); }

        _ensureContextMenu() {
            if (document.getElementById("zen-bookmarks-context-menu")) return;
            const popup = document.createXULElement("menupopup");
            popup.id = "zen-bookmarks-context-menu";
            const mk = (id, label) => {
                const mi = document.createXULElement("menuitem");
                mi.id = id;
                mi.setAttribute("label", label);
                popup.appendChild(mi);
            };
            mk("zen-bookmarks-ctx-open", "Open");
            mk("zen-bookmarks-ctx-new-tab", "Open in New Tab");
            mk("zen-bookmarks-ctx-copy", "Copy Link");
            popup.appendChild(document.createXULElement("menuseparator"));
            mk("zen-bookmarks-ctx-delete", "Delete Bookmark");
            document.getElementById("mainPopupSet").appendChild(popup);
        }

        _showContextMenu(e, item, itemEl) {
            this._ensureContextMenu();
            const ids = ["zen-bookmarks-ctx-open", "zen-bookmarks-ctx-new-tab", "zen-bookmarks-ctx-copy", "zen-bookmarks-ctx-delete"];
            for (const id of ids) {
                const el = document.getElementById(id);
                if (el) el.replaceWith(el.cloneNode(true));
            }
            const open = (uri) => {
                window.gBrowser.selectedTab = window.gBrowser.addTab(uri, {
                    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                });
                window.gZenLibrary.close();
            };
            document.getElementById("zen-bookmarks-ctx-open").addEventListener("command", () => open(item.uri));
            document.getElementById("zen-bookmarks-ctx-new-tab").addEventListener("command", () => {
                window.gBrowser.addTab(item.uri, {
                    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                });
            });
            document.getElementById("zen-bookmarks-ctx-copy").addEventListener("command", () => {
                try {
                    Components.classes["@mozilla.org/widget/clipboardhelper;1"]
                        .getService(Components.interfaces.nsIClipboardHelper)
                        .copyString(item.uri);
                } catch (err) {
                    console.error("[ZenLibrary Bookmarks] Copy failed:", err);
                }
            });
            document.getElementById("zen-bookmarks-ctx-delete").addEventListener("command", async () => {
                try {
                    const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
                    await PlacesUtils.bookmarks.remove(item.guid);
                    this._items = this._items.filter(i => i.guid !== item.guid);
                    itemEl.style.transition = "opacity 0.15s, transform 0.15s";
                    itemEl.style.opacity = "0";
                    itemEl.style.transform = "translateX(-8px)";
                    setTimeout(() => this.renderBatch(true), 160);
                } catch (err) {
                    console.error("[ZenLibrary Bookmarks] Delete failed:", err);
                }
            });
            document.getElementById("zen-bookmarks-context-menu").openPopupAtScreen(e.screenX, e.screenY, true);
        }
    }

    window.ZenLibraryBookmarks = ZenLibraryBookmarks;
    console.log("[ZenLibrary Bookmarks] Module loaded");
})();






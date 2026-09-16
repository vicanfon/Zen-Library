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
                // Strategy: query each known bookmark root with the classic
                // history API in BOOKMARKS queryType. Walk every root so
                // deeply nested folders (like your GB > English > ...) are found.
                let items = [];
                try {
                    items = await this._fetchViaFolderQueries(PlacesUtils);
                } catch (qErr) {
                    console.warn("ZenLibrary Bookmarks folder query failed:", qErr);
                }
                // Fallback: async fetchTree — full recursive tree
                if (!items.length) {
                    try {
                        items = await this._fetchViaTree(PlacesUtils);
                    } catch (treeErr) {
                        console.warn("ZenLibrary Bookmarks fetchTree failed:", treeErr);
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

        async _fetchViaTree(PlacesUtils) {
            const items = [];
            const tree = await PlacesUtils.bookmarks.fetchTree({ includeItemDates: true });
            if (!tree || !tree.children) return items;
            const walk = (node, folderName) => {
                const children = node.children || [];
                for (const child of children) {
                    if (!child) continue;
                    if (child.type === PlacesUtils.bookmarks.TYPE_BOOKMARK && child.url) {
                        const href = (child.url && child.url.href) ? child.url.href : String(child.url);
                        if (href && !href.startsWith("place:")) {
                            const ms = child.dateAdded instanceof Date
                                ? child.dateAdded.getTime()
                                : (Number(child.dateAdded) || Date.now());
                            items.push(this._makeItem(child.guid, child.title || href, href, folderName, ms));
                        }
                    } else if (child.type === PlacesUtils.bookmarks.TYPE_FOLDER && child.children) {
                        walk(child, child.title || folderName || "Bookmarks");
                    }
                }
            };
            for (const root of tree.children) {
                walk(root, root.title || "Bookmarks");
            }
            return items;
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

        async _fetchViaFolderQueries(PlacesUtils) {
            // Classic, battle-tested path: one history query per bookmark
            // root folder with queryType = QUERY_TYPE_BOOKMARKS. This is how
            // Firefox's own Library window lists bookmarks, so it sees the
            // same data you see in your screenshot (Toolbar / Menu / Other).
            const items = [];
            const seen = new Set();
            // Resolve root folder itemIds from stable GUIDs (async-safe
            // across Firefox versions — numeric folder getters vary).
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
            // Helper: GUID -> numeric itemId. Tries the modern async API,
            // falls back to the sync bookmarks-service getters.
            const resolveItemId = async (guid) => {
                if (PlacesUtils.promiseItemId) {
                    return PlacesUtils.promiseItemId(guid);
                }
                if (PlacesUtils.promiseItemIds) {
                    const map = await PlacesUtils.promiseItemIds([guid]);
                    return map.get(guid);
                }
                // Sync legacy fallback
                const svc = Cc["@mozilla.org/browser/nav-bookmarks-service;1"]
                    .getService(Ci.nsINavBookmarksService);
                return svc.getItemIdForGUID(guid);
            };
            for (const [guid, folderTitle] of roots) {
                let folderId = null;
                try {
                    folderId = await resolveItemId(guid);
                } catch (e) {
                    console.warn("ZenLibrary Bookmarks: no itemId for", guid, e);
                    continue;
                }
                if (folderId == null) continue;
                try {
                    const query = PlacesUtils.history.getNewQuery();
                    query.setFolders([folderId], 1);
                    query.queryType = query.QUERY_TYPE_BOOKMARKS;
                    const options = PlacesUtils.history.getNewQueryOptions();
                    options.sortingMode = options.SORT_BY_DATE_DESCENDING;
                    options.maxResults = 5000;
                    const result = PlacesUtils.history.executeQuery(query, options);
                    const root = result.root;
                    root.containerOpen = true;
                    try {
                        this._collectQueryNodes(root, folderTitle, items, seen);
                    } finally {
                        root.containerOpen = false;
                    }
                } catch (e) {
                    console.warn("ZenLibrary Bookmarks query failed for folder", guid, e);
                }
            }
            return items;
        }

        _collectQueryNodes(node, folderName, items, seen) {
            // Recursively walk result nodes: containers = folders,
            // leaves with uri = actual bookmarks.
            const count = node.childCount || 0;
            for (let i = 0; i < count; i++) {
                let child = null;
                try { child = node.getChild(i); } catch (e) { continue; }
                if (!child) continue;
                // Folder container — descend, tracking the folder path.
                // Note: plain bookmark leaves can also report hasChildren,
                // so only treat real containers (no uri) as folders.
                const isFolder = child.isContainer && !child.uri && !child.isLivemarkContainer;
                if (isFolder && child.hasChildren) {
                    let wasOpen = child.containerOpen;
                    try {
                        if (!wasOpen) child.containerOpen = true;
                        const subName = child.title
                            ? (folderName ? `${folderName} / ${child.title}` : child.title)
                            : folderName;
                        this._collectQueryNodes(child, subName, items, seen);
                    } catch (e) { /* skip unreadable branch */ }
                    finally {
                        try { if (!wasOpen) child.containerOpen = false; } catch (e) { /* noop */ }
                    }
                    continue;
                }
                const uri = child.uri;
                if (!uri || uri.startsWith("place:")) continue;
                const key = (child.bookmarkGuid || "") + "|" + uri;
                if (seen.has(key)) continue;
                seen.add(key);
                const ms = child.dateAdded ? Math.floor(child.dateAdded / 1000)
                    : (child.time ? Math.floor(child.time / 1000) : Date.now());
                items.push(this._makeItem(
                    child.bookmarkGuid || uri,
                    child.title || uri,
                    uri,
                    folderName || "Bookmarks",
                    ms
                ));
            }
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






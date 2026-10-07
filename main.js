"use strict";

/*
 * Descriptive View
 *
 * Tags View, for the values of one frontmatter property instead of tags.
 * Every value in any note's `descriptive` list becomes a row in a tree with
 * its count: four sort orders, nested values on or off ("project/dormant"
 * hangs under "project"), collapse and expand all, a filter box, and
 * click-to-search in a pane of its own below the view.
 *
 * It is a copy of ~/Documents/obsidian-tags-view with the source swapped.
 * What changed:
 *   - values come from frontmatter, read off the metadata cache, and a count
 *     is the number of notes carrying the value or one nested under it
 *   - a click searches [descriptive:/^value(\/|$)/], which, like tag:#x,
 *     finds the value and everything nested under it and nothing else
 *   - no catching of clicks elsewhere in the vault: Obsidian has no core
 *     click on a list property value to catch
 *
 * Values listed under Settings → Descriptive View → Hidden values never
 * appear. Notes are never modified.
 */

const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  SearchComponent,
  Menu,
  Platform,
  setIcon,
  setTooltip,
  debounce,
} = require("obsidian");

const VIEW_TYPE = "descriptive-view";
const PROPERTY = "descriptive";
const ICON = "lucide-shapes";
const SEARCH_PANE_CLASS = "descriptive-view-search-pane";
/* Every search this pane runs starts with this, which is how the pane is
   told apart from Tags View's after a restart. */
const QUERY_PREFIX = "[" + PROPERTY + ":";

const DEFAULT_SETTINGS = {
  hiddenValues: [],
  folds: [],
};

const SORTS = [
  ["alphabetical", "Name (A to Z)"],
  ["alphabeticalReverse", "Name (Z to A)"],
  null,
  ["frequency", "Frequency (high to low)"],
  ["frequencyReverse", "Frequency (low to high)"],
];

/* Matched the way tags are: "#Foo/Bar" and "foo/bar" are one value. */
function normalize(value) {
  return value.trim().replace(/^#+/, "").toLowerCase();
}

/* The value, or anything nested under it. Property search matches substrings
   unless given a regex, and a regex has to escape its own slashes. */
function searchQuery(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return QUERY_PREFIX + "/^" + escaped + "(\\/|$)/]";
}

/* Core's slide: height, vertical padding and margin run between their natural
   size and zero over 100ms on the same curve, with the overflow clipped. A
   click during a running slide reverses from wherever it has got to. */
const SLIDE_PROPS = ["height", "paddingTop", "paddingBottom", "marginTop", "marginBottom"];
function slide(el, open) {
  const running = el.getAnimations();
  const from = {};
  el.show();
  if (running.length) {
    const style = getComputedStyle(el);
    for (const p of SLIDE_PROPS) from[p] = style[p];
    running.forEach((a) => a.cancel());
  }
  const style = getComputedStyle(el);
  const full = {};
  for (const p of SLIDE_PROPS) full[p] = style[p];
  const zero = {};
  for (const p of SLIDE_PROPS) zero[p] = "0px";

  const start = running.length ? from : open ? zero : full;
  const end = open ? full : zero;
  const anim = el.animate([{ ...start, overflowY: "clip" }, { ...end, overflowY: "clip" }], {
    duration: 100,
    easing: "cubic-bezier(.02, .01, .47, 1)",
  });
  anim.onfinish = () => {
    if (!open) el.hide();
  };
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

class DescriptiveView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.icon = ICON;
    this.sortOrder = "frequency";
    this.useHierarchy = true;
    this.showSearch = false;
    this.query = "";
    this.nodes = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Descriptive";
  }

  getState() {
    return {
      sortOrder: this.sortOrder,
      useHierarchy: this.useHierarchy,
      showSearch: this.showSearch,
      searchQuery: this.query,
    };
  }

  async setState(state, result) {
    if (state) {
      if (SORTS.some((s) => s && s[0] === state.sortOrder)) this.sortOrder = state.sortOrder;
      if (typeof state.useHierarchy === "boolean") this.useHierarchy = state.useHierarchy;
      if (typeof state.searchQuery === "string") this.query = state.searchQuery;
      if (typeof state.showSearch === "boolean") this.showSearch = state.showSearch;
    }
    this.syncHeader();
    this.render();
    await super.setState(state, result);
  }

  async onOpen() {
    const root = this.containerEl;
    root.empty();

    /* The header: same buttons, same order, same icons as Tags View. */
    const header = root.createDiv("nav-header");
    const buttons = header.createDiv("nav-buttons-container");
    const button = (icon, label, onClick) => {
      const el = buttons.createDiv({ cls: "clickable-icon nav-action-button" });
      setIcon(el, icon);
      setTooltip(el, label);
      el.addEventListener("click", onClick);
      return el;
    };

    button("lucide-sort-asc", "Change sort order", (evt) => {
      const menu = new Menu();
      for (const sort of SORTS) {
        if (!sort) {
          menu.addSeparator();
          continue;
        }
        menu.addItem((item) =>
          item
            .setTitle(sort[1])
            .setChecked(sort[0] === this.sortOrder)
            .onClick(() => {
              this.sortOrder = sort[0];
              this.render();
              this.app.workspace.requestSaveLayout();
            })
        );
      }
      menu.showAtMouseEvent(evt);
    });

    this.hierarchyEl = button("lucide-folder-tree", "Show nested values", () => {
      this.useHierarchy = !this.useHierarchy;
      this.syncHeader();
      this.render();
      this.app.workspace.requestSaveLayout();
    });

    this.collapseEl = button("lucide-chevrons-up-down", "Expand all", () => {
      if (!this.useHierarchy) return;
      this.setAllCollapsed(!this.allCollapsed());
    });

    this.searchButtonEl = button("lucide-search", "Show search filter", () => {
      this.showSearch = !this.showSearch;
      if (!this.showSearch) this.query = "";
      this.syncHeader();
      this.applyFilter();
      if (this.showSearch) this.search.inputEl.focus();
      this.app.workspace.requestSaveLayout();
    });

    this.search = new SearchComponent(header).setPlaceholder("Search...");
    this.search.onChange(
      debounce(
        (value) => {
          this.query = value;
          this.applyFilter();
          this.app.workspace.requestSaveLayout();
        },
        300,
        true
      )
    );

    this.listEl = root.createDiv("tag-container descriptive-view-container");

    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRender()));
    this.registerEvent(this.app.metadataCache.on("changed", () => this.requestRender()));

    this.syncHeader();
    this.render();
  }

  requestRender() {
    if (!this.debouncedRender) this.debouncedRender = debounce(() => this.render(), 300, true);
    this.debouncedRender();
  }

  syncHeader() {
    if (!this.hierarchyEl) return;
    this.hierarchyEl.toggleClass("is-active", this.useHierarchy);
    this.collapseEl.setAttr("aria-disabled", String(!this.useHierarchy));
    this.searchButtonEl.toggleClass("is-active", this.showSearch);
    this.search.containerEl.toggle(this.showSearch);
    if (this.search.getValue() !== this.query) this.search.setValue(this.query);
    this.syncCollapseButton();
  }

  /* Every value of the property across the vault. A note counts once
     towards each value it carries and, with nested values on, once towards
     each parent above them, so "project" counts every project note. The
     first spelling met is the one shown. */
  collect() {
    const hidden = this.plugin.settings.hiddenValues;
    const isHidden = (key) => hidden.some((h) => key === h || key.startsWith(h + "/"));
    const counts = new Map();
    const spelling = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const raw = this.app.metadataCache.getFileCache(file)?.frontmatter?.[PROPERTY];
      const seen = new Set();
      for (const v of [].concat(raw ?? [])) {
        if (typeof v !== "string") continue;
        const value = v.trim().replace(/^#+/, "");
        const key = normalize(value);
        if (!key || isHidden(key)) continue;
        const parts = value.split("/");
        for (let i = this.useHierarchy ? 1 : parts.length; i <= parts.length; i++) {
          const path = parts.slice(0, i).join("/");
          const k = normalize(path);
          if (!spelling.has(k)) spelling.set(k, path);
          seen.add(k);
        }
      }
      for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
    }
    return { counts, spelling };
  }

  /* Build the tree: one node per value, keyed by lower case path. With
     nested values on, "a/b" hangs under "a". */
  buildTree() {
    const { counts, spelling } = this.collect();
    const byKey = new Map();
    const roots = [];
    const make = (key) => {
      let node = byKey.get(key);
      if (!node) {
        node = { value: spelling.get(key), key, count: counts.get(key) || 0, children: [] };
        byKey.set(key, node);
      }
      return node;
    };
    const attach = (node) => {
      const cut = node.key.lastIndexOf("/");
      if (this.useHierarchy && cut > 0) {
        const parent = make(node.key.slice(0, cut));
        if (!parent.children.includes(node)) parent.children.push(node);
        attach(parent);
      } else if (!roots.includes(node)) {
        roots.push(node);
      }
    };

    for (const key of counts.keys()) attach(make(key));
    return roots;
  }

  compare() {
    const byName = (a, b) => collator.compare(a.value, b.value);
    switch (this.sortOrder) {
      case "alphabetical":
        return byName;
      case "alphabeticalReverse":
        return (a, b) => -byName(a, b);
      default: {
        const dir = this.sortOrder === "frequencyReverse" ? -1 : 1;
        return (a, b) => (a.count === b.count ? byName(a, b) : dir * (b.count - a.count));
      }
    }
  }

  render() {
    if (!this.listEl) return;
    const scroll = this.listEl.scrollTop;
    this.listEl.empty();
    this.nodes = [];

    const roots = this.buildTree();
    if (!roots.length) {
      this.listEl.createDiv({ cls: "pane-empty tag-pane-empty", text: "No descriptive values found." });
      this.syncCollapseButton();
      return;
    }

    const folds = new Set(this.plugin.settings.folds);
    const sort = this.compare();
    const draw = (node, parentEl, depth) => {
      const itemEl = parentEl.createDiv("tree-item");
      const selfEl = itemEl.createDiv("tree-item-self tag-pane-tag is-clickable");
      /* Same indentation the core pane writes inline. The base is a variable
         so sidebar-insets.css can set where the first column starts. */
      selfEl.style.setProperty("margin-inline-start", `${-17 * depth}px`, "important");
      selfEl.style.setProperty("padding-inline-start", `calc(var(--tree-row-start, 24px) + ${17 * depth}px)`, "important");

      const hasChildren = node.children.length > 0;
      if (hasChildren) {
        selfEl.addClass("mod-collapsible");
        const iconEl = (node.iconEl = selfEl.createDiv("tree-item-icon collapse-icon"));
        setIcon(iconEl, "right-triangle");
        iconEl.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.setCollapsed(node, !node.collapsed, true);
          this.plugin.saveFolds(this.nodes);
        });
      }

      const textEl = selfEl.createDiv("tree-item-inner").createDiv("tree-item-inner-text");
      const name = node.value.split("/").pop();
      textEl.createSpan({ cls: "tag-pane-tag-parent", text: node.value.slice(0, node.value.length - name.length) });
      textEl.createSpan({ cls: "tree-item-inner-text", text: name });
      selfEl
        .createDiv("tree-item-flair-outer")
        .createSpan({ cls: "tag-pane-tag-count tree-item-flair", text: String(node.count) });

      selfEl.addEventListener("click", () => this.openSearch(node.value));

      node.itemEl = itemEl;
      node.selfEl = selfEl;
      node.childrenEl = itemEl.createDiv("tree-item-children");
      this.nodes.push(node);

      node.children.sort(sort);
      for (const child of node.children) draw(child, node.childrenEl, depth + 1);
      if (hasChildren) this.setCollapsed(node, folds.has(node.key));
    };

    roots.sort(sort);
    for (const node of roots) draw(node, this.listEl, 0);

    this.applyFilter();
    this.syncCollapseButton();
    this.listEl.scrollTop = scroll;
  }

  /* Obsidian's stylesheet turns the triangle only when the icon itself carries
     is-collapsed, so the class goes on both the row and the icon, as in core. */
  setCollapsed(node, collapsed, animate = false) {
    node.collapsed = collapsed;
    node.itemEl.toggleClass("is-collapsed", collapsed);
    node.iconEl.toggleClass("is-collapsed", collapsed);
    if (animate) slide(node.childrenEl, !collapsed);
    else node.childrenEl.toggle(!collapsed);
    this.syncCollapseButton();
  }

  collapsible() {
    return this.nodes.filter((n) => n.children.length);
  }

  allCollapsed() {
    const nodes = this.collapsible();
    return nodes.length > 0 && nodes.every((n) => n.collapsed);
  }

  setAllCollapsed(collapsed) {
    for (const node of this.collapsible()) {
      if (node.collapsed !== collapsed) this.setCollapsed(node, collapsed, true);
    }
    this.plugin.saveFolds(this.nodes);
  }

  syncCollapseButton() {
    if (!this.collapseEl) return;
    const collapsed = this.allCollapsed();
    setIcon(this.collapseEl, collapsed ? "lucide-chevrons-up-down" : "lucide-chevrons-down-up");
    setTooltip(this.collapseEl, collapsed ? "Expand all" : "Collapse all");
  }

  /* Every word in the box must appear in the value. A value that matches
     keeps its parents visible so it still sits where it belongs. */
  applyFilter() {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    for (const node of this.nodes) node.itemEl.toggleClass("is-filtered-out", words.length > 0);
    if (!words.length) return;
    for (const node of this.nodes) {
      if (!words.every((w) => node.key.includes(w))) continue;
      for (let el = node.itemEl; el && el !== this.listEl; el = el.parentElement) {
        el.removeClass("is-filtered-out");
      }
    }
  }

  /* Click: search for the value in this plugin's own pane under the view. */
  openSearch(value) {
    this.plugin.showSearch(searchQuery(value), this.leaf);
  }
}

class DescriptiveViewSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Hidden values")
      .setDesc("These values, and any nested under them, never appear in the Descriptive view. Your notes are not changed.")
      .setHeading();

    let draft = "";
    const add = async () => {
      const value = normalize(draft);
      if (!value || this.plugin.settings.hiddenValues.includes(value)) return;
      this.plugin.settings.hiddenValues.push(value);
      await this.plugin.saveSettings();
      this.display();
    };

    new Setting(containerEl)
      .setName("Add a value to hide")
      .addText((text) => {
        text.setPlaceholder("project/archive").onChange((value) => (draft = value));
        text.inputEl.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") add();
        });
      })
      .addButton((btn) => btn.setButtonText("Hide").setCta().onClick(add));

    for (const value of this.plugin.settings.hiddenValues) {
      new Setting(containerEl).setName(value).addExtraButton((btn) =>
        btn
          .setIcon("lucide-x")
          .setTooltip("Show this value again")
          .onClick(async () => {
            this.plugin.settings.hiddenValues = this.plugin.settings.hiddenValues.filter((v) => v !== value);
            await this.plugin.saveSettings();
            this.display();
          })
      );
    }
  }
}

module.exports = class DescriptiveViewPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new DescriptiveView(leaf, this));
    this.addCommand({
      id: "open",
      name: "Open descriptive view",
      icon: ICON,
      callback: () => this.activate(),
    });
    this.addSettingTab(new DescriptiveViewSettingTab(this.app, this));

    /* The search pane is re-found after a restart, and re-marked whenever the
       layout is rebuilt, so its tab bar stays hidden. */
    this.app.workspace.onLayoutReady(() => this.syncSearchPane());
    this.registerEvent(this.app.workspace.on("layout-change", () => this.syncSearchPane()));
    /* Switching sidebar tabs is an active-leaf change, not a layout one. */
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncSearchPane()));
  }

  /* The search pane belongs to the view: the moment the view is not the tab
     showing in its group (another tab chosen, or the view closed), the pane
     closes. A collapsed sidebar hides both together, so that is left alone. */
  syncSearchPane() {
    const leaf = this.findSearchLeaf();
    if (!leaf) return;
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const group = view && view.parent;
    const showing = group && group.children[group.currentTab] === view;
    if (!showing) this.closeSearch();
  }

  onunload() {
    document.querySelectorAll("." + SEARCH_PANE_CLASS).forEach((el) => el.removeClass(SEARCH_PANE_CLASS));
  }

  /* --- The search pane -----------------------------------------------------
     As in Tags View: a search leaf of its own in a tab group split off below
     the view, tab bar hidden, so a search never covers the File Explorer.
     The × in its results row closes it. */

  findSearchLeaf() {
    const workspace = this.app.workspace;
    const leaf = this.searchLeaf;
    if (leaf && leaf.parent && leaf.view && leaf.view.getViewType() === "search") {
      this.adopt(leaf);
      return leaf;
    }
    this.searchLeaf = null;
    /* After a restart: a right-sidebar tab group holding nothing but a search
       leaf for this property is this pane. Tags View's holds a tag: search. */
    for (const candidate of workspace.getLeavesOfType("search")) {
      const query = candidate.getViewState().state?.query || "";
      if (
        candidate.getRoot() === workspace.rightSplit &&
        candidate.parent.children.length === 1 &&
        query.startsWith(QUERY_PREFIX)
      ) {
        this.adopt(candidate);
        return candidate;
      }
    }
    return null;
  }

  adopt(leaf) {
    this.searchLeaf = leaf;
    leaf.parent.containerEl.addClass(SEARCH_PANE_CLASS);
    this.addCloseButton(leaf);
  }

  /* Clicks are queued: a second click while the pane is still being built
     would otherwise find no pane yet and split a second one. */
  showSearch(query, anchor) {
    /* A phone cannot split a sidebar: core's createLeafBySplit falls back to
       a new tab in the same drawer and makes it active, so the view stops
       being the tab showing and syncSearchPane closes the pane at once. On a
       phone the search goes to core's own Search instead. */
    if (Platform.isPhone) {
      const search = this.app.internalPlugins.getEnabledPluginById("global-search");
      if (search) search.openGlobalSearch(query);
      return Promise.resolve();
    }
    this.searchQueue = (this.searchQueue || Promise.resolve())
      .then(() => this.runSearch(query, anchor))
      .catch((e) => console.error(e));
    return this.searchQueue;
  }

  async runSearch(query, anchor) {
    if (!query) {
      this.closeSearch();
      return;
    }
    const workspace = this.app.workspace;
    let leaf = this.findSearchLeaf();
    /* A new pane sorts by created time, newest first. An open one keeps
       whatever sort was picked in it. */
    const sortOrder = leaf ? leaf.getViewState().state.sortOrder : "byCreatedTime";
    if (!leaf) leaf = workspace.createLeafBySplit(anchor, "horizontal", false);
    /* Results always start collapsed, and the toggles styles.css hides are
       pinned off, so a hidden setting can never be silently on. */
    await leaf.setViewState({
      type: "search",
      state: { query, sortOrder, collapseAll: true, matchingCase: false, explainSearch: false, extraContext: false },
      active: false,
    });
    this.adopt(leaf);
    await workspace.revealLeaf(leaf);
  }

  closeSearch() {
    const leaf = this.findSearchLeaf();
    this.searchLeaf = null;
    if (leaf) leaf.detach();
  }

  /* The pane only ever shows a value search, so styles.css hides the search
     box, and the × that cleared it moves into the results row. */
  addCloseButton(leaf) {
    const row = leaf.view && leaf.view.containerEl && leaf.view.containerEl.querySelector(".search-results-info");
    if (!row || row.querySelector(".descriptive-view-search-close")) return;
    const button = row.createDiv({ cls: "clickable-icon descriptive-view-search-close" });
    setIcon(button, "lucide-x");
    setTooltip(button, "Close search");
    button.addEventListener("click", () => this.closeSearch());
  }

  /* Opened as a tab beside Tags View when it is open, so the two sit
     together; otherwise in a new right-sidebar leaf. */
  async activate() {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return existing;
    }
    const tags = workspace.getLeavesOfType("tags-view")[0];
    const leaf = tags
      ? workspace.createLeafInParent(tags.parent, tags.parent.children.indexOf(tags) + 1)
      : workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
    return leaf;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DescriptiveView) leaf.view.render();
    }
  }

  /* Folds are remembered across views and restarts, keyed by value path.
     Folds for values not currently drawn are kept, so turning nested values
     off and on again does not forget them. */
  saveFolds(nodes) {
    const drawn = new Set(nodes.map((n) => n.key));
    const kept = this.settings.folds.filter((k) => !drawn.has(k));
    for (const n of nodes) if (n.children.length && n.collapsed) kept.push(n.key);
    this.settings.folds = kept;
    this.saveData(this.settings);
  }
};

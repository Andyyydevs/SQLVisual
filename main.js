(function () {
  function getNodeColor(name, kind) {
    if (kind === "VIEW") return "color-brown";
    if (kind === "INSERT_TARGET") return "color-red";
    if (kind === "SUBQUERY") return "color-purple";
    if (kind === "TABLE") return "color-olive";
    return "color-green";
  }

  class StatusManager {
    constructor(el) { this.el = el; }
    set(msg, type) {
      if (!this.el) return;
      this.el.textContent = msg || "";
      this.el.classList.remove("ok", "error");
      if (type) this.el.classList.add(type);
    }
    clear() { this.set("", null); }
  }

  class EditorManager {
    constructor(textarea, statusManager) {
      this.textarea = textarea;
      this.statusManager = statusManager;
      this.editor = null;
      this.updateTimeout = null;
      this.init();
    }

    init() {
      if (!this.textarea || !window.CodeMirror) return;
      this.editor = window.CodeMirror.fromTextArea(this.textarea, {
        lineNumbers: true,
        mode: "text/x-sql",
        theme: "material-darker",
        indentUnit: 2,
        tabSize: 2,
        smartIndent: true,
        lineWrapping: false,
        scrollbarStyle: "native",
      });
      this.editor.setSize("100%", "100%");
    }

    getValue() {
      return this.editor ? this.editor.getValue() : this.textarea.value;
    }

    setValue(val) {
      if (this.editor) this.editor.setValue(val);
      else this.textarea.value = val;
    }

    onChangeDebounced(handler) {
      if (!this.editor) return;
      this.editor.on("change", () => {
        if (this.updateTimeout) clearTimeout(this.updateTimeout);
        this.updateTimeout = setTimeout(handler, 400);
      });
    }

    refresh() {
      if (this.editor) this.editor.refresh();
    }

    undo() { if (this.editor) this.editor.undo(); }

    copy() {
      const text = this.getValue();
      if (text && navigator.clipboard) navigator.clipboard.writeText(text);
    }

    format(dialect) {
      const text = this.getValue();
      if (!text.trim()) {
        this.statusManager.set("Nothing to format.", "error");
        return;
      }
      try {
        const formatted = window.SqlStructure.formatSqlBasic(text, dialect);
        this.setValue(formatted);
        this.statusManager.set("Formatted SQL.", "ok");
      } catch (e) {
        this.statusManager.set("Format failed.", "error");
      }
    }
  }

  class LayoutCalculator {
    constructor() {
      this.positions = {};
      this.NODE_W = 140;
      this.NODE_H = 100;
      this.H_GAP = 220;
      this.V_GAP = 180;
      this.GRID = 24;
    }

    calculate(tables, relationships, nodeSizes) {
      const pos = {};
      const cols = Math.max(3, Math.ceil(Math.sqrt(tables.length)));
      tables.forEach((t, i) => {
        if (this.positions[t.name]) { pos[t.name] = this.positions[t.name]; return; }
        const row = Math.floor(i / cols);
        const col = i % cols;
        const w = nodeSizes[t.name]?.width || this.NODE_W;
        const h = nodeSizes[t.name]?.height || this.NODE_H;
        const sx = Math.max(this.H_GAP, w + 40);
        const sy = Math.max(this.V_GAP, h + 40);
        const rx = 60 + col * sx;
        const ry = 60 + row * sy;
        pos[t.name] = this.snap(rx, ry);
      });
      Object.assign(this.positions, pos);
      return pos;
    }

    snap(x, y) {
      return {
        x: Math.round(x / this.GRID) * this.GRID,
        y: Math.round(y / this.GRID) * this.GRID
      };
    }

    update(name, x, y) {
      this.positions[name] = this.snap(x, y);
    }
  }

  class FlowchartRenderer {
    constructor(container, layout) {
      this.container = container;
      this.layout = layout;
      this.isDragging = false;
      this.dragNode = null;
      this.dragOffset = { x: 0, y: 0 };
      this.moveHandler = null;
      this.upHandler = null;
      this.lastSchema = null;
    }

    render(schema) {
      this.container.innerHTML = "";
      this.lastSchema = schema;

      if (!schema || !schema.tables || !schema.tables.length) {
        const ph = document.createElement("div");
        ph.className = "visual-placeholder";
        ph.textContent = "No tables detected. Add CREATE TABLE or SELECT statements.";
        this.container.appendChild(ph);
        return;
      }

      const sizes = this.measureNodes(schema.tables);
      const pos = this.layout.calculate(schema.tables, schema.relationships || [], sizes);
      const { w, h } = this.svgDimensions(schema.tables, pos, sizes);
      const svg = this.createSVG(w, h);
      const conns = this.createGroup("flowchart-connections");
      const nodes = this.createGroup("flowchart-nodes");
      svg.appendChild(conns);
      svg.appendChild(nodes);

      schema.tables.forEach((t) => {
        const p = pos[t.name];
        if (!p) return;
        const s = sizes[t.name];
        const fo = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
        fo.setAttribute("x", p.x);
        fo.setAttribute("y", p.y);
        fo.setAttribute("width", s.width);
        fo.setAttribute("height", s.height);
        fo.appendChild(this.buildNode(t));
        nodes.appendChild(fo);
      });

      this.setupDrag(nodes, svg, conns, schema.relationships || []);
      this.container.appendChild(svg);
      setTimeout(() => this.drawConnections(svg, schema.relationships || [], conns), 10);
    }

    measureNodes(tables) {
      const tmp = document.createElement("div");
      tmp.style.cssText = "position:absolute;visibility:hidden;left:-9999px";
      document.body.appendChild(tmp);
      const sizes = {};
      tables.forEach((t) => {
        const el = this.buildNode(t, true);
        tmp.appendChild(el);
        const r = el.getBoundingClientRect();
        sizes[t.name] = {
          width: Math.max(130, Math.ceil(r.width) + 4),
          height: Math.max(50, Math.ceil(r.height) + 4)
        };
        tmp.removeChild(el);
      });
      document.body.removeChild(tmp);
      return sizes;
    }

    buildNode(table, showAll) {
      const node = document.createElement("div");
      node.className = "flowchart-node";
      node.setAttribute("data-table-name", table.name);

      const header = document.createElement("div");
      header.className = "flowchart-node-header " + getNodeColor(table.name, table.kind);
      header.textContent = table.name;

      const cols = document.createElement("div");
      cols.className = "flowchart-node-columns";

      if (table.columns && table.columns.length) {
        const show = showAll ? table.columns : table.columns.slice(0, 8);
        show.forEach((c) => cols.appendChild(this.buildColumn(c)));
        if (!showAll && table.columns.length > 8) {
          const more = document.createElement("div");
          more.className = "flowchart-column";
          more.style.color = "var(--text-soft)";
          more.style.fontSize = "10px";
          more.textContent = `+${table.columns.length - 8} more`;
          cols.appendChild(more);
        }
      } else {
        const nc = document.createElement("div");
        nc.className = "flowchart-column";
        nc.style.color = "var(--text-soft)";
        nc.textContent = "(no columns)";
        cols.appendChild(nc);
      }

      node.appendChild(header);
      node.appendChild(cols);
      return node;
    }

    buildColumn(col) {
      const div = document.createElement("div");
      div.className = "flowchart-column";

      const name = document.createElement("span");
      name.className = "flowchart-column-name" + (col.isPrimary ? " pk" : "");
      name.textContent = col.name;
      div.appendChild(name);

      if (col.type) {
        const type = document.createElement("span");
        type.className = "flowchart-column-type";
        type.textContent = col.type;
        div.appendChild(type);
      }

      if (col.isPrimary) div.appendChild(this.badge("PK"));
      if (col.isUnique && !col.isPrimary) {
        const b = this.badge("UQ");
        b.style.background = "rgba(129,199,132,0.2)";
        b.style.borderColor = "rgba(129,199,132,0.5)";
        b.style.color = "#81c784";
        div.appendChild(b);
      }
      if (col.isForeignKey) {
        const b = this.badge("FK");
        b.style.background = "rgba(255,183,77,0.2)";
        b.style.borderColor = "rgba(255,183,77,0.5)";
        b.style.color = "#ffb74d";
        div.appendChild(b);
      }
      if (col.nullable === false && !col.isPrimary) div.appendChild(this.badge("NN"));

      return div;
    }

    badge(text) {
      const s = document.createElement("span");
      s.className = "flowchart-column-badge";
      s.textContent = text;
      return s;
    }

    svgDimensions(tables, pos, sizes) {
      let mx = 0, my = 0;
      tables.forEach((t) => {
        const p = pos[t.name], s = sizes[t.name];
        if (p && s) {
          mx = Math.max(mx, p.x + s.width);
          my = Math.max(my, p.y + s.height);
        }
      });
      const cr = this.container.getBoundingClientRect();
      return {
        w: Math.max(cr.width || 800, mx + 80),
        h: Math.max(cr.height || 600, my + 80)
      };
    }

    updateSvgDimensions() {
      const svg = this.container.querySelector("svg");
      if (!svg) return;
      const cr = this.container.getBoundingClientRect();
      let contentW = 0, contentH = 0;
      svg.querySelectorAll("foreignObject").forEach((fo) => {
        const x = +fo.getAttribute("x") || 0;
        const y = +fo.getAttribute("y") || 0;
        const w = +fo.getAttribute("width") || 0;
        const h = +fo.getAttribute("height") || 0;
        contentW = Math.max(contentW, x + w);
        contentH = Math.max(contentH, y + h);
      });
      const w = Math.max(cr.width || 800, contentW + 80);
      const h = Math.max(cr.height || 600, contentH + 80);
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }

    createSVG(w, h) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "flowchart-svg");
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      const markers = [
        { id: "arrowhead", color: "rgba(74,165,255,0.7)" },
        { id: "arrowhead-fk", color: "rgba(129,199,132,0.8)" },
        { id: "arrowhead-insert", color: "rgba(255,183,77,0.7)" },
      ];
      markers.forEach(({ id, color }) => {
        const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
        marker.setAttribute("id", id);
        marker.setAttribute("markerWidth", "8");
        marker.setAttribute("markerHeight", "8");
        marker.setAttribute("refX", "7");
        marker.setAttribute("refY", "3");
        marker.setAttribute("orient", "auto");
        const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", "0 0, 8 3, 0 6");
        poly.setAttribute("fill", color);
        marker.appendChild(poly);
        defs.appendChild(marker);
      });
      svg.appendChild(defs);
      return svg;
    }

    createGroup(cls) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", cls);
      return g;
    }

    getNodeRects(svg) {
      const rects = {};
      svg.querySelectorAll("foreignObject").forEach(fo => {
        const node = fo.querySelector("[data-table-name]");
        if (node) {
          rects[node.getAttribute("data-table-name")] = {
            x: +fo.getAttribute("x"), y: +fo.getAttribute("y"),
            w: +fo.getAttribute("width"), h: +fo.getAttribute("height")
          };
        }
      });
      return rects;
    }

    choosePorts(from, to) {
      const fcx = from.x + from.w / 2, fcy = from.y + from.h / 2;
      const tcx = to.x + to.w / 2, tcy = to.y + to.h / 2;
      const dx = tcx - fcx, dy = tcy - fcy;
      const adx = Math.abs(dx), ady = Math.abs(dy);

      if (adx * 0.6 > ady) {
        return dx > 0
          ? { fromSide: "right", toSide: "left" }
          : { fromSide: "left", toSide: "right" };
      } else if (ady * 0.6 > adx) {
        return dy > 0
          ? { fromSide: "bottom", toSide: "top" }
          : { fromSide: "top", toSide: "bottom" };
      } else {
        if (adx >= ady) {
          return dx > 0
            ? { fromSide: "right", toSide: "left" }
            : { fromSide: "left", toSide: "right" };
        }
        return dy > 0
          ? { fromSide: "bottom", toSide: "top" }
          : { fromSide: "top", toSide: "bottom" };
      }
    }

    getPort(rect, side, offset) {
      const o = offset * 0.08;
      switch (side) {
        case "right":  return { x: rect.x + rect.w, y: rect.y + rect.h * (0.5 + o) };
        case "left":   return { x: rect.x,          y: rect.y + rect.h * (0.5 + o) };
        case "top":    return { x: rect.x + rect.w * (0.5 + o), y: rect.y };
        case "bottom": return { x: rect.x + rect.w * (0.5 + o), y: rect.y + rect.h };
      }
    }

    buildCurvePath(p1, side1, p2, side2) {
      const dx = Math.abs(p2.x - p1.x);
      const dy = Math.abs(p2.y - p1.y);
      const dist = Math.sqrt(dx * dx + dy * dy);
      const pull = Math.max(40, Math.min(dist * 0.35, 120));

      let c1x, c1y, c2x, c2y;
      switch (side1) {
        case "right":  c1x = p1.x + pull; c1y = p1.y; break;
        case "left":   c1x = p1.x - pull; c1y = p1.y; break;
        case "bottom": c1x = p1.x; c1y = p1.y + pull; break;
        case "top":    c1x = p1.x; c1y = p1.y - pull; break;
      }
      switch (side2) {
        case "left":   c2x = p2.x - pull; c2y = p2.y; break;
        case "right":  c2x = p2.x + pull; c2y = p2.y; break;
        case "top":    c2x = p2.x; c2y = p2.y - pull; break;
        case "bottom": c2x = p2.x; c2y = p2.y + pull; break;
      }
      return `M${p1.x},${p1.y} C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
    }

    drawConnections(svg, rels, group) {
      group.innerHTML = "";
      if (!rels || !rels.length) return;

      const rects = this.getNodeRects(svg);

      const portCounts = {};
      const portMap = [];

      rels.forEach((rel) => {
        const from = rects[rel.fromTable], to = rects[rel.toTable];
        if (!from || !to) { portMap.push(null); return; }
        const { fromSide, toSide } = this.choosePorts(from, to);
        const fk = rel.fromTable + ":" + fromSide;
        const tk = rel.toTable + ":" + toSide;
        portCounts[fk] = (portCounts[fk] || 0) + 1;
        portCounts[tk] = (portCounts[tk] || 0) + 1;
        portMap.push({ from, to, fromSide, toSide, fk, tk });
      });

      const portIdx = {};

      rels.forEach((rel, idx) => {
        const info = portMap[idx];
        if (!info) return;

        const fi = (portIdx[info.fk] || 0);
        portIdx[info.fk] = fi + 1;
        const fc = portCounts[info.fk] || 1;
        const fOff = fc > 1 ? (fi - (fc - 1) / 2) : 0;

        const ti = (portIdx[info.tk] || 0);
        portIdx[info.tk] = ti + 1;
        const tc = portCounts[info.tk] || 1;
        const tOff = tc > 1 ? (ti - (tc - 1) / 2) : 0;

        const p1 = this.getPort(info.from, info.fromSide, fOff);
        const p2 = this.getPort(info.to, info.toSide, tOff);
        const d = this.buildCurvePath(p1, info.fromSide, p2, info.toSide);

        const isFK = rel.via === "FK";
        const cls = isFK ? "fk" : (rel.via === "INSERT" ? "insert" : "join");

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("class", `flowchart-connection-line ${cls}`);
        path.setAttribute("data-from-table", rel.fromTable);
        path.setAttribute("data-to-table", rel.toTable);
        group.appendChild(path);

        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", p1.x);
        dot.setAttribute("cy", p1.y);
        dot.setAttribute("r", "2.5");
        dot.setAttribute("class", "flowchart-port-dot");
        group.appendChild(dot);

        if (isFK && rel.fromColumn && rel.toColumn) {
          const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
          const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
          lbl.setAttribute("x", mx);
          lbl.setAttribute("y", my - 6);
          lbl.setAttribute("class", "flowchart-label");
          lbl.setAttribute("text-anchor", "middle");
          lbl.textContent = `${rel.fromColumn} → ${rel.toColumn}`;
          group.appendChild(lbl);
        }
      });
    }

    highlight(svg, name) {
      svg.querySelectorAll(".flowchart-node").forEach(n => {
        const match = n.getAttribute("data-table-name") === name;
        n.classList.toggle("highlighted", match);
        n.classList.toggle("dimmed", !match);
      });
      svg.querySelectorAll(".flowchart-connection-line").forEach(l => {
        const from = l.getAttribute("data-from-table");
        const to = l.getAttribute("data-to-table");
        const rel = from === name || to === name;
        l.classList.toggle("highlighted", rel);
        l.classList.toggle("dimmed", !rel);
      });
    }

    clearHighlight(svg) {
      svg.querySelectorAll(".flowchart-node").forEach(n => n.classList.remove("highlighted", "dimmed"));
      svg.querySelectorAll(".flowchart-connection-line").forEach(l => l.classList.remove("highlighted", "dimmed"));
    }

    setupDrag(nodesGroup, svg, conns, rels) {
      if (this.moveHandler) document.removeEventListener("mousemove", this.moveHandler);
      if (this.upHandler) document.removeEventListener("mouseup", this.upHandler);

      nodesGroup.querySelectorAll(".flowchart-node").forEach(node => {
        node.style.cursor = "move";
        const name = node.getAttribute("data-table-name");
        node.addEventListener("mouseenter", () => this.highlight(svg, name));
        node.addEventListener("mouseleave", () => this.clearHighlight(svg));
        node.addEventListener("mousedown", (e) => {
          this.isDragging = true;
          this.dragNode = node;
          node.classList.add("dragging");
          const fo = node.closest("foreignObject");
          const sr = svg.getBoundingClientRect();
          this.dragOffset.x = e.clientX - sr.left - (+fo.getAttribute("x") || 0);
          this.dragOffset.y = e.clientY - sr.top - (+fo.getAttribute("y") || 0);
          if (conns) conns.style.visibility = "hidden";
          e.preventDefault();
        });
      });

      this.moveHandler = (e) => {
        if (this.isDragging && this.dragNode) {
          const fo = this.dragNode.closest("foreignObject");
          const sr = svg.getBoundingClientRect();
          const rx = e.clientX - sr.left - this.dragOffset.x;
          const ry = e.clientY - sr.top - this.dragOffset.y;
          const g = this.layout.GRID || 24;
          const nx = Math.max(0, Math.round(rx / g) * g);
          const ny = Math.max(0, Math.round(ry / g) * g);
          fo.setAttribute("x", nx);
          fo.setAttribute("y", ny);
          const name = this.dragNode.getAttribute("data-table-name");
          if (name) this.layout.update(name, nx, ny);
        }
      };

      this.upHandler = () => {
        if (this.isDragging) {
          this.isDragging = false;
          if (this.dragNode) this.dragNode.classList.remove("dragging");
          this.dragNode = null;
          if (conns) conns.style.visibility = "visible";
          this.drawConnections(svg, rels, conns);
          this.clearHighlight(svg);
        }
      };

      document.addEventListener("mousemove", this.moveHandler);
      document.addEventListener("mouseup", this.upHandler);
    }
  }

  class PanelResizer {
    constructor(divider, editorPanel, editorManager) {
      this.divider = divider;
      this.editorPanel = editorPanel;
      this.editorManager = editorManager;
      this.active = false;
      this.startX = 0;
      this.startW = 0;
      if (!divider) return;
      this.init();
    }
    init() {
      this.divider.addEventListener("mousedown", (e) => {
        this.active = true;
        this.startX = e.clientX;
        this.startW = this.editorPanel.getBoundingClientRect().width;
        this.divider.classList.add("active");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!this.active) return;
        const dx = e.clientX - this.startX;
        const nw = Math.max(240, Math.min(this.startW + dx, window.innerWidth - 300));
        this.editorPanel.style.width = nw + "px";
      });
      document.addEventListener("mouseup", () => {
        if (!this.active) return;
        this.active = false;
        this.divider.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        this.editorManager.refresh();
      });
    }
  }

  class AppController {
    constructor() {
      this.textarea = document.getElementById("sqlInput");
      this.statusEl = document.getElementById("editorStatus");
      this.dialectSelect = document.getElementById("dialectSelect");
      this.editorPanel = document.getElementById("editorPanel");
      this.visualContainer = document.getElementById("visualContainer");
      this.divider = document.getElementById("panelDivider");
      this.locateSelect = document.getElementById("locateSelect");

      this.btnFormat = document.getElementById("btnFormat");
      this.btnCopy = document.getElementById("btnCopy");
      this.btnUndo = document.getElementById("btnUndo");
      this.btnRun = document.getElementById("btnRun");
      this.editorCollapseBtn = document.getElementById("editorCollapseBtn");

      if (!this.textarea) return;

      this.statusManager = new StatusManager(this.statusEl);
      this.editorManager = new EditorManager(this.textarea, this.statusManager);
      this.layout = new LayoutCalculator();
      this.renderer = new FlowchartRenderer(this.visualContainer, this.layout);
      this.resizer = new PanelResizer(this.divider, this.editorPanel, this.editorManager);

      this.init();
    }

    init() {
      this.editorManager.onChangeDebounced(() => this.analyzeAndRender());

      this.btnFormat?.addEventListener("click", () => this.editorManager.format(this.getDialect()));
      this.btnCopy?.addEventListener("click", () => this.editorManager.copy());
      this.btnUndo?.addEventListener("click", () => this.editorManager.undo());
      this.btnRun?.addEventListener("click", () => this.analyzeAndRender());

      this.editorCollapseBtn?.addEventListener("click", () => {
        this.editorPanel.classList.toggle("collapsed");
        const collapsed = this.editorPanel.classList.contains("collapsed");
        this.editorCollapseBtn.setAttribute("title", collapsed ? "Expand editor" : "Collapse editor");
        this.editorCollapseBtn.setAttribute("aria-label", collapsed ? "Expand editor" : "Collapse editor");
        this.editorManager.refresh();
        if (this.visualContainer.querySelector("svg")) this.renderer.updateSvgDimensions();
      });

      this.locateSelect?.addEventListener("change", (e) => {
        const name = e.target.value;
        if (!name) return;
        const svg = this.visualContainer.querySelector("svg");
        if (!svg) return;
        const node = svg.querySelector(`[data-table-name="${name}"]`);
        if (node) {
          const fo = node.closest("foreignObject");
          if (fo) {
            const x = +fo.getAttribute("x"), y = +fo.getAttribute("y");
            this.visualContainer.scrollTo({
              left: Math.max(0, x - 100),
              top: Math.max(0, y - 100),
              behavior: "smooth"
            });
          }
          this.renderer.highlight(svg, name);
          setTimeout(() => this.renderer.clearHighlight(svg), 2000);
        }
      });

      window.addEventListener("resize", () => this.editorManager.refresh());

      const resizeObserver = new ResizeObserver(() => {
        if (this.visualContainer.querySelector("svg")) this.renderer.updateSvgDimensions();
      });
      resizeObserver.observe(this.visualContainer);

      this.analyzeAndRender();
    }

    getDialect() {
      return this.dialectSelect?.value || "sqlserver";
    }

    populateLocate(tables) {
      if (!this.locateSelect) return;
      const val = this.locateSelect.value;
      this.locateSelect.innerHTML = '<option value="">select to locate</option>';
      tables.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.name;
        opt.textContent = t.name;
        this.locateSelect.appendChild(opt);
      });
      if (val) this.locateSelect.value = val;
    }

    analyzeAndRender() {
      const text = this.editorManager.getValue();
      if (!text.trim()) {
        this.statusManager.clear();
        this.visualContainer.innerHTML = '<div class="visual-placeholder">Start typing SQL to see tables and relationships visualized.</div>';
        return;
      }

      try {
        const dialect = this.getDialect();
        const schema = window.SqlStructure.analyzeSchema(text, dialect);
        this.renderer.render(schema);
        this.populateLocate(schema.tables);

        const tc = schema.tables.length;
        const rc = schema.relationships.length;
        this.statusManager.set(
          `${tc} table${tc !== 1 ? "s" : ""}, ${rc} relationship${rc !== 1 ? "s" : ""}`,
          "ok"
        );

      } catch (e) {
        console.error(e);
        this.statusManager.set("Analysis failed.", "error");
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => new AppController());
  } else {
    new AppController();
  }
})();

(function () {
  const SAMPLE_SQL = `-- Grocery Store Database Schema

CREATE TABLE categories (
    category_id   INT           PRIMARY KEY AUTO_INCREMENT,
    name          VARCHAR(100)  NOT NULL UNIQUE,
    description   TEXT,
    created_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE products (
    product_id    INT             PRIMARY KEY AUTO_INCREMENT,
    category_id   INT             NOT NULL,
    name          VARCHAR(150)    NOT NULL,
    price         DECIMAL(10, 2)  NOT NULL,
    unit          VARCHAR(20)     DEFAULT 'each',
    is_active     BOOLEAN         DEFAULT TRUE,
    created_at    TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(category_id)
);

CREATE TABLE inventory (
    inventory_id      INT       PRIMARY KEY AUTO_INCREMENT,
    product_id        INT       NOT NULL UNIQUE,
    quantity_on_hand  INT       NOT NULL DEFAULT 0,
    reorder_level     INT       NOT NULL DEFAULT 10,
    updated_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(product_id)
);

CREATE TABLE customers (
    customer_id   INT          PRIMARY KEY AUTO_INCREMENT,
    first_name    VARCHAR(80)  NOT NULL,
    last_name     VARCHAR(80)  NOT NULL,
    email         VARCHAR(150) UNIQUE,
    phone         VARCHAR(20),
    created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
    order_id        INT             PRIMARY KEY AUTO_INCREMENT,
    customer_id     INT             NOT NULL,
    order_date      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    status          ENUM('pending', 'confirmed', 'fulfilled', 'cancelled') DEFAULT 'pending',
    total_amount    DECIMAL(10, 2)  NOT NULL DEFAULT 0.00,
    payment_method  VARCHAR(50),
    FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);

CREATE TABLE order_items (
    item_id     INT             PRIMARY KEY AUTO_INCREMENT,
    order_id    INT             NOT NULL,
    product_id  INT             NOT NULL,
    quantity    INT             NOT NULL CHECK (quantity > 0),
    unit_price  DECIMAL(10, 2)  NOT NULL,
    subtotal    DECIMAL(10, 2)  GENERATED ALWAYS AS (quantity * unit_price) STORED,
    FOREIGN KEY (order_id)   REFERENCES orders(order_id),
    FOREIGN KEY (product_id) REFERENCES products(product_id)
);
`;

  const TABLE_KIND_LEGEND = [
    { kind: "TABLE", label: "Table (CREATE TABLE)", color: "color-olive" },
    { kind: "INSERT_TARGET", label: "Insert target (INSERT INTO)", color: "color-red" },
    { kind: "VIEW", label: "View", color: "color-brown" },
    { kind: "SUBQUERY", label: "Subquery / alias", color: "color-purple" },
    { kind: "SOURCE", label: "Referenced in query", color: "color-green" },
  ];

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

  class SqlTableLocator {
    static escapeRegExp(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    static tableIdPattern(tableName) {
      const base = this.escapeRegExp(tableName);
      return String.raw`(?:[\`"\[]?${base}[\`"\]]?)`;
    }

    static statementRange(sql, start) {
      let end = sql.indexOf(";", start);
      if (end === -1) end = sql.length;
      else end += 1;
      return { from: start, to: end };
    }

    static findRange(sql, tableName) {
      if (!sql || !tableName) return null;
      const id = this.tableIdPattern(tableName);
      const createRe = new RegExp(
        String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${id}\s*\(`,
        "i"
      );
      let m = createRe.exec(sql);
      if (m) return this.statementRange(sql, m.index);

      const insertRe = new RegExp(String.raw`INSERT\s+INTO\s+${id}\b`, "i");
      m = insertRe.exec(sql);
      if (m) return this.statementRange(sql, m.index);

      const fromRe = new RegExp(String.raw`\bFROM\s+${id}\b`, "i");
      m = fromRe.exec(sql);
      if (m) return this.statementRange(sql, m.index);

      return null;
    }
  }

  class EditorManager {
    constructor(textarea, statusManager) {
      this.textarea = textarea;
      this.statusManager = statusManager;
      this.editor = null;
      this.updateTimeout = null;
      this.tableMark = null;
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

    clearTableHighlight() {
      if (this.tableMark) {
        this.tableMark.clear();
        this.tableMark = null;
      }
    }

    navigateToTable(tableName) {
      if (!this.editor) return false;
      const sql = this.getValue();
      const range = SqlTableLocator.findRange(sql, tableName);
      if (!range) return false;

      const from = this.editor.posFromIndex(range.from);
      const to = this.editor.posFromIndex(range.to);
      this.clearTableHighlight();
      this.editor.focus();
      this.editor.setSelection(from, to);
      this.tableMark = this.editor.markText(from, to, { className: "sql-table-highlight" });
      this.editor.scrollIntoView({ from, to }, 60);
      return true;
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
    constructor(container, layout, options) {
      this.container = container;
      this.layout = layout;
      this.onTableSelect = options?.onTableSelect || null;
      this.isDragging = false;
      this.dragNode = null;
      this.dragOffset = { x: 0, y: 0 };
      this.moveHandler = null;
      this.upHandler = null;
      this.lastSchema = null;
      this.lastRels = [];
      this.selectedTable = null;
      this.pointerDown = null;
      this.dragRaf = null;
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

      this.lastRels = schema.relationships || [];
      this.setupDrag(nodes, svg, conns, this.lastRels);
      this.container.appendChild(svg);
      setTimeout(() => {
        this.drawConnections(svg, schema.relationships || [], conns);
        if (this.selectedTable) this.setSelectedTable(svg, this.selectedTable);
      }, 10);
    }

    setSelectedTable(svg, name) {
      this.selectedTable = name || null;
      if (!svg) svg = this.container.querySelector("svg");
      if (!svg) return;
      svg.querySelectorAll(".flowchart-node").forEach((n) => {
        const tname = n.getAttribute("data-table-name");
        n.classList.toggle("selected", name && this.tableNamesMatch(tname, name));
      });
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
      div.setAttribute("data-column-name", col.name);

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

    resolveRect(rects, tableName) {
      if (!tableName) return null;
      if (rects[tableName]) return rects[tableName];
      const lower = tableName.toLowerCase();
      const key = Object.keys(rects).find((k) => k.toLowerCase() === lower);
      return key ? rects[key] : null;
    }

    buildSelfLoopPath(rect, fromSide) {
      const g = this.layout?.GRID || 24;
      const pad = Math.max(g, 28);
      const start = this.getPort(rect, fromSide, 0);
      const lead = this.projectFromPort(start, fromSide, pad);
      let c1, c2, endSide;
      if (fromSide === "right" || fromSide === "left") {
        const out = fromSide === "right" ? pad : -pad;
        c1 = { x: lead.x + out, y: lead.y };
        c2 = { x: lead.x + out, y: lead.y + pad };
        endSide = "bottom";
      } else {
        const out = fromSide === "bottom" ? pad : -pad;
        c1 = { x: lead.x, y: lead.y + out };
        c2 = { x: lead.x + pad, y: lead.y + out };
        endSide = "right";
      }
      const end = this.getPort(rect, endSide, 0);
      const endLead = this.projectFromPort(
        { x: this.snapToGrid(end.x), y: this.snapToGrid(end.y) },
        endSide,
        pad
      );
      const pts = [start, lead, c1, c2, endLead, end];
      const clean = pts.filter((pt, i) => {
        if (i === 0) return true;
        const prev = pts[i - 1];
        return prev.x !== pt.x || prev.y !== pt.y;
      });
      return clean.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" ");
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

    getColumnCenterY(svg, tableName, columnName, rect) {
      const node = this.findTableNode(svg, tableName);
      if (!node) return rect.y + rect.h / 2;
      const col = this.findColumnEl(node, columnName);
      if (!col) return rect.y + rect.h / 2;
      const header = node.querySelector(".flowchart-node-header");
      const headerH = header ? header.offsetHeight : 24;
      const nodeRect = node.getBoundingClientRect();
      const colRect = col.getBoundingClientRect();
      return rect.y + (colRect.top - nodeRect.top) + colRect.height / 2;
    }

    getPortAtY(rect, side, y) {
      const clamped = Math.max(rect.y + 8, Math.min(rect.y + rect.h - 8, y));
      switch (side) {
        case "right": return { x: rect.x + rect.w, y: clamped };
        case "left": return { x: rect.x, y: clamped };
        case "top": return { x: rect.x + rect.w / 2, y: rect.y };
        case "bottom": return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
        default: return { x: rect.x + rect.w / 2, y: clamped };
      }
    }

    findTableNode(svg, tableName) {
      let found = null;
      svg.querySelectorAll(".flowchart-node").forEach((n) => {
        if (this.tableNamesMatch(n.getAttribute("data-table-name"), tableName)) found = n;
      });
      return found;
    }

    findColumnEl(node, columnName) {
      if (!columnName) return null;
      const want = columnName.toLowerCase();
      return [...node.querySelectorAll("[data-column-name]")].find(
        (el) => el.getAttribute("data-column-name").toLowerCase() === want
      ) || null;
    }

    pathMidpoint(pathD) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", pathD);
      const len = path.getTotalLength();
      if (!len) return { x: 0, y: 0 };
      const pt = path.getPointAtLength(len * 0.5);
      return { x: pt.x, y: pt.y };
    }

    snapToGrid(value) {
      const g = this.layout?.GRID || 24;
      return Math.round(value / g) * g;
    }

    projectFromPort(point, side, distance) {
      switch (side) {
        case "right": return { x: point.x + distance, y: point.y };
        case "left": return { x: point.x - distance, y: point.y };
        case "bottom": return { x: point.x, y: point.y + distance };
        case "top": return { x: point.x, y: point.y - distance };
        default: return { x: point.x, y: point.y };
      }
    }

    buildOrthogonalPath(p1, side1, p2, side2) {
      const g = this.layout?.GRID || 24;
      const lead = Math.max(g * 2, 32);

      const start = { x: this.snapToGrid(p1.x), y: this.snapToGrid(p1.y) };
      const end = { x: this.snapToGrid(p2.x), y: this.snapToGrid(p2.y) };
      const p1Lead = this.projectFromPort(start, side1, lead);
      const p2Lead = this.projectFromPort(end, side2, lead);

      const points = [start, p1Lead];

      if (p1Lead.x === p2Lead.x || p1Lead.y === p2Lead.y) {
        points.push(p2Lead);
      } else if (side1 === "left" || side1 === "right") {
        const midX = this.snapToGrid((p1Lead.x + p2Lead.x) / 2);
        points.push({ x: midX, y: p1Lead.y });
        points.push({ x: midX, y: p2Lead.y });
        points.push(p2Lead);
      } else {
        const midY = this.snapToGrid((p1Lead.y + p2Lead.y) / 2);
        points.push({ x: p1Lead.x, y: midY });
        points.push({ x: p2Lead.x, y: midY });
        points.push(p2Lead);
      }

      points.push(end);

      const clean = points.filter((pt, i) => {
        if (i === 0) return true;
        const prev = points[i - 1];
        return prev.x !== pt.x || prev.y !== pt.y;
      });

      return clean.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`).join(" ");
    }

    drawConnections(svg, rels, group) {
      group.innerHTML = "";
      if (!rels || !rels.length) return;

      const rects = this.getNodeRects(svg);

      const portCounts = {};
      const portMap = [];

      rels.forEach((rel) => {
        const from = this.resolveRect(rects, rel.fromTable);
        const to = this.resolveRect(rects, rel.toTable);
        if (!from || !to) { portMap.push(null); return; }
        const sameTable = rel.fromTable.toLowerCase() === rel.toTable.toLowerCase();
        const { fromSide, toSide } = sameTable
          ? { fromSide: "right", toSide: "bottom" }
          : this.choosePorts(from, to);
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

        let p1 = this.getPort(info.from, info.fromSide, fOff);
        let p2 = this.getPort(info.to, info.toSide, tOff);
        const isFK = rel.via === "FK";
        if (isFK && rel.fromColumn) {
          const fy = this.getColumnCenterY(svg, rel.fromTable, rel.fromColumn, info.from);
          p1 = this.getPortAtY(info.from, info.fromSide, fy);
        }
        if (isFK && rel.toColumn) {
          const ty = this.getColumnCenterY(svg, rel.toTable, rel.toColumn, info.to);
          p2 = this.getPortAtY(info.to, info.toSide, ty);
        }

        const selfLoop = rel.fromTable.toLowerCase() === rel.toTable.toLowerCase();
        const d = selfLoop
          ? this.buildSelfLoopPath(info.from, info.fromSide)
          : this.buildOrthogonalPath(p1, info.fromSide, p2, info.toSide);

        const cls = isFK ? "fk" : (rel.via === "INSERT" ? "insert" : "join");

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", d);
        path.setAttribute("class", `flowchart-connection-line ${cls}`);
        path.setAttribute("data-from-table", rel.fromTable);
        path.setAttribute("data-to-table", rel.toTable);
        if (rel.fromColumn) path.setAttribute("data-from-column", rel.fromColumn);
        if (rel.toColumn) path.setAttribute("data-to-column", rel.toColumn);
        group.appendChild(path);

        [p1, p2].forEach((pt) => {
          const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
          dot.setAttribute("cx", pt.x);
          dot.setAttribute("cy", pt.y);
          dot.setAttribute("r", "3");
          dot.setAttribute("class", "flowchart-port-dot" + (isFK ? " fk" : ""));
          group.appendChild(dot);
        });

        if (isFK && rel.fromColumn && rel.toColumn) {
          const mid = this.pathMidpoint(d);
          const labelText = `${rel.fromColumn} → ${rel.toColumn}`;
          const pad = Math.max(4, labelText.length * 2.8);
          const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          bg.setAttribute("x", mid.x - pad);
          bg.setAttribute("y", mid.y - 14);
          bg.setAttribute("width", pad * 2);
          bg.setAttribute("height", 14);
          bg.setAttribute("rx", "3");
          bg.setAttribute("class", "flowchart-label-bg");
          group.appendChild(bg);

          const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
          lbl.setAttribute("x", mid.x);
          lbl.setAttribute("y", mid.y - 4);
          lbl.setAttribute("class", "flowchart-label");
          lbl.setAttribute("text-anchor", "middle");
          lbl.textContent = labelText;
          group.appendChild(lbl);
        }
      });
    }

    tableNamesMatch(a, b) {
      return a && b && a.toLowerCase() === b.toLowerCase();
    }

    highlight(svg, name) {
      const connected = new Set();
      svg.querySelectorAll(".flowchart-connection-line").forEach((l) => {
        const from = l.getAttribute("data-from-table");
        const to = l.getAttribute("data-to-table");
        const rel = this.tableNamesMatch(from, name) || this.tableNamesMatch(to, name);
        if (rel) {
          connected.add(from);
          connected.add(to);
          l.classList.add("highlighted");
          l.classList.remove("dimmed");
        } else {
          l.classList.remove("highlighted");
          l.classList.add("dimmed");
        }
      });
      svg.querySelectorAll(".flowchart-node").forEach((n) => {
        const tname = n.getAttribute("data-table-name");
        n.classList.remove("highlighted", "connected", "dimmed");
        if (this.tableNamesMatch(tname, name)) {
          n.classList.add("highlighted");
        } else if ([...connected].some((c) => this.tableNamesMatch(c, tname))) {
          n.classList.add("connected");
        } else {
          n.classList.add("dimmed");
        }
      });
    }

    clearHighlight(svg) {
      svg.querySelectorAll(".flowchart-node").forEach((n) =>
        n.classList.remove("highlighted", "connected", "dimmed")
      );
      svg.querySelectorAll(".flowchart-connection-line").forEach((l) =>
        l.classList.remove("highlighted", "dimmed")
      );
    }

    setupDrag(nodesGroup, svg, conns, rels) {
      if (this.moveHandler) document.removeEventListener("mousemove", this.moveHandler);
      if (this.upHandler) document.removeEventListener("mouseup", this.upHandler);

      nodesGroup.querySelectorAll(".flowchart-node").forEach(node => {
        node.style.cursor = "pointer";
        const name = node.getAttribute("data-table-name");
        node.addEventListener("mouseenter", () => this.highlight(svg, name));
        node.addEventListener("mouseleave", () => this.clearHighlight(svg));
        node.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          this.pointerDown = { x: e.clientX, y: e.clientY, name, moved: false };
          this.isDragging = true;
          this.dragNode = node;
          node.classList.add("dragging");
          const fo = node.closest("foreignObject");
          const sr = svg.getBoundingClientRect();
          this.dragOffset.x = e.clientX - sr.left - (+fo.getAttribute("x") || 0);
          this.dragOffset.y = e.clientY - sr.top - (+fo.getAttribute("y") || 0);
          e.preventDefault();
        });
      });

      this.moveHandler = (e) => {
        if (this.pointerDown) {
          const dx = e.clientX - this.pointerDown.x;
          const dy = e.clientY - this.pointerDown.y;
          if (Math.hypot(dx, dy) > 5) this.pointerDown.moved = true;
        }
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
          if (conns) {
            if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
            this.dragRaf = requestAnimationFrame(() => {
              this.drawConnections(svg, rels, conns);
              this.dragRaf = null;
            });
          }
        }
      };

      this.upHandler = () => {
        if (this.isDragging) {
          const clicked = this.pointerDown && !this.pointerDown.moved;
          const tableName = this.pointerDown?.name;
          this.isDragging = false;
          if (this.dragNode) this.dragNode.classList.remove("dragging");
          this.dragNode = null;
          this.pointerDown = null;
          if (this.dragRaf) {
            cancelAnimationFrame(this.dragRaf);
            this.dragRaf = null;
          }
          this.drawConnections(svg, rels, conns);
          if (clicked && tableName && this.onTableSelect) {
            this.onTableSelect(tableName);
          } else {
            this.clearHighlight(svg);
          }
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
      this.btnSampleSql = document.getElementById("btnSampleSql");
      this.tabLineage = document.getElementById("tabLineage");
      this.tabJoin = document.getElementById("tabJoin");

      this.btnFormat = document.getElementById("btnFormat");
      this.btnCopy = document.getElementById("btnCopy");
      this.btnUndo = document.getElementById("btnUndo");
      this.btnRun = document.getElementById("btnRun");
      this.editorCollapseBtn = document.getElementById("editorCollapseBtn");

      if (!this.textarea) return;

      this.statusManager = new StatusManager(this.statusEl);
      this.editorManager = new EditorManager(this.textarea, this.statusManager);
      this.layout = new LayoutCalculator();
      this.renderer = new FlowchartRenderer(this.visualContainer, this.layout, {
        onTableSelect: (name) => this.selectTable(name),
      });
      this.resizer = new PanelResizer(this.divider, this.editorPanel, this.editorManager);
      this.selectedTable = null;

      this.init();
    }

    init() {
      this.editorManager.onChangeDebounced(() => {
        this.editorManager.clearTableHighlight();
        this.analyzeAndRender();
      });

      this.btnFormat?.addEventListener("click", () => this.editorManager.format(this.getDialect()));
      this.btnCopy?.addEventListener("click", () => this.editorManager.copy());
      this.btnUndo?.addEventListener("click", () => this.editorManager.undo());
      this.btnRun?.addEventListener("click", () => this.analyzeAndRender());
      this.btnSampleSql?.addEventListener("click", () => this.loadSampleSql());
      this.tabLineage?.addEventListener("click", () => this.showComingSoon("Lineage mode is coming soon."));
      this.tabJoin?.addEventListener("click", () => this.showComingSoon("Join mode is coming soon."));

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
        this.selectTable(name);
      });

      window.addEventListener("resize", () => this.editorManager.refresh());

      const resizeObserver = new ResizeObserver(() => {
        if (this.visualContainer.querySelector("svg")) this.renderer.updateSvgDimensions();
      });
      resizeObserver.observe(this.visualContainer);

      this.analyzeAndRender();
    }

    showComingSoon(msg) {
      this.statusManager.set(msg, null);
    }

    loadSampleSql() {
      this.editorManager.clearTableHighlight();
      this.editorManager.setValue(SAMPLE_SQL);
      this.selectedTable = null;
      if (this.locateSelect) this.locateSelect.value = "";
      this.analyzeAndRender();
      this.statusManager.set("Loaded sample SQL.", "ok");
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
      else if (this.selectedTable) this.locateSelect.value = this.selectedTable;
    }

    selectTable(name) {
      if (!name) return;
      this.selectedTable = name;

      if (this.editorPanel?.classList.contains("collapsed")) {
        this.editorPanel.classList.remove("collapsed");
        this.editorCollapseBtn?.setAttribute("title", "Collapse editor");
        this.editorCollapseBtn?.setAttribute("aria-label", "Collapse editor");
        this.editorManager.refresh();
      }

      if (this.locateSelect && this.locateSelect.value !== name) {
        this.locateSelect.value = name;
      }

      const svg = this.visualContainer.querySelector("svg");
      if (svg) {
        this.scrollDiagramToTable(svg, name);
        this.renderer.setSelectedTable(svg, name);
        this.renderer.highlight(svg, name);
      }

      const found = this.editorManager.navigateToTable(name);
      if (found) {
        this.statusManager.set(`Located ${name} in SQL.`, "ok");
      } else {
        this.statusManager.set(`No SQL definition found for "${name}".`, "error");
      }
    }

    scrollDiagramToTable(svg, name) {
      const nodes = svg.querySelectorAll(".flowchart-node");
      let node = null;
      nodes.forEach((n) => {
        if (this.renderer.tableNamesMatch(n.getAttribute("data-table-name"), name)) node = n;
      });
      if (!node) return;
      const fo = node.closest("foreignObject");
      if (!fo) return;
      const x = +fo.getAttribute("x");
      const y = +fo.getAttribute("y");
      this.visualContainer.scrollTo({
        left: Math.max(0, x - 100),
        top: Math.max(0, y - 100),
        behavior: "smooth",
      });
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

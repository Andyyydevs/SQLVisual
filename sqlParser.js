(function (global) {
  const KEYWORDS = [
    "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "WITH", "MERGE"
  ];

  const CLAUSE_KEYWORDS = [
    "SELECT", "FROM", "WHERE", "GROUP BY", "HAVING", "ORDER BY",
    "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
    "UNION", "UNION ALL", "VALUES", "SET", "INTO", "ON"
  ];

  class SQLParser {
    static normalizeWhitespace(sql) {
      return sql.replace(/\r\n/g, "\n").replace(/\t/g, "  ");
    }

    static splitStatements(sql) {
      const result = [];
      let buffer = "";
      let inSingle = false;
      let inDouble = false;

      for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;

        if (ch === "-" && next === "-" && !inSingle && !inDouble) {
          while (i < sql.length && sql[i] !== "\n") i++;
          buffer += "\n";
          continue;
        }

        if (ch === ";" && !inSingle && !inDouble) {
          if (buffer.trim()) result.push(buffer.trim());
          buffer = "";
          continue;
        }

        buffer += ch;
      }

      if (buffer.trim()) result.push(buffer.trim());
      return result;
    }

    static classifyStatement(stmt) {
      const head = stmt.slice(0, 200).toUpperCase();
      return KEYWORDS.find((k) => head.startsWith(k)) || "OTHER";
    }

    static getClauseKeywords(dialect) {
      const base = CLAUSE_KEYWORDS.slice();
      const d = (dialect || "generic").toLowerCase();
      if (d === "sqlserver") base.push("TOP", "OFFSET", "FETCH NEXT");
      else if (d === "postgres") base.push("LIMIT", "OFFSET", "RETURNING");
      else if (d === "mysql") base.push("LIMIT");
      return base;
    }

    static detectClauses(stmt, dialect) {
      const up = stmt.toUpperCase();
      return this.getClauseKeywords(dialect).filter((c) => up.includes(c));
    }

    analyze(sql, dialect) {
      const d = (dialect || "generic").toLowerCase();
      const clean = SQLParser.normalizeWhitespace(sql);
      const statements = SQLParser.splitStatements(clean);

      return statements.map((stmt, index) => {
        const kind = SQLParser.classifyStatement(stmt);
        const clauses = SQLParser.detectClauses(stmt, d);
        const formatted = SQLFormatter.format(stmt, d);
        return { index, kind, clauses, raw: stmt, formatted };
      });
    }
  }

  class SQLFormatter {
    static format(sql, dialect) {
      let text = SQLParser.normalizeWhitespace(sql).trim();
      if (!text) return "";
      const d = (dialect || "generic").toLowerCase();
      const kws = SQLParser.getClauseKeywords(d).concat([
        "INSERT", "INTO", "VALUES", "UPDATE", "DELETE", "SET",
        "CREATE", "ALTER", "DROP", "WITH", "MERGE"
      ]);
      for (const kw of kws) {
        text = text.replace(new RegExp("\\b" + kw + "\\b", "gi"), "\n" + kw);
      }
      const lines = text.split("\n").map(l => l.trim()).filter(l => l);
      let indent = 0;
      const out = [];
      for (const raw of lines) {
        const upper = raw.toUpperCase();
        if (/^(FROM|WHERE|GROUP BY|HAVING|ORDER BY|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|OUTER JOIN)/.test(upper)) indent = 1;
        else if (/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|MERGE)\b/.test(upper)) indent = 0;
        out.push("  ".repeat(indent) + raw);
      }
      return out.join("\n");
    }
  }

  class SchemaAnalyzer {
    static strip(id) {
      if (!id) return id;
      return id.replace(/^[`"\[]?/, "").replace(/[`"\]]?$/, "").replace(/^\(+/, "").replace(/\)+$/, "");
    }

    static ensureTable(map, name, kind) {
      if (!name) return null;
      const key = name.toUpperCase();
      if (!map[key]) {
        map[key] = { name, kind: kind || "SOURCE", columns: [], foreignKeys: [], roles: new Set() };
      }
      if (kind) {
        if (kind === "TABLE" && map[key].kind === "SOURCE") map[key].kind = "TABLE";
        else if (kind !== "SOURCE" && kind !== "TABLE") map[key].kind = kind;
        map[key].roles.add(kind);
      }
      return map[key];
    }

    static parseCreateTable(stmt, map, rels) {
      const nameMatch = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i);
      if (!nameMatch) return;
      const rawName = this.strip(nameMatch[1]);
      const table = this.ensureTable(map, rawName, "TABLE");
      if (!table) return;

      const bodyMatch = stmt.match(/\(([\s\S]*)\)/);
      if (!bodyMatch) return;
      const body = bodyMatch[1];
      const lines = body.split("\n");
      const fkColNames = new Set();

      lines.forEach((line) => {
        let def = line.trim();
        if (!def) return;
        if (def.endsWith(",")) def = def.slice(0, -1).trim();
        const up = def.toUpperCase();
        if (/^(PRIMARY KEY|FOREIGN KEY|CONSTRAINT|UNIQUE|CHECK|INDEX|KEY)\b/.test(up)) return;

        const parts = def.split(/\s+/);
        if (!parts.length) return;
        const colName = this.strip(parts[0]);
        if (!colName) return;

        const isPrimary = /PRIMARY\s+KEY/i.test(def);
        const notNull = /NOT\s+NULL/i.test(def);
        const isUnique = /\bUNIQUE\b/i.test(def);
        const isAutoInc = /\bAUTO_INCREMENT\b/i.test(def) || /\bIDENTITY\b/i.test(def);

        let defaultValue = null;
        const dm = def.match(/\bDEFAULT\s+([^\s,)]+)/i);
        if (dm) defaultValue = dm[1].trim();

        const rest = def.slice(parts[0].length).trim();
        let type = "";
        const tm = rest.match(/^([A-Z0-9_]+(\s*\([^)]*\))?)/i);
        if (tm) type = tm[1].trim();

        table.columns.push({
          name: colName, isPrimary, type, nullable: !notNull,
          isUnique, isAutoIncrement: isAutoInc, defaultValue
        });
      });

      const fkRegex = /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^\s(]+)\s*\(([^)]+)\)/gi;
      let m;
      while ((m = fkRegex.exec(body))) {
        const fromCols = m[1].split(",").map(c => this.strip(c.trim()));
        const toTable = this.strip(m[2]);
        const toCols = m[3].split(",").map(c => this.strip(c.trim()));
        if (!fromCols.length || !toCols.length || !toTable) continue;
        const rel = {
          fromTable: table.name, fromColumn: fromCols[0],
          toTable, toColumn: toCols[0], via: "FK"
        };
        table.foreignKeys.push(rel);
        rels.push(rel);
        fromCols.forEach(c => { if (c) fkColNames.add(c.toUpperCase()); });
      }

      if (fkColNames.size) {
        table.columns.forEach(col => {
          if (fkColNames.has((col.name || "").toUpperCase())) col.isForeignKey = true;
        });
      }
    }

    static parseCreateView(stmt, map) {
      const nameMatch = stmt.match(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([^\s(]+)/i);
      if (!nameMatch) return null;
      const rawName = this.strip(nameMatch[1]);
      const table = this.ensureTable(map, rawName, "VIEW");

      const selectMatch = stmt.match(/\bAS\s+(SELECT\b[\s\S]*)/i);
      if (selectMatch && table) {
        const cols = this.extractSelectColumns(selectMatch[1]);
        if (cols.length && !table.columns.length) {
          table.columns = cols.map(c => ({ name: c, isPrimary: false, type: "", nullable: true }));
        }
      }
      return rawName;
    }

    static extractSelectColumns(selectClause) {
      const fromIdx = selectClause.search(/\bFROM\b/i);
      const selectPart = fromIdx > 0 ? selectClause.slice(0, fromIdx) : selectClause;
      const afterSelect = selectPart.replace(/^SELECT\s+/i, "").trim();

      const cols = [];
      let depth = 0, buf = "";
      for (let i = 0; i < afterSelect.length; i++) {
        const ch = afterSelect[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 0) {
          const col = this.extractColumnAlias(buf.trim());
          if (col) cols.push(col);
          buf = "";
          continue;
        }
        buf += ch;
      }
      const last = this.extractColumnAlias(buf.trim());
      if (last) cols.push(last);
      return cols;
    }

    static extractColumnAlias(expr) {
      if (!expr) return null;
      const quoted = expr.match(/["']([^"']+)["']\s*$/);
      if (quoted) return quoted[1];
      const aliasMatch = expr.match(/\b(?:AS\s+)?([A-Z_][A-Z0-9_]*)\s*$/i);
      if (aliasMatch) {
        const alias = aliasMatch[1];
        const reserved = ["FROM", "WHERE", "AS", "AND", "OR", "NOT", "NULL", "SELECT", "INTO"];
        if (!reserved.includes(alias.toUpperCase())) return alias;
      }
      const dotMatch = expr.match(/([A-Z_][A-Z0-9_]*)\s*$/i);
      if (dotMatch) return dotMatch[1];
      return null;
    }

    static isValidTableName(name) {
      if (!name || name.length < 2) return false;
      if (/^(SELECT|FROM|WHERE|AND|OR|NOT|NULL|AS|ON|SET|INTO|VALUES|GROUP|ORDER|BY|HAVING|LIMIT|JOIN|LEFT|RIGHT|INNER|OUTER|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|MERGE|WHEN|THEN|CASE|END|ALL|UNION|BETWEEN|LIKE|IN|EXISTS|COUNT|SUM|AVG|MIN|MAX|DISTINCT|TOP|OFFSET|FETCH)$/i.test(name)) return false;
      if (/[()]/.test(name)) return false;
      if (/^\d+$/.test(name)) return false;
      return /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(name);
    }

    static parseFromTables(stmt, map, rels) {
      const tableNames = [];

      const fromRegex = /\bFROM\s+([^(][^;]*?)(?=\bWHERE\b|\bGROUP\b|\bHAVING\b|\bORDER\b|\bLIMIT\b|\bUNION\b|$)/gi;
      let fm;
      while ((fm = fromRegex.exec(stmt))) {
        let fromClause = fm[1].trim();
        fromClause = fromClause.replace(/\bJOIN\b[\s\S]*/i, "").trim();
        const tableParts = fromClause.split(",");
        tableParts.forEach(part => {
          const tokens = part.trim().split(/\s+/);
          if (tokens.length > 0) {
            let tName = this.strip(tokens[0]);
            if (this.isValidTableName(tName)) {
              if (!tableNames.includes(tName)) tableNames.push(tName);
              this.ensureTable(map, tName);
            }
          }
        });
      }

      const joinRegex = /\bJOIN\s+([^\s,(]+)/gi;
      let jm;
      while ((jm = joinRegex.exec(stmt))) {
        const tName = this.strip(jm[1]);
        if (this.isValidTableName(tName)) {
          if (!tableNames.includes(tName)) tableNames.push(tName);
          this.ensureTable(map, tName);
        }
      }

      for (let i = 0; i < tableNames.length - 1; i++) {
        rels.push({
          fromTable: tableNames[i], toTable: tableNames[i + 1],
          fromColumn: null, toColumn: null, via: "JOIN"
        });
      }

      return tableNames;
    }

    static parseInsertTargets(stmt, map, rels) {
      const targets = [];
      const isInsertAll = /\bINSERT\s+ALL\b/i.test(stmt);

      if (isInsertAll) {
        const intoRegex = /\bINTO\s+([^\s(,]+)\s*(?:\(([^)]*)\))?(?:\s*VALUES\s*\(([^)]*)\))?/gi;
        let im;
        while ((im = intoRegex.exec(stmt))) {
          const tName = this.strip(im[1]);
          if (!this.isValidTableName(tName)) continue;
          const table = this.ensureTable(map, tName, "INSERT_TARGET");
          if (table && !table.columns.length) {
            const colStr = im[2] || im[3] || "";
            const cols = colStr.split(",").map(c => this.strip(c.trim())).filter(c => c && this.isValidTableName(c));
            if (cols.length) {
              table.columns = cols.map(c => ({ name: c, isPrimary: false, type: "", nullable: true }));
            }
          }
          if (!targets.includes(tName)) targets.push(tName);
        }

        const selectFromTables = this.parseFromTables(stmt, map, []);

        targets.forEach(t => {
          selectFromTables.forEach(s => {
            rels.push({ fromTable: s, toTable: t, fromColumn: null, toColumn: null, via: "INSERT" });
          });
        });
      } else {
        const intoMatch = stmt.match(/\bINTO\s+([^\s(]+)/i);
        if (intoMatch) {
          const tName = this.strip(intoMatch[1]);
          if (this.isValidTableName(tName)) {
            this.ensureTable(map, tName, "INSERT_TARGET");
            targets.push(tName);
          }
        }
      }

      return targets;
    }

    static parseSubqueryAliases(stmt, map) {
      const subqueryRegex = /\(\s*SELECT\b[^)]*\)\s+([A-Z_][A-Z0-9_]*)/gi;
      let sm;
      while ((sm = subqueryRegex.exec(stmt))) {
        const alias = this.strip(sm[1]);
        if (this.isValidTableName(alias)) {
          this.ensureTable(map, alias, "SUBQUERY");
        }
      }
    }

    static enrichTablesFromSelect(stmt, map) {
      const tableAliasMap = {};

      const fromMatches = [...stmt.matchAll(/\bFROM\s+([\s\S]*?)(?=\bWHERE\b|\bGROUP\b|\bHAVING\b|\bORDER\b|\bLIMIT\b|\bUNION\b|\)|$)/gi)];
      fromMatches.forEach(fm => {
        let fromPart = fm[1].replace(/\bJOIN\b[\s\S]*/i, "").trim();
        fromPart.split(",").forEach(p => {
          const tokens = p.trim().split(/\s+/);
          if (tokens.length >= 2) {
            const tName = this.strip(tokens[0]);
            const alias = this.strip(tokens[tokens.length - 1]);
            if (this.isValidTableName(tName) && alias && /^[A-Za-z_]\w*$/.test(alias)) {
              tableAliasMap[alias.toUpperCase()] = tName;
            }
          } else if (tokens.length === 1) {
            const tName = this.strip(tokens[0]);
            if (this.isValidTableName(tName)) {
              tableAliasMap[tName.toUpperCase()] = tName;
            }
          }
        });
      });

      const selectMatches = [...stmt.matchAll(/\bSELECT\b\s+([\s\S]*?)\bFROM\b/gi)];
      selectMatches.forEach(sm => {
        const selectPart = sm[1];
        const exprs = [];
        let depth = 0, buf = "";
        for (let i = 0; i < selectPart.length; i++) {
          const ch = selectPart[i];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          else if (ch === "," && depth === 0) {
            exprs.push(buf.trim());
            buf = "";
            continue;
          }
          buf += ch;
        }
        if (buf.trim()) exprs.push(buf.trim());

        exprs.forEach(expr => {
          const dotMatches = [...expr.matchAll(/([A-Z_]\w*)\.([A-Z_]\w*)/gi)];
          dotMatches.forEach(dm => {
            const alias = dm[1];
            const colName = dm[2];
            const tableName = tableAliasMap[alias.toUpperCase()];
            if (tableName) {
              const key = tableName.toUpperCase();
              const table = map[key];
              if (table && !table.columns.find(c => c.name.toUpperCase() === colName.toUpperCase())) {
                table.columns.push({ name: colName, isPrimary: false, type: "", nullable: true });
              }
            }
          });
        });

        // For single-table FROM with no alias prefix, attribute bare columns
        const singleTableAliases = Object.entries(tableAliasMap);
        if (singleTableAliases.length === 1) {
          const [, singleTable] = singleTableAliases[0];
          const key = singleTable.toUpperCase();
          const table = map[key];
          if (table) {
            exprs.forEach(expr => {
              const bare = expr.trim();
              const simple = bare.match(/^([A-Z_]\w*)$/i);
              if (simple && this.isValidTableName(simple[1])) {
                const cn = simple[1];
                if (!table.columns.find(c => c.name.toUpperCase() === cn.toUpperCase())) {
                  table.columns.push({ name: cn, isPrimary: false, type: "", nullable: true });
                }
              }
              const funcCol = bare.match(/\b(?:SUM|AVG|COUNT|MIN|MAX)\s*\(\s*([A-Z_]\w*)\s*\)/i);
              if (funcCol && this.isValidTableName(funcCol[1])) {
                const cn = funcCol[1];
                if (!table.columns.find(c => c.name.toUpperCase() === cn.toUpperCase())) {
                  table.columns.push({ name: cn, isPrimary: false, type: "", nullable: true });
                }
              }
            });
          }
        }
      });
    }

    static analyze(sql, dialect) {
      const clean = SQLParser.normalizeWhitespace(sql);
      const statements = SQLParser.splitStatements(clean);
      const map = Object.create(null);
      const rels = [];

      statements.forEach((stmt) => {
        const up = stmt.toUpperCase().trim();

        if (/^CREATE\s+TABLE\b/i.test(up)) {
          this.parseCreateTable(stmt, map, rels);
        } else if (/^CREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i.test(up)) {
          const viewName = this.parseCreateView(stmt, map);
          const fromTables = this.parseFromTables(stmt, map, rels);
          this.enrichTablesFromSelect(stmt, map);
          if (viewName && fromTables.length) {
            fromTables.forEach(t => {
              rels.push({ fromTable: t, toTable: viewName, fromColumn: null, toColumn: null, via: "VIEW" });
            });
          }
        } else if (/^INSERT\b/i.test(up)) {
          this.parseInsertTargets(stmt, map, rels);
          this.parseFromTables(stmt, map, rels);
          this.enrichTablesFromSelect(stmt, map);
        } else if (/\bFROM\b/i.test(stmt) || /\bJOIN\b/i.test(stmt)) {
          this.parseFromTables(stmt, map, rels);
          this.enrichTablesFromSelect(stmt, map);
        }
      });

      return { tables: Object.values(map), relationships: rels };
    }
  }

  global.SqlStructure = {
    analyzeSql: (sql, dialect) => new SQLParser().analyze(sql, dialect),
    formatSqlBasic: (sql, dialect) => SQLFormatter.format(sql, dialect),
    analyzeSchema: (sql, dialect) => SchemaAnalyzer.analyze(sql, dialect),
  };
})(window);

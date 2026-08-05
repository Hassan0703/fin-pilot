/**
 * FinPilot v0 — Formatting Service.
 *
 * Applies premium-SaaS styling, data validation dropdowns (sourced from the
 * lookups table), conditional formatting, frozen headers and protected ranges.
 * Runs at bootstrap and can be re-applied from the menu.
 */

var FormattingService = {
  applyAll: function () {
    FormattingService.styleTables();
    FormattingService.applyDerivedFormulas();
    FormattingService.protectTables();
    FormattingService.conditionalRules();
    FormattingService.dataValidation();
  },

  /**
   * Derived columns are FORMULAS over the ledger — never hand-entered:
   *   accounts.current_balance     (opening + ledger movements)
   *   goals.current_amount         (linked account balance - opening)
   *   goals.projected_completion   (target/current vs monthly contribution)
   */
  /** Single-row current_balance formula for an account row. */
  accountFormula: function (r) {
    return '=IF(ISNUMBER($E' + r + '),' +
      '$E' + r +
      '+SUMPRODUCT((transactions!$P$2:$P="POSTED")*((transactions!$G$2:$G=$A' + r + ')*(transactions!$D$2:$D="INCOME")+(transactions!$I$2:$I=$A' + r + ')*(transactions!$D$2:$D="TRANSFER"))*transactions!$E$2:$E)' +
      '-SUMPRODUCT((transactions!$P$2:$P="POSTED")*((transactions!$G$2:$G=$A' + r + ')*(transactions!$D$2:$D="EXPENSE")+(transactions!$H$2:$H=$A' + r + ')*(transactions!$D$2:$D="TRANSFER"))*transactions!$E$2:$E),"")';
  },

  /** Single-row current_amount formula for a goal row. */
  goalCurrentFormula: function (g) {
    return '=IF($F' + g + '="","",IFERROR(VLOOKUP($F' + g + ',{accounts!$A$2:$A,accounts!$F$2:$F},2,FALSE),0)-IFERROR(VLOOKUP($F' + g + ',{accounts!$A$2:$A,accounts!$E$2:$E},2,FALSE),0))';
  },

  /** Single-row projected_completion formula for a goal row. */
  goalProjectionFormula: function (g) {
    return '=IF(OR($D' + g + '<=0,$J' + g + '<=0),"",IF($G' + g + '>=$D' + g + ',TODAY(),EDATE(TODAY(),CEILING(($D' + g + '-$G' + g + ')/$J' + g + '))))';
  },

  /** Applies the current_balance formula to one account row (post-create). */
  applyAccountFormula: function (row) {
    try {
      tableSheet("accounts").getRange("F" + row).setFormula(FormattingService.accountFormula(row));
    } catch (e) { Logger.log("account formula: " + e.message); }
  },

  /** Applies the goal derived formulas to one goal row (post-create). */
  applyGoalFormulas: function (row) {
    try {
      var goal = tableSheet("goals");
      goal.getRange("G" + row).setFormula(FormattingService.goalCurrentFormula(row));
      goal.getRange("K" + row).setFormula(FormattingService.goalProjectionFormula(row));
    } catch (e) { Logger.log("goal formula: " + e.message); }
  },

  applyDerivedFormulas: function () {
    try {
      var acc = tableSheet("accounts");
      var n = acc.getLastRow();
      if (n >= 2) {
        var formulas = [];
        for (var r = 2; r <= n; r++) formulas.push(FormattingService.accountFormula(r));
        acc.getRange("F2:F" + n).setFormulas(formulas.map(function (f) { return [f]; }));
      }

      var goal = tableSheet("goals");
      var gn = goal.getLastRow();
      if (gn >= 2) {
        var gCur = [];
        var gProj = [];
        for (var g = 2; g <= gn; g++) {
          gCur.push([FormattingService.goalCurrentFormula(g)]);
          gProj.push([FormattingService.goalProjectionFormula(g)]);
        }
        goal.getRange("G2:G" + gn).setFormulas(gCur);
        goal.getRange("K2:K" + gn).setFormulas(gProj);
      }
    } catch (e) { Logger.log("derived formulas: " + e.message); }
  },

  /** Header styling + freeze for every table sheet. */
  styleTables: function () {
    Object.keys(TABLES).forEach(function (name) {
      var def = TABLES[name];
      var sheet = tableSheet(name);
      var n = def.cols.length;
      var header = sheet.getRange(1, 1, 1, n);
      header.setFontWeight("bold")
        .setFontColor("#FFFFFF")
        .setBackground("#2A2A33")
        .setFontSize(10);
      sheet.setFrozenRows(1);
      sheet.setRowHeight(1, 30);
      sheet.setColumnWidth(1, 160);
    });
    FormattingService.setTabColors();
  },

  setTabColors: function () {
    var map = {
      dashboard: "4285F4",
      transactions: "EA4335",
      accounts: "34A853",
      categories: "FBBC04",
      income_sources: "16A085",
      budgets: "9C27B0",
      goals: "FF6D00",
      recurring: "00ACC1",
      monthly_analytics: "5F6368",
      financial_score: "8E24AA",
      roadmap: "C2185B",
      settings: "546E7A",
      audit_logs: "37474F",
      lookups: "455A64",
      validation_rules: "455A64"
    };
    var ss = openDb();
    Object.keys(map).forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (sheet) sheet.setTabColor(map[name]);
    });
  },

  /** Protect table sheets so humans can't corrupt the database. */
  protectTables: function () {
    // Only the dashboard is hand-editable; every data table is script-managed.
    var editable = ["dashboard"];
    Object.keys(TABLES).forEach(function (name) {
      if (editable.indexOf(name) >= 0) return;
      try {
        var sheet = tableSheet(name);
        var prot = sheet.protect();
        prot.setDescription("FinPilot table — managed by the backend.");
        prot.setWarningOnly(true);
      } catch (e) { Logger.log("protect " + name + ": " + e.message); }
    });
  },

  /** Data validation dropdowns fed by the lookups table. */
  dataValidation: function () {
    var rules = {
      transactions: [
        { col: 4, group: "transaction_type" },   // type
        { col: 16, group: "status" }              // status
      ],
      accounts: [
        { col: 3, group: "account_type" },
        { col: 4, group: "currency" },
        { col: 9, group: "status" }
      ],
      categories: [
        { col: 4, group: "transaction_type" },
        { col: 9, group: "status" }
      ],
      income_sources: [
        { col: 3, group: "income_source_type" },
        { col: 7, group: "status" }
      ],
      budgets: [{ col: 5, group: "currency" }, { col: 6, group: "status" }],
      goals: [{ col: 3, group: "goal_type" }, { col: 9, group: "priority" }, { col: 12, group: "status" }],
      recurring: [{ col: 3, group: "transaction_type" }, { col: 6, group: "frequency" }, { col: 18, group: "status" }],
      monthly_analytics: [{ col: 3, group: "metric" }],
      financial_score: [{ col: 7, group: "status" }],
      roadmap: [{ col: 6, group: "status" }]
    };
    Object.keys(rules).forEach(function (name) {
      try {
        var sheet = tableSheet(name);
        rules[name].forEach(function (r) {
          var codes = LookupService.codes(r.group);
          var range = sheet.getRange(2, r.col, Math.max(sheet.getLastRow() - 1, 1), 1);
          var rule = SpreadsheetApp.newDataValidation()
            .requireValueInList(codes, true)
            .setAllowInvalid(true)
            .build();
          range.setDataValidation(rule);
        });
      } catch (e) { Logger.log("validation " + name + ": " + e.message); }
    });
  },

  /** Conditional formatting: budget overrun, warnings, score status colors. */
  conditionalRules: function () {
    try {
      var ss = openDb();

      // dashboard warnings cell turns red when it has content
      var dash = ss.getSheetByName("dashboard");
      if (dash) {
        var warnRange = dash.getRange("A32");
        var red = SpreadsheetApp.newConditionalFormatRule()
          .whenCellNotEmpty()
          .setBackground("#FF453A").setFontColor("#FFFFFF")
          .setRanges([warnRange]).build();
        dash.setConditionalFormatRules([red]);
      }

      // financial_score status column
      var score = tableSheet("financial_score");
      if (score && score.getLastRow() > 1) {
        var statusRange = score.getRange(2, 7, Math.max(score.getLastRow() - 1, 1), 1);
        score.setConditionalFormatRules([
          SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("ON_TRACK")
            .setBackground("#34C759").setRanges([statusRange]).build(),
          SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("WARNING")
            .setBackground("#FFD60A").setRanges([statusRange]).build(),
          SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("FAIL")
            .setBackground("#FF453A").setFontColor("#FFFFFF").setRanges([statusRange]).build()
        ]);
      }

      // transactions: type column color-coded
      var tx = tableSheet("transactions");
      if (tx && tx.getLastRow() > 1) {
        var typeRange = tx.getRange(2, 4, Math.max(tx.getLastRow() - 1, 1), 1);
        tx.setConditionalFormatRules([
          SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("INCOME")
            .setFontColor("#34C759").setRanges([typeRange]).build(),
          SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("EXPENSE")
            .setFontColor("#FF453A").setRanges([typeRange]).build(),
          SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("TRANSFER")
            .setFontColor("#4F8CFF").setRanges([typeRange]).build()
        ]);
      }
    } catch (e) { Logger.log("conditional: " + e.message); }
  },

  /** Dashboard looks like a product, not a spreadsheet. */
  styleDashboard: function (sheet) {
    sheet.setRowHeight(1, 34);
    sheet.setRowHeight(2, 22);
    var title = sheet.getRange("A1");
    title.setFontSize(26).setFontWeight("bold").setFontColor("#F5F5F7");
    sheet.getRange("A2").setFontSize(13).setFontColor("#9A9AA5");
    sheet.getRange("C2").setFontSize(10).setFontColor("#9A9AA5");

    ["B5","D5","F5","H5","J5"].forEach(function (addr, i) {
      var label = sheet.getRange(addr);
      label.setFontSize(11).setFontColor("#9A9AA5").setFontWeight("bold");
      var value = sheet.getRange(String.fromCharCode(addr.charCodeAt(0) + 1) + "6");
      value.setFontSize(24).setFontWeight("bold").setFontColor("#F5F5F7");
    });

    // section headers
    ["A10","A16","A22","A31","A34","A42"].forEach(function (addr) {
      sheet.getRange(addr).setFontSize(14).setFontWeight("bold").setFontColor("#4F8CFF");
    });

    sheet.getRange(11, 1, 1, 6).setFontWeight("bold").setBackground("#2A2A33").setFontColor("#FFFFFF");
    sheet.getRange(17, 1, 1, 5).setFontWeight("bold").setBackground("#2A2A33").setFontColor("#FFFFFF");
    sheet.getRange(23, 1, 1, 6).setFontWeight("bold").setBackground("#2A2A33").setFontColor("#FFFFFF");
    sheet.getRange(43, 1, 1, 4).setFontWeight("bold").setBackground("#2A2A33").setFontColor("#FFFFFF");

    sheet.setFrozenRows(3);
    sheet.setColumnWidths(1, 6, 150);
  }
};
